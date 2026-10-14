import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService, stopTaskDrain } from "../services/heartbeat.ts";

// An agent that hands its card to another agent from inside its own run gets
// that run cancelled as issue_reassigned. The new owner's assignment wake is
// enqueued in the same PATCH, while the old run's process or lease still
// holds the card, so it parks as deferred_issue_execution with no recovery
// action to settle. These tests pin the release path for that parked wake:
// it must promote exactly once after the old owner lets go (T2), never while
// the old owner still holds the card (T3), never after an operator stop (T4),
// and never as a second run for the same owner (T5).
// Diagnosis: infra reports/parked-wake-20261014/REPORT.md.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres handoff wake release tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const KILL_SWITCH = "PAPERCLIP_HANDOFF_WAKE_RELEASE";

describeEmbeddedPostgres("heartbeat handoff wake release", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalKillSwitch = process.env[KILL_SWITCH];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-handoff-wake-release-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  function isHeartbeatRunDependentFkError(error: unknown) {
    const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
    return (
      message.includes("heartbeat_run_events_run_id_heartbeat_runs_id_fk") ||
      message.includes("activity_log_run_id_heartbeat_runs_id_fk")
    );
  }

  async function deleteHeartbeatRunsWithDependents() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(heartbeatRunEvents);
      await db.delete(activityLog);
      try {
        await db.delete(heartbeatRuns);
        return;
      } catch (error) {
        if (!isHeartbeatRunDependentFkError(error) || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  afterEach(async () => {
    stopTaskDrain();
    if (originalKillSwitch === undefined) delete process.env[KILL_SWITCH];
    else process.env[KILL_SWITCH] = originalKillSwitch;
    await db.delete(environmentLeases);
    await db.delete(issueComments);
    await deleteHeartbeatRunsWithDependents();
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  type SeedOptions = {
    /** Error code on the old owner's cancelled run. */
    errorCode?: string;
    /** Who the card is assigned to now. */
    assignee?: "old" | "new";
    /** Which agent owns the parked wake. */
    wakeOwner?: "old" | "new";
    /** True keeps the old run's environment lease open (released_at null). */
    leaseHeld?: boolean;
    /** The card's status now. */
    issueStatus?: "todo" | "cancelled" | "done";
  };

  async function seedParkedHandoff(options: SeedOptions = {}) {
    const errorCode = options.errorCode ?? "issue_reassigned";
    const companyId = randomUUID();
    const oldAgentId = randomUUID();
    const newAgentId = randomUUID();
    const issueId = randomUUID();
    const oldRunId = randomUUID();
    const commentId = randomUUID();
    const wakeId = randomUUID();
    const twoMinutesAgo = new Date(Date.now() - 120_000);

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const agentRow = (id: string, name: string) => ({
      id,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });
    await db.insert(agents).values([agentRow(oldAgentId, "Old Owner"), agentRow(newAgentId, "New Owner")]);

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Card handed to another agent during the old owner's run",
      status: options.issueStatus ?? "todo",
      priority: "high",
      assigneeAgentId: (options.assignee ?? "new") === "new" ? newAgentId : oldAgentId,
      responsibleUserId: "responsible-user",
    });

    // The old owner's run, exactly as the PATCH leaves it: cancelled with an
    // acknowledged cancellation, a conversation adapter dispatch, and its
    // process already gone.
    await db.insert(heartbeatRuns).values({
      id: oldRunId,
      companyId,
      agentId: oldAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "cancelled",
      runtimeMode: "legacy",
      errorCode,
      startedAt: new Date(Date.now() - 300_000),
      finishedAt: twoMinutesAgo,
      processPid: null,
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      // mergeRunStopMetadataForAgent stamps the continuation policy on an
      // acknowledged cancel of a conversation-adapter (codex_local) agent.
      resultJson: {
        executionCancellation: { state: "acknowledged" },
        conversationContinuation: "continue_conversation_v1",
        ...(errorCode === "issue_reassigned" ? { reassignmentStopConfirmed: true } : {}),
      },
    });

    await db.insert(environmentLeases).values({
      companyId,
      heartbeatRunId: oldRunId,
      issueId,
      status: options.leaseHeld ? "active" : "released",
      releasedAt: options.leaseHeld ? null : new Date(Date.now() - 115_000),
    });

    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorAgentId: oldAgentId,
      createdByRunId: oldRunId,
      body: "Handing this to you.",
    });

    const wakeOwnerId = (options.wakeOwner ?? "new") === "new" ? newAgentId : oldAgentId;
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId: wakeOwnerId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      status: "deferred_issue_execution",
      requestedByActorType: "agent",
      requestedByActorId: oldAgentId,
      requestedAt: twoMinutesAgo,
      updatedAt: twoMinutesAgo,
      payload: {
        issueId,
        interruptedRunId: oldRunId,
        executionWait: { reason: "execution_recovery", recoveryActionId: null },
        _paperclipWakeContext: {
          issueId,
          wakeReason: "issue_assigned",
          wakeCommentIds: [commentId],
          wakeCommentId: commentId,
          commentId,
        },
      },
    });

    return { companyId, oldAgentId, newAgentId, issueId, oldRunId, commentId, wakeId, wakeOwnerId };
  }

  async function readWake(wakeId: string) {
    return db
      .select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeId))
      .then((rows) => rows[0] ?? null);
  }

  // The test agents use the process adapter, which exits without posting a
  // comment, so a finished run earns an existing missing_issue_comment
  // follow-up. That follow-up is not a wake of the card and is left out here.
  async function runsFor(companyId: string, agentId: string, issueId: string) {
    return db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, wakeupRequestId: heartbeatRuns.wakeupRequestId })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
        sql`coalesce(${heartbeatRuns.contextSnapshot}->>'wakeReason', '') <> 'missing_issue_comment'`,
      ))
      .orderBy(heartbeatRuns.createdAt);
  }

  it("T2: promotes the new owner's parked assignment wake once the old owner's run has let go", async () => {
    const seeded = await seedParkedHandoff();
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const wake = await readWake(seeded.wakeId);
    expect(wake?.status).not.toBe("deferred_issue_execution");
    const newOwnerRuns = await runsFor(seeded.companyId, seeded.newAgentId, seeded.issueId);
    expect(newOwnerRuns).toHaveLength(1);
    expect(newOwnerRuns[0]?.wakeupRequestId).toBe(seeded.wakeId);
  }, 30_000);

  it("T3: keeps the wake parked while the old owner's environment lease is still open", async () => {
    const seeded = await seedParkedHandoff({ leaseHeld: true });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect((await readWake(seeded.wakeId))?.status).toBe("deferred_issue_execution");
    expect(await runsFor(seeded.companyId, seeded.newAgentId, seeded.issueId)).toHaveLength(0);
  }, 30_000);

  it("T3: keeps the wake parked while the old owner's process is still alive", async () => {
    const seeded = await seedParkedHandoff();
    // This test process stands in for the still-running provider process.
    await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, seeded.oldRunId));
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect((await readWake(seeded.wakeId))?.status).toBe("deferred_issue_execution");
    expect(await runsFor(seeded.companyId, seeded.newAgentId, seeded.issueId)).toHaveLength(0);
  }, 30_000);

  it("T4: an operator stop of another agent's run never promotes the parked wake", async () => {
    const seeded = await seedParkedHandoff({ errorCode: "cancelled" });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect((await readWake(seeded.wakeId))?.status).toBe("deferred_issue_execution");
    expect(await runsFor(seeded.companyId, seeded.newAgentId, seeded.issueId)).toHaveLength(0);
  }, 30_000);

  it("T4: an issue_reassigned stop whose agent is still the assignee stays an operator stop", async () => {
    const seeded = await seedParkedHandoff({ assignee: "old", wakeOwner: "old" });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect((await readWake(seeded.wakeId))?.status).toBe("deferred_issue_execution");
    const oldOwnerRuns = await runsFor(seeded.companyId, seeded.oldAgentId, seeded.issueId);
    expect(oldOwnerRuns.map((run) => run.id)).toEqual([seeded.oldRunId]);
  }, 30_000);

  it("T5: a later dead_run wake for the new owner does not start a second run for the handoff", async () => {
    const seeded = await seedParkedHandoff();
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    // The watchdog's dead_run wake arrives while the promoted run is queued
    // or running (old code: while the handoff wake is still parked).
    await heartbeat.wakeup(seeded.newAgentId, {
      source: "on_demand",
      triggerDetail: "system",
      reason: "dead_run",
      payload: { issueId: seeded.issueId },
      contextSnapshot: { issueId: seeded.issueId, wakeReason: "dead_run" },
    });
    for (let pass = 0; pass < 3; pass += 1) {
      await heartbeat.drainActiveRunExecutions();
      await heartbeat.resumeQueuedRuns();
    }
    await heartbeat.drainActiveRunExecutions();

    // The handoff wake is the new owner's run; it must not ALSO fire as a
    // second run behind the dead_run wake (the live double wake).
    const handoffRuns = (await runsFor(seeded.companyId, seeded.newAgentId, seeded.issueId))
      .filter((run) => run.wakeupRequestId === seeded.wakeId);
    expect(handoffRuns).toHaveLength(1);
    const wakeRow = await readWake(seeded.wakeId);
    expect(wakeRow?.runId).toBe(handoffRuns[0]?.id);
    // The handoff run comes first: no new-owner run was created before it
    // (old code: the dead_run run ran first and the parked wake followed it).
    const allRuns = await runsFor(seeded.companyId, seeded.newAgentId, seeded.issueId);
    expect(allRuns[0]?.id).toBe(handoffRuns[0]?.id);
  }, 60_000);

  for (const issueStatus of ["cancelled", "done"] as const) {
    it(`T6: settles a parked handoff wake on a ${issueStatus} card instead of promoting it or leaving it parked`, async () => {
      const seeded = await seedParkedHandoff({ issueStatus });
      const heartbeat = heartbeatService(db);

      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();

      const wake = await db
        .select({
          status: agentWakeupRequests.status,
          error: agentWakeupRequests.error,
          finishedAt: agentWakeupRequests.finishedAt,
          runId: agentWakeupRequests.runId,
        })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, seeded.wakeId))
        .then((rows) => rows[0] ?? null);
      expect(wake?.status).toBe("cancelled");
      expect(wake?.error).toBe("Deferred execution wake no longer applies to a terminal task");
      expect(wake?.finishedAt).not.toBeNull();
      expect(wake?.runId).toBeNull();
      expect(await runsFor(seeded.companyId, seeded.newAgentId, seeded.issueId)).toHaveLength(0);
      const card = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, seeded.issueId));
      expect(card[0]?.status).toBe(issueStatus);
    }, 30_000);
  }

  it(`kill switch: ${KILL_SWITCH}=0 restores today's behavior and leaves the wake parked`, async () => {
    process.env[KILL_SWITCH] = "0";
    const seeded = await seedParkedHandoff();
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    expect((await readWake(seeded.wakeId))?.status).toBe("deferred_issue_execution");
    expect(await runsFor(seeded.companyId, seeded.newAgentId, seeded.issueId)).toHaveLength(0);
  }, 30_000);
});
