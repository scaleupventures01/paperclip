import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  agentWakeupRequests,
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

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_input?: unknown) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Reviewed.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn(), hashPrivateRef: vi.fn(() => "x") }),
}));
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { recoveryService } from "../services/recovery/service.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres review wake escalation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Real heartbeat admission path (only the adapter process is mocked): the
// reviewer's review-stage wake is skipped while the author's cancelled run
// holds its lease, the sweep's one recovery wake races the lease and is
// skipped too, and the next sweep must escalate exactly once.
describeEmbeddedPostgres("stranded sweep escalates a review participant whose recovery wake was skipped", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-wake-escalation-");
    db = createDb(tempDb.connectionString);
    const now = new Date();
    await db.insert(authUsers).values({
      id: "responsible-user",
      name: "Responsible User",
      email: "responsible-user@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const authorId = randomUUID();
    const reviewerId = randomUUID();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const prefix = `RE${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Review Escalation Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values([
      { id: authorId, companyId, name: "Author", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
      { id: reviewerId, companyId, name: "Reviewer", role: "qa", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Build under review",
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
      startedAt: new Date(Date.now() - 600_000),
      finishedAt: new Date(Date.now() - 5_000),
      contextSnapshot: { issueId },
    });
    const [lease] = await db.insert(environmentLeases).values({
      companyId,
      issueId,
      heartbeatRunId: authorRunId,
      status: "active",
      leasePolicy: "ephemeral",
      provider: "local",
      acquiredAt: new Date(Date.now() - 600_000),
      lastUsedAt: new Date(Date.now() - 5_000),
      releasedAt: null,
      cleanupStatus: null,
    }).returning();
    return { companyId, authorId, reviewerId, issueId, stageId, authorRunId, leaseId: lease!.id };
  }

  async function setLease(leaseId: string, held: boolean) {
    await db
      .update(environmentLeases)
      .set(held
        ? { status: "active", releasedAt: null, cleanupStatus: null }
        : { status: "released", releasedAt: new Date(), cleanupStatus: "succeeded" })
      .where(eq(environmentLeases.id, leaseId));
  }

  // Same shape as the review-stage wake routes/issues.ts sends for a pending review stage.
  function reviewStageWake(s: Awaited<ReturnType<typeof seed>>) {
    const executionStage = { wakeRole: "reviewer", stageId: s.stageId, stageType: "review", allowedActions: ["approve", "request_changes"] };
    return {
      source: "assignment" as const,
      triggerDetail: "system" as const,
      reason: "execution_review_requested",
      payload: { issueId: s.issueId, mutation: "update", executionStage, interruptedRunId: s.authorRunId },
      requestedByActorType: "agent" as const,
      requestedByActorId: s.authorId,
      contextSnapshot: {
        issueId: s.issueId,
        taskId: s.issueId,
        wakeReason: "execution_review_requested",
        source: "issue.execution_stage",
        executionStage,
        interruptedRunId: s.authorRunId,
      },
    };
  }

  async function reviewerWakes(s: { reviewerId: string; issueId: string }) {
    const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, s.reviewerId));
    return rows
      .filter((r) => (r.payload as Record<string, unknown> | null)?.issueId === s.issueId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  it("escalates once after the one recovery wake is itself skipped, and never requeues again", async () => {
    const s = await seed();
    const heartbeat = heartbeatService(db);

    expect(await heartbeat.wakeup(s.reviewerId, reviewStageWake(s))).toBeNull();
    await setLease(s.leaseId, false);

    // The recovery enqueue re-takes the lease right before admission, so the
    // recovery wake is skipped with the marker.
    const racing = recoveryService(db, {
      enqueueWakeup: async (agentId: string, opts: unknown) => {
        await setLease(s.leaseId, true);
        return heartbeat.wakeup(agentId, opts as never);
      },
    } as never);
    await racing.reconcileStrandedAssignedIssues();
    const afterRace = await reviewerWakes(s);
    expect(afterRace.at(-1)).toMatchObject({ status: "skipped", reason: "execution_reconciliation_required" });
    expect((afterRace.at(-1)!.payload as Record<string, unknown>).skippedReviewWakeRecovery).toBe(true);

    await setLease(s.leaseId, false);
    const second = await heartbeat.reconcileStrandedAssignedIssues();
    const third = await heartbeat.reconcileStrandedAssignedIssues();

    expect(second.issueIds).toContain(s.issueId);
    expect(second.escalated).toBeGreaterThanOrEqual(1);
    expect(third.issueIds).not.toContain(s.issueId);
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    expect(issue!.status).toBe("blocked");
    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, s.issueId));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ cause: "execution_review_participant_recovery" });
    const notices = await db
      .select()
      .from(issueComments)
      .where(and(eq(issueComments.issueId, s.issueId), eq(issueComments.authorType, "system")));
    expect(notices).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, s.reviewerId))).toHaveLength(0);
    expect(await reviewerWakes(s)).toHaveLength(afterRace.length);
  }, 60_000);
});
