import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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

const adapterHooks = vi.hoisted(() => ({
  beforeReturn: null as null | (() => void),
}));

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => {
    adapterHooks.beforeReturn?.();
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Fleet gate retry test run.",
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
    `Skipping embedded Postgres fleet gate retry tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const originalGateEnv = process.env.AGENTOS_FLEET_RELEASE_GATE;

// agentos#596 follow-up D gap analysis: scheduleBoundedRetryForRun and
// enqueueMissingIssueCommentRetry insert heartbeat runs without going through
// enqueueWakeup, so each must honor the fleet release gate itself.
describeEmbeddedPostgres("automatic retries honor the fleet release gate", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const gateDir = mkdtempSync(path.join(tmpdir(), "retry-fleet-gate-"));
  const gatePath = path.join(gateDir, "fleet-release-gate.json");

  beforeAll(async () => {
    process.env.AGENTOS_FLEET_RELEASE_GATE = gatePath;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-retry-fleet-gate-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    adapterHooks.beforeReturn = null;
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
    await tempDb?.cleanup();
    rmSync(gateDir, { recursive: true, force: true });
    if (originalGateEnv === undefined) delete process.env.AGENTOS_FLEET_RELEASE_GATE;
    else process.env.AGENTOS_FLEET_RELEASE_GATE = originalGateEnv;
  });

  function writeGate(allowedAgentIds: string[]) {
    writeFileSync(gatePath, JSON.stringify({ version: 1, enabled: true, allowedAgentIds }));
  }

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Retry Gate",
      issuePrefix: `RG${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Retry Worker",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedFailedRun(companyId: string, agentId: string, now: Date) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      scheduledRetryAttempt: 0,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      updatedAt: now,
      createdAt: now,
    });
    return runId;
  }

  describe("scheduleBoundedRetryForRun", () => {
    it("does not schedule a retry for an agent outside the allowlist", async () => {
      const { companyId, agentId } = await seedAgent();
      const now = new Date("2026-10-13T18:00:00.000Z");
      const runId = await seedFailedRun(companyId, agentId, now);
      writeGate([]);

      const outcome = await heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0 });

      expect(outcome).toMatchObject({ outcome: "not_scheduled" });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toEqual([]);
    });

    it("control: schedules the retry for an allowlisted agent", async () => {
      const { companyId, agentId } = await seedAgent();
      const now = new Date("2026-10-13T18:00:00.000Z");
      const runId = await seedFailedRun(companyId, agentId, now);
      writeGate([agentId]);

      const outcome = await heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0 });

      expect(outcome).toMatchObject({ outcome: "scheduled" });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toHaveLength(1);
    });
  });

  describe("enqueueMissingIssueCommentRetry", () => {
    async function runAssignmentWithoutComment(excludeDuringRun: boolean) {
      const { companyId, agentId } = await seedAgent();
      const issueId = randomUUID();
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Needs a comment",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      });
      writeGate([agentId]);
      if (excludeDuringRun) adapterHooks.beforeReturn = () => writeGate([]);

      const run = await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId },
        contextSnapshot: { issueId },
        requestedByActorType: "system",
        requestedByActorId: "issue_assignment",
      });
      expect(run?.status).toBe("queued");
      await drainHeartbeatRunsToQuiescence(db, heartbeat);

      return db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.reason, "missing_issue_comment"),
        ));
    }

    it("does not queue a missing-comment retry once the agent leaves the allowlist", async () => {
      expect(await runAssignmentWithoutComment(true)).toEqual([]);
    });

    it("control: queues exactly one missing-comment retry for an allowlisted agent", async () => {
      expect(await runAssignmentWithoutComment(false)).toHaveLength(1);
    });
  });
});
