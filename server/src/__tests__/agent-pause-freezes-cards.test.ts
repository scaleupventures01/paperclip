import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { heartbeatService } from "../services/heartbeat.ts";

// Calvin 2026-10-14: "pausing an agent freezes its cards exactly as they are.
// Releasing the agent puts each card back where it was, and the system stops
// 'recovering' cards of agents paused on purpose."

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pause-freeze tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("pausing an agent freezes its cards", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-pause-freeze-");
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
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Freeze ${companyId.slice(0, 6)}`,
      issuePrefix: `F${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedIssue(companyId: string, assigneeAgentId: string, title: string, status: string) {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, assigneeAgentId, title, status, priority: "medium" });
    return id;
  }

  // A cancelled run on the card, as pausing leaves behind when it stops the
  // agent's active work (routes/agents.ts calls cancelActiveForAgent).
  async function seedCancelledRun(companyId: string, agentId: string, issueId: string) {
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const at = new Date("2026-10-14T12:00:00.000Z");
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "cancelled",
      runId,
      claimedAt: at,
      finishedAt: at,
      error: "Cancelled due to agent pause",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "cancelled",
      wakeupRequestId,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      startedAt: at,
      finishedAt: at,
      updatedAt: at,
      errorCode: "cancelled",
      error: "Cancelled due to agent pause",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
    });
    return runId;
  }

  async function seedBoard() {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Paused seat");
    const todoId = await seedIssue(companyId, agentId, "Todo card", "todo");
    const inProgressId = await seedIssue(companyId, agentId, "In progress card", "in_progress");
    const blockedId = await seedIssue(companyId, agentId, "Blocked card", "blocked");
    const backlogId = await seedIssue(companyId, agentId, "Backlog card", "backlog");
    const doneId = await seedIssue(companyId, agentId, "Done card", "done");
    const blockerId = await seedIssue(companyId, agentId, "Blocker card", "todo");
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedId,
      type: "blocks",
    });
    await seedCancelledRun(companyId, agentId, inProgressId);
    return {
      companyId,
      agentId,
      cardIds: [todoId, inProgressId, blockedId, backlogId, doneId, blockerId],
      todoId,
      inProgressId,
      blockedId,
      blockerId,
    };
  }

  async function snapshotCards(cardIds: string[]) {
    const rows = await db
      .select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(inArray(issues.id, cardIds));
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  }

  async function snapshotRelations(companyId: string) {
    const rows = await db
      .select({ issueId: issueRelations.issueId, relatedIssueId: issueRelations.relatedIssueId, type: issueRelations.type })
      .from(issueRelations)
      .where(eq(issueRelations.companyId, companyId));
    return rows.sort((a, b) => a.issueId.localeCompare(b.issueId));
  }

  async function systemCommentsOn(cardIds: string[]) {
    return db
      .select({ id: issueComments.id, issueId: issueComments.issueId, body: issueComments.body })
      .from(issueComments)
      .where(and(inArray(issueComments.issueId, cardIds), eq(issueComments.authorType, "system")));
  }

  it("leaves every card's status, assignee and blockers untouched on pause", async () => {
    const board = await seedBoard();
    const cardsBefore = await snapshotCards(board.cardIds);
    const relationsBefore = await snapshotRelations(board.companyId);

    const result = await agentService(db).pause(board.agentId);

    expect(result).toMatchObject({ id: board.agentId, status: "paused", pauseReason: "manual" });
    // Five open cards (todo, in_progress, blocked, backlog, blocker todo); none closed, none moved.
    expect(result?.cardChanges).toEqual({ openBefore: 5, moved: 0, closed: 0, frozen: 5 });
    expect(await snapshotCards(board.cardIds)).toEqual(cardsBefore);
    expect(await snapshotRelations(board.companyId)).toEqual(relationsBefore);
  });

  it("does not move a manually paused agent's cards to blocked or post escalation comments", async () => {
    // The live 2026-10-14 shape: the agent is paused on purpose and its cards
    // are open (reopened by hand). Set the pause directly so this case does not
    // depend on what pause() does to cards.
    const board = await seedBoard();
    await db
      .update(agents)
      .set({ status: "paused", pauseReason: "manual", pausedAt: new Date() })
      .where(eq(agents.id, board.agentId));
    const cardsBefore = await snapshotCards(board.cardIds);

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(await snapshotCards(board.cardIds)).toEqual(cardsBefore);
    expect(await systemCommentsOn(board.cardIds)).toEqual([]);
    expect(
      await db.select().from(issueRecoveryActions).where(inArray(issueRecoveryActions.sourceIssueId, board.cardIds)),
    ).toEqual([]);
  });

  it("still escalates the cards of an agent paused by the budget guard (control)", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "Over budget seat");
    const inProgressId = await seedIssue(companyId, agentId, "Budget card", "in_progress");
    await seedCancelledRun(companyId, agentId, inProgressId);
    await db
      .update(agents)
      .set({ status: "paused", pauseReason: "budget", pausedAt: new Date() })
      .where(eq(agents.id, agentId));

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(await snapshotCards([inProgressId])).toEqual([
      { id: inProgressId, status: "blocked", assigneeAgentId: agentId },
    ]);
  });

  it("refuses a wake for a paused agent's card without changing the card", async () => {
    const board = await seedBoard();
    await agentService(db).pause(board.agentId);
    const cardsBefore = await snapshotCards(board.cardIds);

    const run = await heartbeatService(db)
      .wakeup(board.agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: board.todoId },
        contextSnapshot: { issueId: board.todoId },
      })
      .catch(() => null);

    expect(run?.status === "running").toBe(false);
    expect(await snapshotCards(board.cardIds)).toEqual(cardsBefore);
  });

  it("puts every card back where it was on resume without enqueueing wakes", async () => {
    const board = await seedBoard();
    const cardsBefore = await snapshotCards(board.cardIds);
    const relationsBefore = await snapshotRelations(board.companyId);

    await agentService(db).pause(board.agentId);
    await heartbeatService(db).reconcileStrandedAssignedIssues();

    const wakesBefore = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, board.agentId));
    const runsBefore = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, board.agentId));

    const resumed = await agentService(db).resume(board.agentId);

    expect(resumed).toMatchObject({ id: board.agentId, status: "idle", pauseReason: null });
    expect(await snapshotCards(board.cardIds)).toEqual(cardsBefore);
    expect(await snapshotRelations(board.companyId)).toEqual(relationsBefore);
    expect(await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, board.agentId))).toHaveLength(wakesBefore.length);
    expect(await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, board.agentId))).toHaveLength(runsBefore.length);
  });
});
