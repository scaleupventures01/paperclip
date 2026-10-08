import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  heartbeatRunEvents,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  executeIssuePostCommitActions,
  issueService,
} from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping terminal queued-run reconciliation tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("terminal issue queued-run reconciliation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "issue-terminal-queued-run-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "issues",
        "agent_runtime_state",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedTerminalRunFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Terminal Reconciliation",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Reconciler",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Terminal duplicate",
      status: "done",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    return { companyId, issueId, runId, wakeupRequestId };
  }

  it("cancels a queued duplicate immediately when the issue service closes the issue", async () => {
    const seeded = await seedTerminalRunFixture();
    await db
      .update(issues)
      .set({ status: "in_progress" })
      .where(eq(issues.id, seeded.issueId));

    await issueService(db).update(seeded.issueId, { status: "done" });

    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, seeded.runId));
    const [wake] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeupRequestId));
    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "issue_terminal_status",
    });
    expect(wake).toMatchObject({
      status: "cancelled",
      runId: seeded.runId,
    });
  }, 20_000);

  it("cancels the queued loser without emitting a failed wake", async () => {
    const seeded = await seedTerminalRunFixture();

    await executeIssuePostCommitActions(db, [
      {
        type: "cancel_issue_terminal_queued_run",
        runId: seeded.runId,
        issueId: seeded.issueId,
        issueStatus: "done",
      },
    ]);

    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, seeded.runId));
    const [wake] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeupRequestId));
    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "issue_terminal_status",
    });
    expect(wake).toMatchObject({ status: "cancelled" });
  }, 20_000);

  it("coalesces a 184 ms assignment burst and preserves the completed winner when a late loser is reconciled", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Assignment Burst",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Assignment burst",
      status: "todo",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    const request = {
      source: "assignment" as const,
      triggerDetail: "system" as const,
      reason: "issue_assigned",
      payload: { issueId },
      contextSnapshot: { issueId },
      idempotencyKey: `issue-assignment:${issueId}:issue_assigned:v1`,
      requestedByActorType: "system" as const,
      requestedByActorId: "test",
    };
    const heartbeat = heartbeatService(db);
    const [winner, duplicate] = await Promise.all([
      heartbeat.wakeup(agentId, request),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 184));
        return heartbeat.wakeup(agentId, request);
      })(),
    ]);

    expect(duplicate?.id).toBe(winner?.id);
    const runsBeforeClose = await db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns);
    const wakesBeforeClose = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests);
    expect(runsBeforeClose).toHaveLength(1);
    expect(runsBeforeClose[0]).toMatchObject({ id: winner?.id });
    expect(["queued", "running"]).toContain(runsBeforeClose[0]?.status);
    expect(wakesBeforeClose).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const completedAt = new Date("2026-10-08T12:00:45.848Z");
    const winnerReceipt = { receipt: "winner", commentId: "unchanged" };
    await db
      .update(heartbeatRuns)
      .set({
        status: "completed",
        finishedAt: completedAt,
        resultJson: winnerReceipt,
      })
      .where(eq(heartbeatRuns.id, winner!.id));

    const loserId = randomUUID();
    const loserWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: loserWakeId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
      idempotencyKey: `${request.idempotencyKey}:late-loser`,
    });
    await db.insert(heartbeatRuns).values({
      id: loserId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId: loserWakeId,
      contextSnapshot: { issueId },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: loserId })
      .where(eq(agentWakeupRequests.id, loserWakeId));

    await issueService(db).update(issueId, { status: "done" });

    const [winnerAfterClose] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, winner!.id));
    const [loserAfterClose] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, loserId));
    const [loserWakeAfterClose] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, loserWakeId));
    expect(winnerAfterClose).toMatchObject({
      status: "completed",
      finishedAt: completedAt,
      resultJson: winnerReceipt,
    });
    expect(loserAfterClose).toMatchObject({
      status: "cancelled",
      errorCode: "issue_terminal_status",
    });
    expect(loserWakeAfterClose).toMatchObject({ status: "cancelled" });
  }, 30_000);
});
