import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import express from "express";
import request from "supertest";
import { and, eq, notInArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  routines,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";
import { heartbeatService, startOwnedCancelledRunSweep, stopLocallyOwnedCancelledRuns } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run-cancel route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

type Actor = Record<string, unknown>;

const LOCAL_BOARD: Actor = {
  type: "board",
  source: "local_implicit",
  userId: "local-board",
  companyIds: [] as string[],
  isInstanceAdmin: false,
};

// Emergency run-level stop: POST /heartbeat-runs/:runId/cancel stops one run
// and kills its worker, but leaves every card the agent holds as it was, and
// does not re-wake the agent on the card it was just stopped on. Contrast with
// POST /agents/:id/pause, which cancels every open card (agents.ts pause).
describeEmbeddedPostgres("a cancel stops the run on the plane that executes it", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-cancel-cross-process-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  const sweeps: Array<ReturnType<typeof setInterval>> = [];
  const originalSweepSwitch = process.env.PAPERCLIP_CROSS_PROCESS_CANCEL_SWEEP;

  afterEach(async () => {
    for (const sweep of sweeps.splice(0)) clearInterval(sweep);
    if (originalSweepSwitch === undefined) delete process.env.PAPERCLIP_CROSS_PROCESS_CANCEL_SWEEP;
    else process.env.PAPERCLIP_CROSS_PROCESS_CANCEL_SWEEP = originalSweepSwitch;
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(activityLog);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(routines);
        await db.delete(agentConfigRevisions);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Actor = LOCAL_BOARD) {
    const routerApp = express();
    routerApp.use(express.json());
    routerApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    routerApp.use("/api", agentRoutes(db));
    routerApp.use(errorHandler);
    return routerApp;
  }

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Run Cancel ${companyId.slice(0, 6)}`,
      issuePrefix: `RC${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Website Evaluator",
      role: "engineer",
      status: "running",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssue(companyId: string, agentId: string, title: string, status: string) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title,
      status,
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    return id;
  }

  async function plantRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status: "queued" | "running";
  }) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "assignment",
      reason: "issue_assigned",
      payload: { issueId: input.issueId },
      status: input.status === "running" ? "claimed" : "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input.status,
      wakeupRequestId,
      contextSnapshot: { issueId: input.issueId },
      responsibleUserId: "responsible-user",
      ...(input.status === "running"
        ? { startedAt: new Date(), runtimeMode: "legacy", runtimeModeResolvedAt: new Date() }
        : {}),
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    if (input.status === "running") {
      await db
        .update(issues)
        .set({ executionRunId: runId, executionLockedAt: new Date() })
        .where(eq(issues.id, input.issueId));
    }
    return { runId, wakeupRequestId };
  }

  // A real worker process, registered the way runChildProcess registers the
  // local CLI or the local ssh client for a remote run.
  function attachWorker(runId: string) {
    const child = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    children.push(child);
    runningProcesses.set(runId, { child, graceSec: 1, processGroupId: child.pid ?? null });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    return { child, exited };
  }

  async function issueRow(issueId: string) {
    return db
      .select({ status: issues.status, executionRunId: issues.executionRunId, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
  }

  async function runRow(runId: string) {
    return db
      .select({ status: heartbeatRuns.status, resultJson: heartbeatRuns.resultJson })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  // Any run row other than the planted ones, in any status: a recovery run
  // that was queued and then finished (or failed) still counts as a re-wake.
  async function otherRunsFor(agentId: string, excludedRunIds: string[]) {
    return db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          notInArray(heartbeatRuns.id, excludedRunIds),
        ),
      );
  }

  async function otherWakesFor(agentId: string, excludedWakeIds: string[]) {
    return db
      .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          notInArray(agentWakeupRequests.id, excludedWakeIds),
        ),
      );
  }

  function exitedWithin(exited: Promise<unknown>, ms: number) {
    return Promise.race([
      exited.then(() => "exited" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms)),
    ]);
  }

  // The incident shape (bfac151c, 53c915b6, dfb79083): plane B executes the
  // run, the cancel POST lands on plane A. runningProcesses is per process, so
  // plane A sees no worker. In this single test process the map is shared, so
  // the worker entry is held aside while plane A handles the cancel, exactly as
  // plane A's own map would look, then restored as plane B's view.
  it("a cancel received by plane A stops the worker that plane B executes within 15 s", async () => {
    const { companyId, agentId } = await seed();
    const card = await seedIssue(companyId, agentId, "Card being worked", "in_progress");
    const { runId } = await plantRun({ companyId, agentId, issueId: card, status: "running" });
    const worker = attachWorker(runId);
    const planeBEntry = runningProcesses.get(runId)!;

    runningProcesses.delete(runId);
    const res = await request(app()).post(`/api/heartbeat-runs/${runId}/cancel`).send({});
    runningProcesses.set(runId, planeBEntry);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect((await runRow(runId) as any)?.resultJson?.executionCancellation?.state).toBe("requested");

    sweeps.push(startOwnedCancelledRunSweep(db, 5_000));
    expect(await exitedWithin(worker.exited, 15_000)).toBe("exited");
    for (let i = 0; i < 50 && runningProcesses.has(runId); i += 1) await new Promise((r) => setTimeout(r, 100));
    expect(runningProcesses.has(runId)).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    const cancellation = (await runRow(runId) as any)?.resultJson?.executionCancellation;
    expect(cancellation?.state).toBe("acknowledged");
    expect(cancellation?.proof).toBe("owner_stop");
  }, 30_000);

  // ba42f45a: the row was already cancelled by plane A, then the cancel also
  // reached the owning plane, which returned 200 and stopped nothing.
  it("a second cancel received by the owning plane after the row is already cancelled stops its worker", async () => {
    const { companyId, agentId } = await seed();
    const card = await seedIssue(companyId, agentId, "Card being worked", "in_progress");
    const { runId } = await plantRun({ companyId, agentId, issueId: card, status: "running" });
    const worker = attachWorker(runId);
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date(), errorCode: "cancelled", error: "Cancelled by a board operator" })
      .where(eq(heartbeatRuns.id, runId));

    const res = await request(app()).post(`/api/heartbeat-runs/${runId}/cancel`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await exitedWithin(worker.exited, 10_000)).toBe("exited");
    expect(runningProcesses.has(runId)).toBe(false);
  }, 30_000);

  it("control: the sweep leaves a running run that is not cancelled alone", async () => {
    const { companyId, agentId } = await seed();
    const card = await seedIssue(companyId, agentId, "Card being worked", "in_progress");
    const { runId } = await plantRun({ companyId, agentId, issueId: card, status: "running" });
    const worker = attachWorker(runId);

    sweeps.push(startOwnedCancelledRunSweep(db, 1_000));
    expect(await stopLocallyOwnedCancelledRuns(db)).toEqual([]);
    expect(await exitedWithin(worker.exited, 3_500)).toBe("timeout");
    expect(runningProcesses.has(runId)).toBe(true);
    expect((await runRow(runId))?.status).toBe("running");
  }, 30_000);

  it("control: PAPERCLIP_CROSS_PROCESS_CANCEL_SWEEP=false turns the sweep off", async () => {
    const { companyId, agentId } = await seed();
    const card = await seedIssue(companyId, agentId, "Card being worked", "in_progress");
    const { runId } = await plantRun({ companyId, agentId, issueId: card, status: "running" });
    const worker = attachWorker(runId);
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));

    process.env.PAPERCLIP_CROSS_PROCESS_CANCEL_SWEEP = "false";
    expect(await stopLocallyOwnedCancelledRuns(db)).toEqual([]);
    expect(await exitedWithin(worker.exited, 1_500)).toBe("timeout");
    delete process.env.PAPERCLIP_CROSS_PROCESS_CANCEL_SWEEP;
    expect(await stopLocallyOwnedCancelledRuns(db)).toEqual([runId]);
    expect(await exitedWithin(worker.exited, 10_000)).toBe("exited");
  }, 30_000);
});
