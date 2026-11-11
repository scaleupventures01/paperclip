import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  issueComments,
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

// agentos#2104 (C36 block B1): every path that ends a heartbeat run records
// which model the run was for. A run the adapter reported usage for keeps the
// adapter's usageJson. A run that ends with no adapter usage (cancelled while
// queued, cancelled while started, finished with nothing reported) records the
// agent's configured model with usageSource "configured". The company run
// list also accepts `since` so a reader can page a window of recent runs.

const adapterResponse = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Run model recorded test run.",
    ...adapterResponse.value,
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres run model recorded tests on this host: ${
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

const CONFIGURED_MODEL = "configured-model-2104";
const originalGateEnv = process.env.AGENTOS_FLEET_RELEASE_GATE;

describeEmbeddedPostgres("agentos#2104 heartbeat runs record their model", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    delete process.env.AGENTOS_FLEET_RELEASE_GATE;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-run-model-recorded-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  beforeEach(() => {
    mockAdapterExecute.mockClear();
    adapterResponse.value = {};
  });

  afterEach(async () => {
    const now = new Date();
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: now, updatedAt: now })
      .where(inArray(heartbeatRuns.status, ["queued", "running"]));
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(activityLog);
        await db.delete(issueComments);
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
    if (originalGateEnv === undefined) delete process.env.AGENTOS_FLEET_RELEASE_GATE;
    else process.env.AGENTOS_FLEET_RELEASE_GATE = originalGateEnv;
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

  async function seed(adapterConfig: Record<string, unknown> = { model: CONFIGURED_MODEL }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Run Model ${companyId.slice(0, 6)}`,
      issuePrefix: `RM${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Model Recorder",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig,
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedIssue(companyId: string, agentId: string) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Card being worked",
      status: "in_progress",
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
    usageJson?: Record<string, unknown>;
  }) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: input.issueId },
      status: input.status === "running" ? "claimed" : "queued",
      requestedByActorType: "system",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input.status,
      wakeupRequestId,
      contextSnapshot: {
        issueId: input.issueId,
        taskId: input.issueId,
        wakeReason: "issue_assigned",
        skipIssueComment: true,
      },
      responsibleUserId: "responsible-user",
      ...(input.usageJson ? { usageJson: input.usageJson } : {}),
      ...(input.status === "running"
        ? { startedAt: new Date(), runtimeMode: "legacy", runtimeModeResolvedAt: new Date() }
        : {}),
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));
    await db
      .update(issues)
      .set({ executionRunId: runId, executionAgentNameKey: "model recorder", executionLockedAt: new Date() })
      .where(eq(issues.id, input.issueId));
    return runId;
  }

  async function runRow(runId: string) {
    return db
      .select({ status: heartbeatRuns.status, usageJson: heartbeatRuns.usageJson })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function waitForTerminal(runId: string) {
    for (let i = 0; i < 200; i += 1) {
      const row = await runRow(runId);
      if (row && row.status !== "queued" && row.status !== "running") return row;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return runRow(runId);
  }

  it("(a) cancelling a QUEUED run records the agent's configured model", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await seedIssue(companyId, agentId);
    const runId = await plantRun({ companyId, agentId, issueId, status: "queued" });

    const res = await request(app()).post(`/api/heartbeat-runs/${runId}/cancel`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await runRow(runId);
    expect(row?.status).toBe("cancelled");
    expect(row?.usageJson).toMatchObject({ model: CONFIGURED_MODEL, usageSource: "configured" });
  }, 30_000);

  it("(b) cancelling a STARTED run with no adapter result records the agent's configured model", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await seedIssue(companyId, agentId);
    const runId = await plantRun({ companyId, agentId, issueId, status: "running" });

    const res = await request(app()).post(`/api/heartbeat-runs/${runId}/cancel`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await runRow(runId);
    expect(row?.status).toBe("cancelled");
    expect(row?.usageJson).toMatchObject({ model: CONFIGURED_MODEL, usageSource: "configured" });
  }, 30_000);

  it("(b2) an agent with no configured model records model unknown", async () => {
    const { companyId, agentId } = await seed({});
    const issueId = await seedIssue(companyId, agentId);
    const runId = await plantRun({ companyId, agentId, issueId, status: "queued" });

    const res = await request(app()).post(`/api/heartbeat-runs/${runId}/cancel`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await runRow(runId);
    expect(row?.status).toBe("cancelled");
    expect(row?.usageJson).toMatchObject({ model: "unknown", usageSource: "configured" });
  }, 30_000);

  it("(b3) control: a cancelled run whose usageJson already has a model keeps it", async () => {
    const { companyId, agentId } = await seed();
    const issueId = await seedIssue(companyId, agentId);
    const existing = { model: "measured-earlier", usageSource: "per_run", inputTokens: 7 };
    const runId = await plantRun({ companyId, agentId, issueId, status: "running", usageJson: existing });

    const res = await request(app()).post(`/api/heartbeat-runs/${runId}/cancel`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const row = await runRow(runId);
    expect(row?.status).toBe("cancelled");
    expect(row?.usageJson).toEqual(existing);
  }, 30_000);

  it("(c) control: a run that finishes WITH adapter usage keeps the adapter's usageJson", async () => {
    adapterResponse.value = {
      provider: "test-provider",
      model: "adapter-measured-model",
      usage: { inputTokens: 1200, cachedInputTokens: 0, outputTokens: 300 },
      usageBasis: "per_run",
      costUsd: 0.25,
    };
    const { companyId, agentId } = await seed();
    const issueId = await seedIssue(companyId, agentId);
    const runId = await plantRun({ companyId, agentId, issueId, status: "queued" });

    await heartbeat.resumeQueuedRuns();
    const row = await waitForTerminal(runId);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    expect(mockAdapterExecute).toHaveBeenCalled();
    expect(row?.status).toBe("succeeded");
    expect(row?.usageJson).toMatchObject({
      model: "adapter-measured-model",
      provider: "test-provider",
      usageSource: "per_run",
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: 0.25,
    });
    expect((row?.usageJson as Record<string, unknown>).usageSource).not.toBe("configured");
  }, 30_000);

  it("(c2) a run that finishes with NO adapter usage records the agent's configured model", async () => {
    adapterResponse.value = {};
    const { companyId, agentId } = await seed();
    const issueId = await seedIssue(companyId, agentId);
    const runId = await plantRun({ companyId, agentId, issueId, status: "queued" });

    await heartbeat.resumeQueuedRuns();
    const row = await waitForTerminal(runId);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    expect(mockAdapterExecute).toHaveBeenCalled();
    expect(row?.status).toBe("succeeded");
    expect(row?.usageJson).toMatchObject({ model: CONFIGURED_MODEL, usageSource: "configured" });
  }, 30_000);

  async function plantHistory(companyId: string, agentId: string) {
    const stamps = [
      "2026-11-01T10:00:00.000Z",
      "2026-11-05T00:00:00.000Z",
      "2026-11-09T12:00:00.000Z",
    ];
    const ids: string[] = [];
    for (const stamp of stamps) {
      const id = randomUUID();
      ids.push(id);
      await db.insert(heartbeatRuns).values({
        id,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "succeeded",
        createdAt: new Date(stamp),
        updatedAt: new Date(stamp),
        finishedAt: new Date(stamp),
      });
    }
    return { oldest: ids[0]!, boundary: ids[1]!, newest: ids[2]! };
  }

  it("(d) since excludes rows created before it and keeps rows at or after it, newest first", async () => {
    const { companyId, agentId } = await seed();
    const { boundary, newest } = await plantHistory(companyId, agentId);

    const res = await request(app())
      .get(`/api/companies/${companyId}/heartbeat-runs`)
      .query({ since: "2026-11-05T00:00:00.000Z" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((run: { id: string }) => run.id)).toEqual([newest, boundary]);

    const capped = await request(app())
      .get(`/api/companies/${companyId}/heartbeat-runs`)
      .query({ since: "2026-11-05T00:00:00.000Z", limit: "1" });
    expect(capped.status, JSON.stringify(capped.body)).toBe(200);
    expect(capped.body.map((run: { id: string }) => run.id)).toEqual([newest]);
  }, 30_000);

  it("(d2) an unparseable since is refused with 400", async () => {
    const { companyId } = await seed();
    const res = await request(app())
      .get(`/api/companies/${companyId}/heartbeat-runs`)
      .query({ since: "not-a-date" });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
  }, 30_000);

  it("(e) control: without since the route returns every row, including old ones, newest first", async () => {
    const { companyId, agentId } = await seed();
    const { oldest, boundary, newest } = await plantHistory(companyId, agentId);

    const res = await request(app()).get(`/api/companies/${companyId}/heartbeat-runs`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.map((run: { id: string }) => run.id)).toEqual([newest, boundary, oldest]);

    const summary = await request(app())
      .get(`/api/companies/${companyId}/heartbeat-runs`)
      .query({ summary: "true", limit: "2" });
    expect(summary.status, JSON.stringify(summary.body)).toBe(200);
    expect(summary.body.map((run: { id: string }) => run.id)).toEqual([newest, boundary]);
  }, 30_000);
});
