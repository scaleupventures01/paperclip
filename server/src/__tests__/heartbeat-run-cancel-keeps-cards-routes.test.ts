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
import { heartbeatService } from "../services/heartbeat.ts";
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
describeEmbeddedPostgres("POST /heartbeat-runs/:runId/cancel keeps the agent's cards", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-cancel-keeps-cards-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
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

  it("cancels a running run, kills its worker, and leaves every card and the lock state as expected", async () => {
    const { companyId, agentId } = await seed();
    const working = await seedIssue(companyId, agentId, "Card being worked", "in_progress");
    const otherInProgress = await seedIssue(companyId, agentId, "Other card in progress", "in_progress");
    const otherTodo = await seedIssue(companyId, agentId, "Other card todo", "todo");
    const { runId, wakeupRequestId } = await plantRun({ companyId, agentId, issueId: working, status: "running" });
    const worker = attachWorker(runId);

    const res = await request(app()).post(`/api/heartbeat-runs/${runId}/cancel`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe("cancelled");

    const exit = await Promise.race([
      worker.exited,
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 10_000)),
    ]);
    expect(exit).not.toBe("timeout");
    expect(runningProcesses.has(runId)).toBe(false);

    const run = await runRow(runId);
    expect(run?.status).toBe("cancelled");
    expect((run?.resultJson as Record<string, unknown>)?.cancelledByActorType).toBe("user");
    const wake = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wake?.status).toBe("cancelled");

    // The card stays exactly as it was, minus the execution lock.
    expect(await issueRow(working)).toEqual({ status: "in_progress", executionRunId: null, assigneeAgentId: agentId });
    expect(await issueRow(otherInProgress)).toEqual({ status: "in_progress", executionRunId: null, assigneeAgentId: agentId });
    expect(await issueRow(otherTodo)).toEqual({ status: "todo", executionRunId: null, assigneeAgentId: agentId });

    // A stop is a stop: no recovery run or wake re-wakes the agent on the card.
    expect(await otherRunsFor(agentId, [runId])).toEqual([]);
    expect(await otherWakesFor(agentId, [wakeupRequestId])).toEqual([]);

    const events = await db
      .select({ eventType: heartbeatRunEvents.eventType, message: heartbeatRunEvents.message })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, runId));
    expect(events).toContainEqual({ eventType: "lifecycle", message: "run cancelled" });
    const activity = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId })
      .from(activityLog)
      .where(eq(activityLog.action, "heartbeat.cancelled"));
    expect(activity).toEqual([{ action: "heartbeat.cancelled", entityId: runId }]);
  });

  it("cancels a queued run and leaves its todo card alone without queueing a recovery run", async () => {
    const { companyId, agentId } = await seed();
    const card = await seedIssue(companyId, agentId, "Queued card", "todo");
    const other = await seedIssue(companyId, agentId, "Other card", "in_progress");
    const { runId, wakeupRequestId } = await plantRun({ companyId, agentId, issueId: card, status: "queued" });

    const res = await request(app()).post(`/api/heartbeat-runs/${runId}/cancel`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await runRow(runId))?.status).toBe("cancelled");
    expect((await issueRow(card))?.status).toBe("todo");
    expect((await issueRow(other))?.status).toBe("in_progress");
    expect(await otherRunsFor(agentId, [runId])).toEqual([]);
    expect(await otherWakesFor(agentId, [wakeupRequestId])).toEqual([]);
  });

  it("cancels a running run whose worker is not tracked here (for example after a restart) without re-waking the agent", async () => {
    const { companyId, agentId } = await seed();
    const card = await seedIssue(companyId, agentId, "Card being worked", "in_progress");
    const { runId, wakeupRequestId } = await plantRun({ companyId, agentId, issueId: card, status: "running" });

    const res = await request(app()).post(`/api/heartbeat-runs/${runId}/cancel`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await runRow(runId))?.status).toBe("cancelled");
    expect(await issueRow(card)).toEqual({ status: "in_progress", executionRunId: null, assigneeAgentId: agentId });
    expect(await otherRunsFor(agentId, [runId])).toEqual([]);
    expect(await otherWakesFor(agentId, [wakeupRequestId])).toEqual([]);
  });

  it("refuses an agent actor and a viewer board member, and touches nothing", async () => {
    const { companyId, agentId } = await seed();
    const card = await seedIssue(companyId, agentId, "Card", "in_progress");
    const { runId } = await plantRun({ companyId, agentId, issueId: card, status: "queued" });

    const asAgent = await request(app({ type: "agent", agentId, companyId, source: "agent_key" }))
      .post(`/api/heartbeat-runs/${runId}/cancel`)
      .send({});
    expect(asAgent.status).toBe(403);

    const asViewer = await request(app({
      type: "board",
      source: "session",
      userId: "viewer-user",
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "viewer" }],
      isInstanceAdmin: false,
    }))
      .post(`/api/heartbeat-runs/${runId}/cancel`)
      .send({});
    expect(asViewer.status).toBe(403);

    expect((await runRow(runId))?.status).toBe("queued");
    expect((await issueRow(card))?.status).toBe("in_progress");
  });

  it("returns 404 for an unknown run", async () => {
    await seed();
    const res = await request(app()).post(`/api/heartbeat-runs/${randomUUID()}/cancel`).send({});
    expect(res.status).toBe(404);
  });

  // Control: documents the difference. Pause cancels every open card.
  it("control: POST /agents/:id/pause still cancels every open card the agent holds", async () => {
    const { companyId, agentId } = await seed();
    const working = await seedIssue(companyId, agentId, "Card being worked", "in_progress");
    const otherTodo = await seedIssue(companyId, agentId, "Other card todo", "todo");
    await plantRun({ companyId, agentId, issueId: working, status: "queued" });

    const res = await request(app()).post(`/api/agents/${agentId}/pause`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await issueRow(working))?.status).toBe("cancelled");
    expect((await issueRow(otherTodo))?.status).toBe("cancelled");
  });
});
