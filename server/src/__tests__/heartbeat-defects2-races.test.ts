import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { terminalizeLegacyExecution } from "../services/legacy-execution-recovery.ts";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.ts";

// Round-2 Paperclip defects, 2026-10-15 (paperclip-defects2-20261015 report).
// P1 duplicate continuation while a just-claimed run was "running" but not yet
// tracked in memory; P2 two transient retries for one card from two parents;
// P4 a recovery hold re-created and settled every sweep tick.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres defects2 race tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("defects2: duplicate runs and recovery churn", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-defects2-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
      .where(inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.delete(activityLog);
        await db.delete(issueRecoveryActions);
        await db.update(issues).set({ executionRunId: null, checkoutRunId: null });
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(companySkills);
        await db.delete(companies);
        return;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(adapterType = "process") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Internal Website Pod Manager",
      role: "engineer",
      status: "active",
      adapterType,
      adapterConfig: adapterType === "process" ? { command: process.execPath, args: ["-e", "process.exit(0)"] } : {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 2 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedInProgressIssue(companyId: string, agentId: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Deliver the roadmap item",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    return issueId;
  }

  async function runsFor(agentId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
  }

  describe("P1: a wake for a run that was just claimed", () => {
    async function seedClaimedRun(leaseMs: number) {
      const { companyId, agentId } = await seedAgent();
      const issueId = await seedInProgressIssue(companyId, agentId);
      const runId = randomUUID();
      const now = new Date();
      // Exactly what claimQueuedRun writes: status running, startedAt and a
      // 60 s controller lease. executeRun has not added it to memory yet.
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        runtimeMode: "legacy",
        startedAt: now,
        controllerBootId: randomUUID(),
        controllerLeaseExpiresAt: new Date(now.getTime() + leaseMs),
        executionStage: "preparing",
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_children_completed" },
      });
      await db.update(issues).set({ executionRunId: runId, executionLockedAt: now }).where(eq(issues.id, issueId));
      return { companyId, agentId, issueId, runId };
    }

    function continuationWake(agentId: string, issueId: string) {
      // The stranded sweep's productive-continuation enqueue
      // (recovery/service.ts enqueueStrandedIssueRecovery).
      return heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_continuation_needed",
        issueStateGuard: { statuses: ["in_progress"], assigneeAgentId: agentId },
        payload: { issueId },
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_continuation_needed",
          retryReason: "issue_continuation_needed",
          source: "issue.productive_terminal_continuation_recovery",
        },
      });
    }

    it("does not queue a second run while the claimed run's controller lease is live", async () => {
      const seeded = await seedClaimedRun(60_000);

      await continuationWake(seeded.agentId, seeded.issueId);

      const runs = await runsFor(seeded.agentId);
      expect(runs.map((run) => run.id)).toEqual([seeded.runId]);
    }, 30_000);

    it("control: a running run whose controller lease expired is still treated as dead", async () => {
      const seeded = await seedClaimedRun(-5_000);

      await continuationWake(seeded.agentId, seeded.issueId);

      const runs = await runsFor(seeded.agentId);
      expect(runs.filter((run) => run.id !== seeded.runId).length).toBe(1);
    }, 30_000);
  });

  describe("P2: two failed parents on one card", () => {
    async function seedFailedRun(companyId: string, agentId: string, issueId: string, wakeReason: string) {
      const runId = randomUUID();
      const now = new Date("2026-10-15T17:41:52.100Z");
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "automation",
        status: "failed",
        runtimeMode: "legacy",
        error: "agentos-jev-seat: GET /api/issues/x failed: agentos-http network_error ECONNRESET",
        errorCode: "adapter_failed",
        exitCode: 1,
        finishedAt: now,
        resultJson: { stdout: "", stderr: "", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
        contextSnapshot: { issueId, wakeReason },
        updatedAt: now,
        createdAt: now,
      });
      return { runId, now };
    }

    async function liveRetries(agentId: string) {
      return db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.agentId, agentId),
        inArray(heartbeatRuns.status, ["scheduled_retry", "queued"]),
      ));
    }

    it("schedules one transient retry, not two, when both parents fail together", async () => {
      const { companyId, agentId } = await seedAgent("codex_local");
      const issueId = randomUUID();
      const a = await seedFailedRun(companyId, agentId, issueId, "issue_recovery_action_restored");
      const b = await seedFailedRun(companyId, agentId, issueId, "manual");

      const first = await heartbeat.scheduleBoundedRetry(a.runId, { now: a.now, random: () => 0 });
      const second = await heartbeat.scheduleBoundedRetry(b.runId, { now: b.now, random: () => 0 });

      expect(first).toMatchObject({ outcome: "scheduled" });
      expect(second).toMatchObject({ outcome: "scheduled" });
      const retries = await liveRetries(agentId);
      expect(retries).toHaveLength(1);
      expect(retries[0]?.retryOfRunId).toBe(a.runId);
    }, 30_000);

    it("control: parents on two different cards each get their own retry", async () => {
      const { companyId, agentId } = await seedAgent("codex_local");
      const a = await seedFailedRun(companyId, agentId, randomUUID(), "issue_commented");
      const b = await seedFailedRun(companyId, agentId, randomUUID(), "issue_commented");

      await heartbeat.scheduleBoundedRetry(a.runId, { now: a.now, random: () => 0 });
      await heartbeat.scheduleBoundedRetry(b.runId, { now: b.now, random: () => 0 });

      expect(await liveRetries(agentId)).toHaveLength(2);
    }, 30_000);

    it("control: the same parent asked twice still reuses its own retry", async () => {
      const { companyId, agentId } = await seedAgent("codex_local");
      const a = await seedFailedRun(companyId, agentId, randomUUID(), "issue_commented");

      await heartbeat.scheduleBoundedRetry(a.runId, { now: a.now, random: () => 0 });
      await heartbeat.scheduleBoundedRetry(a.runId, { now: a.now, random: () => 0 });

      expect(await liveRetries(agentId)).toHaveLength(1);
    }, 30_000);
  });

  describe("P4: an interrupted conversation run already folded by recovery", () => {
    async function seedInterruptedRun(adapterType: string) {
      const { companyId, agentId } = await seedAgent(adapterType);
      const issueId = await seedInProgressIssue(companyId, agentId);
      const runId = randomUUID();
      const finishedAt = new Date(Date.now() - 3_600_000);
      // Live shape of 78dcd869 on SCAA-2100.
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "interrupted",
        runtimeMode: "legacy",
        errorCode: "orphaned_running_run",
        startedAt: new Date(finishedAt.getTime() - 60_000),
        finishedAt,
        updatedAt: finishedAt,
        runnerProfileJson: { adapterDispatch: { adapterType } },
        contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      return { companyId, agentId, issueId, run: run! };
    }

    async function holdsFor(issueId: string) {
      return db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    }

    async function settledRows(issueId: string) {
      const rows = await db.select({ id: activityLog.id }).from(activityLog).where(and(
        eq(activityLog.entityId, issueId),
        eq(activityLog.action, "issue.execution_recovery_settled"),
      ));
      return rows.length;
    }

    async function sweepTick(run: typeof heartbeatRuns.$inferSelect) {
      // What the stranded sweep does each tick for this card
      // (recovery/service.ts terminalizeLegacyExecution call), then the
      // settle pass.
      const [current] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
      await terminalizeLegacyExecution({ db, run: current!, status: current!.status, fromStatuses: [current!.status] });
      await settleUnrecoverableExecutions(db);
    }

    it("does not create and settle a new hold on every sweep tick", async () => {
      const seeded = await seedInterruptedRun("codex_local");

      await sweepTick(seeded.run);
      expect(await holdsFor(seeded.issueId)).toHaveLength(1);
      expect(await settledRows(seeded.issueId)).toBe(1);
      const [afterFirst] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.run.id));

      await sweepTick(seeded.run);
      await sweepTick(seeded.run);

      expect(await holdsFor(seeded.issueId)).toHaveLength(1);
      expect(await settledRows(seeded.issueId)).toBe(1);
      const [afterMore] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, seeded.run.id));
      expect(afterMore?.updatedAt.getTime()).toBe(afterFirst?.updatedAt.getTime());
    }, 30_000);

    it("control: the first tick still records and settles the hold", async () => {
      const seeded = await seedInterruptedRun("codex_local");

      await sweepTick(seeded.run);

      const holds = await holdsFor(seeded.issueId);
      expect(holds).toHaveLength(1);
      expect(holds[0]).toMatchObject({ status: "resolved", outcome: "cancelled" });
    }, 30_000);

    it("control: a non-conversation adapter's blocked hold is unchanged by this rule", async () => {
      const seeded = await seedInterruptedRun("process");

      await sweepTick(seeded.run);
      const holds = await holdsFor(seeded.issueId);
      expect(holds).toHaveLength(1);
      expect(holds[0]).toMatchObject({ status: "resolved", outcome: "blocked" });
      const [card] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, seeded.issueId));
      expect(card?.status).toBe("blocked");
    }, 30_000);
  });
});
