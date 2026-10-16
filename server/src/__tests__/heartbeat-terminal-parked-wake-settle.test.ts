import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

// A deferred wake parked on a card that is already done or cancelled can
// never do useful work. The stranded-queue sweep in resumeQueuedRuns used to
// re-touch such a row on every tick and hand it to the release path, which
// returns early (operator-acknowledged stop, missing run, held agent) without
// reaching the drain's terminal-task cancel. Live 2026-10-15 02:50Z: IT
// Manager 32 parked wakes on cancelled cards and 1 on done, still parked
// minutes later (card sweep and gate10 reports).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres terminal parked wake tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const TERMINAL_REASON = "Deferred execution wake no longer applies to a terminal task";

describeEmbeddedPostgres("stranded-queue sweep settles parked wakes on terminal cards", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const gateDir = mkdtempSync(path.join(tmpdir(), "terminal-parked-wake-gate-"));
  const gatePath = path.join(gateDir, "fleet-release-gate.json");
  const originalGateEnv = process.env.AGENTOS_FLEET_RELEASE_GATE;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-terminal-parked-wake-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    stopTaskDrain();
    if (originalGateEnv === undefined) delete process.env.AGENTOS_FLEET_RELEASE_GATE;
    else process.env.AGENTOS_FLEET_RELEASE_GATE = originalGateEnv;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.delete(issueComments);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(issues);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(companySkills);
        await db.delete(companies);
        return;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  });

  afterAll(async () => {
    rmSync(gateDir, { recursive: true, force: true });
    await tempDb?.cleanup();
  });

  type Hold = "paused" | "off_allowlist" | "none";

  async function seedParked(options: {
    hold: Hold;
    issueStatus: "cancelled" | "done" | "todo";
    latestRunStatus?: "cancelled" | "running";
    latestRunFinishedAgoMs?: number;
    /** Who the card is assigned to. Default: the agent that owns the parked wake. */
    assignee?: "wake_agent" | "other_agent";
    /** Parked payload. Default: a comment wake carrying its comment id. */
    payloadShape?: "comment" | "interaction_without_response" | "no_comment_ids";
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const commentId = randomUUID();
    const wakeId = randomUUID();
    const tenMinutesAgo = new Date(Date.now() - 600_000);
    const finishedAgoMs = options.latestRunFinishedAgoMs ?? 300_000;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "IT Manager",
      role: "engineer",
      status: options.hold === "paused" ? "paused" : "idle",
      pauseReason: options.hold === "paused" ? "manual" : null,
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });
    const otherAgentId = randomUUID();
    if (options.assignee === "other_agent") {
      await db.insert(agents).values({
        id: otherAgentId,
        companyId,
        name: "Delivery Manager",
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
        runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
        permissions: {},
      });
    }
    if (options.hold === "off_allowlist") {
      writeFileSync(gatePath, JSON.stringify({ version: 1, enabled: true, allowedAgentIds: [] }));
      process.env.AGENTOS_FLEET_RELEASE_GATE = gatePath;
    }
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Card closed while a comment wake was parked behind a run",
      status: options.issueStatus,
      priority: "medium",
      assigneeAgentId: options.assignee === "other_agent" ? otherAgentId : agentId,
      responsibleUserId: "responsible-user",
    });
    // The agent's latest run on the card: an operator-acknowledged stop, the
    // shape that makes the release path return before the drain.
    const latestRunStatus = options.latestRunStatus ?? "cancelled";
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: latestRunStatus,
      runtimeMode: "legacy",
      errorCode: latestRunStatus === "cancelled" ? "cancelled" : null,
      startedAt: new Date(Date.now() - finishedAgoMs - 60_000),
      finishedAt: latestRunStatus === "cancelled" ? new Date(Date.now() - finishedAgoMs) : null,
      processPid: latestRunStatus === "running" ? process.pid : null,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
      resultJson: latestRunStatus === "cancelled" ? { executionCancellation: { state: "acknowledged" } } : {},
    });
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorUserId: "board-user",
      body: "One more thing.",
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_execution_deferred",
      status: "deferred_issue_execution",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      requestedAt: tenMinutesAgo,
      updatedAt: tenMinutesAgo,
      payload: options.payloadShape === "interaction_without_response"
        ? {
            issueId,
            mutation: "interaction",
            interactionId: randomUUID(),
            _paperclipWakeContext: { issueId, wakeReason: "issue_interaction_resolved", source: "issue.interaction" },
          }
        : options.payloadShape === "no_comment_ids"
          ? {
              issueId,
              mutation: "comment",
              _paperclipWakeContext: { issueId, wakeReason: "issue_commented", source: "issue.comment", wakeCommentIds: [] },
            }
          : {
              issueId,
              commentId,
              mutation: "comment",
              _paperclipWakeContext: {
                issueId,
                wakeReason: "issue_commented",
                source: "issue.comment",
                wakeCommentIds: [commentId],
                wakeCommentId: commentId,
                commentId,
              },
            },
    });
    return { companyId, agentId, issueId, runId, wakeId };
  }

  async function readWake(wakeId: string) {
    return db
      .select({
        status: agentWakeupRequests.status,
        error: agentWakeupRequests.error,
        finishedAt: agentWakeupRequests.finishedAt,
        runId: agentWakeupRequests.runId,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeId))
      .then((rows) => rows[0] ?? null);
  }

  async function runCount(companyId: string, agentId: string, issueId: string) {
    const rows = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.companyId, companyId),
        eq(heartbeatRuns.agentId, agentId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}`,
      ));
    return rows.length;
  }

  for (const hold of ["paused", "off_allowlist", "none"] as const) {
    for (const issueStatus of ["cancelled", "done"] as const) {
      it(`settles a parked wake on a ${issueStatus} card for an agent with hold=${hold}`, async () => {
        const seeded = await seedParked({ hold, issueStatus });
        const heartbeat = heartbeatService(db);

        await heartbeat.resumeQueuedRuns();
        await heartbeat.drainActiveRunExecutions();

        const wake = await readWake(seeded.wakeId);
        expect(wake?.status).toBe("cancelled");
        expect(wake?.error).toBe(TERMINAL_REASON);
        expect(wake?.finishedAt).not.toBeNull();
        expect(wake?.runId).toBeNull();
        // No new run, and the card stays where it was.
        expect(await runCount(seeded.companyId, seeded.agentId, seeded.issueId)).toBe(1);
        const card = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, seeded.issueId));
        expect(card[0]?.status).toBe(issueStatus);
      }, 30_000);
    }
  }

  for (const openStatus of ["todo", "in_progress"] as const) {
    it(`control: a parked wake on a card in ${openStatus} is not settled by this rule`, async () => {
      const seeded = await seedParked({ hold: "none", issueStatus: openStatus });
      const heartbeat = heartbeatService(db);

      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();

      const wake = await readWake(seeded.wakeId);
      expect(wake?.error).not.toBe(TERMINAL_REASON);
    }, 30_000);
  }

  // P6 (2026-10-15 21:50 ET, live): 83 parked wakes sat on done or cancelled
  // cards. 7 interaction wakes with no response were skipped by the loop's
  // earlier continue before the terminal settle; the rest were never selected
  // (wake owned by an agent that is not the assignee, or no comment ids).
  for (const shape of [
    { label: "an interaction wake with no response", payloadShape: "interaction_without_response" as const },
    { label: "a wake owned by an agent that is not the assignee", assignee: "other_agent" as const },
    { label: "a comment wake that carries no comment ids", payloadShape: "no_comment_ids" as const },
    { label: "a non-assignee wake with no comment ids", assignee: "other_agent" as const, payloadShape: "no_comment_ids" as const },
  ]) {
    for (const issueStatus of ["cancelled", "done"] as const) {
      it(`settles ${shape.label} parked on a ${issueStatus} card`, async () => {
        const seeded = await seedParked({ hold: "none", issueStatus, ...shape });
        const heartbeat = heartbeatService(db);

        await heartbeat.resumeQueuedRuns();
        await heartbeat.drainActiveRunExecutions();

        const wake = await readWake(seeded.wakeId);
        expect(wake?.status).toBe("cancelled");
        expect(wake?.error).toBe(TERMINAL_REASON);
        expect(await runCount(seeded.companyId, seeded.agentId, seeded.issueId)).toBe(1);
        const card = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, seeded.issueId));
        expect(card[0]?.status).toBe(issueStatus);
      }, 30_000);
    }
    it(`control: ${shape.label} on an open card is not settled by this rule`, async () => {
      const seeded = await seedParked({ hold: "none", issueStatus: "todo", ...shape });
      const heartbeat = heartbeatService(db);

      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();

      expect((await readWake(seeded.wakeId))?.error).not.toBe(TERMINAL_REASON);
    }, 30_000);
  }

  it("control: a non-assignee parked wake on a done card stays while its agent's latest run finished moments ago", async () => {
    const seeded = await seedParked({ hold: "none", issueStatus: "done", assignee: "other_agent", latestRunFinishedAgoMs: 10_000 });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();

    expect((await readWake(seeded.wakeId))?.status).toBe("deferred_issue_execution");
  }, 30_000);

  it("control: a parked wake on a done card stays while the agent still has a live run there", async () => {
    const seeded = await seedParked({ hold: "none", issueStatus: "done", latestRunStatus: "running" });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();

    expect((await readWake(seeded.wakeId))?.status).toBe("deferred_issue_execution");
  }, 30_000);

  it("control: a parked wake on a done card stays while the latest run finished moments ago", async () => {
    const seeded = await seedParked({ hold: "none", issueStatus: "done", latestRunFinishedAgoMs: 10_000 });
    const heartbeat = heartbeatService(db);

    await heartbeat.resumeQueuedRuns();

    expect((await readWake(seeded.wakeId))?.status).toBe("deferred_issue_execution");
  }, 30_000);
});
