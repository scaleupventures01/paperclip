import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
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
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

// agentos#732: QA agents run several cards at once, each testing its own code.
// The scheduler holds one running job per pod repo per agent (heartbeat.ts,
// startNextQueuedRunForAgent, "TASK REPO BINDING:" podKey + busyPods). An agent
// whose runtime_config.heartbeat.parallelRunsPerRepo is true opts out of that
// hold, still capped by maxConcurrentRuns and still one running run per card.
// Every agent without the key (Developers) keeps today's hold exactly.

// The adapter blocks until the test releases it, so a claimed run stays
// "running" and cannot finish and re-enter the claim loop mid-assertion.
const adapterGate = vi.hoisted(() => ({
  waiters: [] as Array<() => void>,
  released: false,
}));

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => {
    if (!adapterGate.released) {
      await new Promise<void>((resolve) => adapterGate.waiters.push(resolve));
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Parallel runs per repo test run.",
      provider: "test",
      model: "test-model",
    };
  }),
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
    `Skipping embedded Postgres parallel-runs-per-repo tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const REPO_BINDING = "TASK REPO BINDING: scaleupventures01/scaleup-marketing";
const originalGateEnv = process.env.AGENTOS_FLEET_RELEASE_GATE;

function releaseAdapter() {
  adapterGate.released = true;
  const waiters = adapterGate.waiters.splice(0);
  for (const resolve of waiters) resolve();
}

describeEmbeddedPostgres("agentos#732 parallel runs per repo (heartbeat.parallelRunsPerRepo)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    delete process.env.AGENTOS_FLEET_RELEASE_GATE;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-parallel-runs-per-repo-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  beforeEach(() => {
    mockAdapterExecute.mockClear();
    adapterGate.released = false;
    adapterGate.waiters.length = 0;
  });

  afterEach(async () => {
    // Stop the claim loop from picking up leftovers once runs are released:
    // cancel every queued and planted running row first, then let in-flight
    // executions finish.
    const now = new Date();
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: now, updatedAt: now })
      .where(inArray(heartbeatRuns.status, ["queued", "running"]));
    releaseAdapter();
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
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
    releaseAdapter();
    await tempDb?.cleanup();
    if (originalGateEnv === undefined) delete process.env.AGENTOS_FLEET_RELEASE_GATE;
    else process.env.AGENTOS_FLEET_RELEASE_GATE = originalGateEnv;
  });

  async function seedAgent(heartbeatConfig: Record<string, unknown>) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Parallel QA",
      issuePrefix: `PQ${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Pod QA",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, ...heartbeatConfig } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function insertCard(companyId: string, agentId: string, title: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title,
      description: `QA this card.\n\n${REPO_BINDING}\n`,
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    return issueId;
  }

  // A run already executing on the card: what the hold keys on.
  async function insertRunningRun(companyId: string, agentId: string, issueId: string) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      startedAt: new Date(),
      responsibleUserId: "responsible-user",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned", skipIssueComment: true },
    });
    await db.update(issues)
      .set({ executionRunId: runId, executionAgentNameKey: "pod qa", executionLockedAt: new Date() })
      .where(eq(issues.id, issueId));
    return runId;
  }

  // Same rows a promoted wake writes (wake queued + queued run linked to it),
  // as in heartbeat-claim-fleet-gate.test.ts. The issue lock is taken only
  // when the card has no running run yet.
  async function insertQueuedRun(
    companyId: string,
    agentId: string,
    issueId: string,
    options: { takeIssueLock: boolean },
  ) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_promoted",
      payload: { issueId },
      status: "queued",
      requestedByActorType: "system",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      responsibleUserId: "responsible-user",
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned", skipIssueComment: true },
    });
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, wakeupRequestId));
    if (options.takeIssueLock) {
      await db.update(issues)
        .set({ executionRunId: runId, executionAgentNameKey: "pod qa", executionLockedAt: new Date() })
        .where(eq(issues.id, issueId));
    }
    return runId;
  }

  async function readRuns(runIds: string[]) {
    const rows = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, startedAt: heartbeatRuns.startedAt })
      .from(heartbeatRuns)
      .where(inArray(heartbeatRuns.id, runIds));
    const byId = new Map(rows.map((row) => [row.id, row]));
    return runIds.map((id) => byId.get(id) ?? null);
  }

  // Claimed = moved off queued by claimQueuedRun (status running, startedAt
  // stamped). A cancelled run is not claimed.
  function isClaimed(run: { status: string; startedAt: Date | null } | null) {
    return Boolean(run && run.status !== "queued" && run.status !== "cancelled" && run.startedAt instanceof Date);
  }

  async function runningCountForAgent(agentId: string) {
    const rows = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, "running")));
    return rows.length;
  }

  it("1a: with parallelRunsPerRepo true, queued runs on other cards of the same repo are claimed while one runs", async () => {
    const { companyId, agentId } = await seedAgent({ maxConcurrentRuns: 4, parallelRunsPerRepo: true });
    const cardA = await insertCard(companyId, agentId, "Card A");
    const cardB = await insertCard(companyId, agentId, "Card B");
    const cardC = await insertCard(companyId, agentId, "Card C");
    const runningA = await insertRunningRun(companyId, agentId, cardA);
    const queuedB = await insertQueuedRun(companyId, agentId, cardB, { takeIssueLock: true });
    const queuedC = await insertQueuedRun(companyId, agentId, cardC, { takeIssueLock: true });

    await heartbeat.resumeQueuedRuns();

    const [a, b, c] = await readRuns([runningA, queuedB, queuedC]);
    expect(a?.status).toBe("running");
    expect({ b: b?.status, c: c?.status }).toEqual({ b: "running", c: "running" });
    expect(isClaimed(b)).toBe(true);
    expect(isClaimed(c)).toBe(true);
  }, 30_000);

  it.each([
    ["key absent", {}],
    ["key false", { parallelRunsPerRepo: false }],
  ])("1b: %s keeps today's hold, other same-repo cards stay queued (Developer regression guard)", async (_label, extra) => {
    const { companyId, agentId } = await seedAgent({ maxConcurrentRuns: 4, ...extra });
    const cardA = await insertCard(companyId, agentId, "Card A");
    const cardB = await insertCard(companyId, agentId, "Card B");
    const cardC = await insertCard(companyId, agentId, "Card C");
    const runningA = await insertRunningRun(companyId, agentId, cardA);
    const queuedB = await insertQueuedRun(companyId, agentId, cardB, { takeIssueLock: true });
    const queuedC = await insertQueuedRun(companyId, agentId, cardC, { takeIssueLock: true });

    await heartbeat.resumeQueuedRuns();

    const [a, b, c] = await readRuns([runningA, queuedB, queuedC]);
    expect(a?.status).toBe("running");
    expect({ b: b?.status, c: c?.status }).toEqual({ b: "queued", c: "queued" });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  }, 30_000);

  it("1c: with parallelRunsPerRepo true, queued runs for a card that already has a running run are not claimed", async () => {
    const { companyId, agentId } = await seedAgent({ maxConcurrentRuns: 4, parallelRunsPerRepo: true });
    const cardX = await insertCard(companyId, agentId, "Card X");
    const runningX = await insertRunningRun(companyId, agentId, cardX);
    const queuedX1 = await insertQueuedRun(companyId, agentId, cardX, { takeIssueLock: false });
    const queuedX2 = await insertQueuedRun(companyId, agentId, cardX, { takeIssueLock: false });

    await heartbeat.resumeQueuedRuns();

    const [x, x1, x2] = await readRuns([runningX, queuedX1, queuedX2]);
    expect(x?.status).toBe("running");
    expect(isClaimed(x1)).toBe(false);
    expect(isClaimed(x2)).toBe(false);
    expect(await runningCountForAgent(agentId)).toBe(1);
  }, 30_000);

  it("1c-ii: with parallelRunsPerRepo true, two queued runs for one idle card start at most one", async () => {
    const { companyId, agentId } = await seedAgent({ maxConcurrentRuns: 4, parallelRunsPerRepo: true });
    const cardY = await insertCard(companyId, agentId, "Card Y");
    const queuedY1 = await insertQueuedRun(companyId, agentId, cardY, { takeIssueLock: true });
    const queuedY2 = await insertQueuedRun(companyId, agentId, cardY, { takeIssueLock: false });

    await heartbeat.resumeQueuedRuns();

    const runs = await readRuns([queuedY1, queuedY2]);
    expect(runs.filter(isClaimed)).toHaveLength(1);
    expect(await runningCountForAgent(agentId)).toBe(1);
  }, 30_000);

  it("1d: with parallelRunsPerRepo true, maxConcurrentRuns still caps the claim (2 slots, 1 running, 3 queued -> exactly 1 claimed)", async () => {
    const { companyId, agentId } = await seedAgent({ maxConcurrentRuns: 2, parallelRunsPerRepo: true });
    const cardA = await insertCard(companyId, agentId, "Card A");
    const cardB = await insertCard(companyId, agentId, "Card B");
    const cardC = await insertCard(companyId, agentId, "Card C");
    const cardD = await insertCard(companyId, agentId, "Card D");
    const runningA = await insertRunningRun(companyId, agentId, cardA);
    const queued = [
      await insertQueuedRun(companyId, agentId, cardB, { takeIssueLock: true }),
      await insertQueuedRun(companyId, agentId, cardC, { takeIssueLock: true }),
      await insertQueuedRun(companyId, agentId, cardD, { takeIssueLock: true }),
    ];

    await heartbeat.resumeQueuedRuns();

    const [a] = await readRuns([runningA]);
    expect(a?.status).toBe("running");
    const claimed = (await readRuns(queued)).filter(isClaimed);
    expect(claimed).toHaveLength(1);
    expect(await runningCountForAgent(agentId)).toBe(2);
  }, 30_000);
});
