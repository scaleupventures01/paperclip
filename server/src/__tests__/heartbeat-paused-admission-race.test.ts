import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Paused admission race test run.",
    provider: "test",
    model: "test-model",
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

// The race window: enqueueWakeup reads the agent, checks invokability against
// that in-memory row, and only later opens the queueing transaction. A pause
// that commits inside that window must not leave a queued run behind. The hook
// below commits the pause right after the invokability check has passed on the
// stale (active) row, which is exactly that window.
const pauseAfterInvokabilityCheck = vi.hoisted(() => ({
  hook: null as null | ((agentId: string) => Promise<void>),
}));

vi.mock("../services/agent-invokability.js", async () => {
  const actual = await vi.importActual<typeof import("../services/agent-invokability.js")>(
    "../services/agent-invokability.js",
  );
  return {
    ...actual,
    evaluateAgentInvokabilityFromDb: async (
      ...args: Parameters<typeof actual.evaluateAgentInvokabilityFromDb>
    ) => {
      const result = await actual.evaluateAgentInvokabilityFromDb(...args);
      const agent = args[1];
      const hook = pauseAfterInvokabilityCheck.hook;
      if (hook && agent) {
        pauseAfterInvokabilityCheck.hook = null;
        await hook(agent.id);
      }
      return result;
    },
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres paused admission race tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("enqueueWakeup paused admission race (agentos#596)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-paused-admission-race-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    pauseAfterInvokabilityCheck.hook = null;
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
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
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paused Admission",
      issuePrefix: `PA${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Website Evaluator",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Evaluate a prospect website",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    return { companyId, agentId, issueId };
  }

  function armPauseInWindow() {
    pauseAfterInvokabilityCheck.hook = async (agentId) => {
      await db
        .update(agents)
        .set({ status: "paused", pausedAt: new Date(), updatedAt: new Date() })
        .where(eq(agents.id, agentId));
    };
  }

  async function runsFor(agentId: string) {
    return db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
  }

  async function wakesFor(agentId: string) {
    return db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
  }

  function assignmentWake(issueId: string) {
    return {
      source: "assignment" as const,
      triggerDetail: "system" as const,
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId },
      requestedByActorType: "system" as const,
      requestedByActorId: "issue_assignment",
    };
  }

  function unscopedWake() {
    return {
      source: "on_demand" as const,
      triggerDetail: "system" as const,
      reason: "manager_ping",
      requestedByActorType: "system" as const,
      requestedByActorId: "test",
    };
  }

  it("issue path: a pause landing after the invokability check leaves no queued run", async () => {
    const { agentId, issueId } = await seed();
    armPauseInWindow();

    const run = await heartbeat.wakeup(agentId, assignmentWake(issueId));

    expect(pauseAfterInvokabilityCheck.hook).toBeNull();
    expect(run).toBeNull();
    expect(await runsFor(agentId)).toEqual([]);
    expect(await wakesFor(agentId)).toEqual([{ status: "skipped", reason: "agent.not_invokable" }]);
  });

  it("issue path control: an active agent gets exactly one queued run", async () => {
    const { agentId, issueId } = await seed();

    const run = await heartbeat.wakeup(agentId, assignmentWake(issueId));

    expect(run?.status).toBe("queued");
    const runs = await runsFor(agentId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(run!.id);
  });

  it("non-issue path: a pause landing after the invokability check leaves no queued run", async () => {
    const { agentId } = await seed();
    armPauseInWindow();

    const run = await heartbeat.wakeup(agentId, unscopedWake());

    expect(pauseAfterInvokabilityCheck.hook).toBeNull();
    expect(run).toBeNull();
    expect(await runsFor(agentId)).toEqual([]);
    expect(await wakesFor(agentId)).toEqual([{ status: "skipped", reason: "agent.not_invokable" }]);
  });

  it("non-issue path control: an active agent gets exactly one queued run", async () => {
    const { agentId } = await seed();

    const run = await heartbeat.wakeup(agentId, unscopedWake());

    expect(run?.status).toBe("queued");
    const runs = await runsFor(agentId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(run!.id);
  });
});
