import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  activityLog,
  companies,
  createDb,
  environmentLeases,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres review wake requeue tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A review stage opened from inside the author's own run: the reassignment
// cancels that run, the reviewer's wake is admitted while the cancelled run
// still holds its environment lease, and the wake is recorded as a terminal
// `skipped` row with reason `execution_reconciliation_required`. The stranded
// sweep must requeue that reviewer once the lease is gone.
describeEmbeddedPostgres("stranded sweep requeues a skipped review wake", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-wake-requeue-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedReviewHandoff(input: {
    leaseHeld?: boolean;
    skippedWakeReason?: string;
    skippedWakePayloadExtra?: Record<string, unknown>;
    reviewerHasRun?: boolean;
  } = {}) {
    const companyId = randomUUID();
    const authorId = randomUUID();
    const reviewerId = randomUUID();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const prefix = `RW${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Review Wake Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: authorId,
        companyId,
        name: "Author",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: reviewerId,
        companyId,
        name: "Reviewer",
        role: "qa",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Build change under review",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: reviewerId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: reviewerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerId, userId: null },
        returnAssignee: { type: "agent", agentId: authorId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    // The author's run that sent the handoff PATCH, cancelled by the reassignment.
    const authorRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: authorRunId,
      companyId,
      agentId: authorId,
      invocationSource: "automation",
      status: "cancelled",
      errorCode: "issue_reassigned",
      runtimeMode: "legacy",
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
      startedAt: new Date("2026-10-28T21:20:00.000Z"),
      finishedAt: new Date("2026-10-28T21:27:52.634Z"),
      contextSnapshot: { issueId },
    });
    await db.insert(environmentLeases).values({
      companyId,
      issueId,
      heartbeatRunId: authorRunId,
      status: input.leaseHeld ? "active" : "released",
      leasePolicy: "ephemeral",
      provider: "local",
      acquiredAt: new Date("2026-10-28T21:20:00.000Z"),
      lastUsedAt: new Date("2026-10-28T21:27:52.000Z"),
      releasedAt: input.leaseHeld ? null : new Date("2026-10-28T21:27:55.343Z"),
      cleanupStatus: input.leaseHeld ? null : "succeeded",
    });

    // The reviewer's review-stage wake, skipped while the lease was held.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId: reviewerId,
      source: "assignment",
      triggerDetail: "system",
      reason: input.skippedWakeReason ?? "execution_reconciliation_required",
      status: "skipped",
      error: "The previous execution has not released its environment lease. Wait for cleanup before continuing this task.",
      finishedAt: new Date("2026-10-28T21:27:52.818Z"),
      payload: {
        issueId,
        executionWait: { recoveryActionId: null, reason: "execution_recovery" },
        ...(input.skippedWakePayloadExtra ?? {}),
      },
      createdAt: new Date("2026-10-28T21:27:52.818Z"),
      requestedAt: new Date("2026-10-28T21:27:52.818Z"),
    });

    if (input.reviewerHasRun) {
      await db.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId: reviewerId,
        invocationSource: "automation",
        status: "running",
        startedAt: new Date("2026-10-28T21:28:00.000Z"),
        contextSnapshot: { issueId },
      });
    }

    return { companyId, authorId, reviewerId, issueId, authorRunId };
  }

  function reviewRecoveryCalls(enqueueWakeup: ReturnType<typeof vi.fn>, agentId: string) {
    return enqueueWakeup.mock.calls.filter(
      ([target, opts]) =>
        target === agentId &&
        (opts as { reason?: string } | undefined)?.reason === "execution_review_participant_recovery",
    );
  }

  it("requeues the reviewer once the author's lease is released", async () => {
    const { reviewerId, issueId } = await seedReviewHandoff();
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() } as never));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    const calls = reviewRecoveryCalls(enqueueWakeup, reviewerId);
    expect(calls).toHaveLength(1);
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(calls[0]![1]).toMatchObject({
      reason: "execution_review_participant_recovery",
      payload: expect.objectContaining({ issueId }),
      contextSnapshot: expect.objectContaining({
        issueId,
        wakeReason: "execution_review_participant_recovery",
        retryReason: "execution_review_participant_recovery",
        source: "issue.execution_review_recovery",
      }),
    });
    expect(result).toMatchObject({ reviewParticipantRequeued: 1 });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
  });

  it("does not requeue while the author's run still holds its lease", async () => {
    const { reviewerId } = await seedReviewHandoff({ leaseHeld: true });
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() } as never));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(reviewRecoveryCalls(enqueueWakeup, reviewerId)).toHaveLength(0);
    expect(result).toMatchObject({ reviewParticipantRequeued: 0 });
  });

  it("does not requeue when the reviewer's last wake was skipped for another reason", async () => {
    const { reviewerId } = await seedReviewHandoff({ skippedWakeReason: "issue_assigned" });
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() } as never));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(reviewRecoveryCalls(enqueueWakeup, reviewerId)).toHaveLength(0);
    expect(result).toMatchObject({ reviewParticipantRequeued: 0 });
  });

  it("keeps existing behavior when the reviewer already has a run on the card", async () => {
    const { reviewerId } = await seedReviewHandoff({ reviewerHasRun: true });
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() } as never));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(reviewRecoveryCalls(enqueueWakeup, reviewerId)).toHaveLength(0);
    expect(result).toMatchObject({ reviewParticipantRequeued: 0 });
  });

  it("does not requeue again when the skipped wake was itself this recovery", async () => {
    const { reviewerId } = await seedReviewHandoff({
      skippedWakePayloadExtra: { skippedReviewWakeRecovery: true },
    });
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() } as never));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(reviewRecoveryCalls(enqueueWakeup, reviewerId)).toHaveLength(0);
    expect(result).toMatchObject({ reviewParticipantRequeued: 0 });
  });
});
