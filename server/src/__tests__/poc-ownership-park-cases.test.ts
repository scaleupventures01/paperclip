// agentos#1508 POC, remaining cases from the architect plan (T3b, T5 ii,
// T5 iv, T5 v) in the same real-path harness as
// poc-ownership-park-loop.test.ts: embedded Postgres, the REAL issue route via
// supertest, the REAL heartbeat wakeup/admission/claim/execute/cleanup path
// and the real wake-queue drain. Mocked: getServerAdapter (execute spawns a
// real node child registered in runningProcesses, then waits on a per-run
// gate) and telemetry. The wake-queue factory is wrapped pass-through only, to
// record which caller entered releaseIssueExecution (the race case needs to
// show both callers reached the drain); it never changes an argument or a
// result.
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  createDb,
  environmentLeases,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

type Gate = { open: () => void; promise: Promise<void> };
const gates = vi.hoisted(() => new Map<string, Gate>());
function gateFor(runId: string): Gate {
  let g = gates.get(runId);
  if (!g) {
    let open!: () => void;
    const promise = new Promise<void>((r) => { open = r; });
    g = { open, promise };
    gates.set(runId, g);
  }
  return g;
}
const executeStarted = vi.hoisted(() => new Set<string>());
type ReleaseCall = { runId: string; caller: "stranded_drain" | "cleanup_trigger" | "other"; start: number; end: number };
const releaseCalls = vi.hoisted(() => [] as ReleaseCall[]);

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (input?: unknown) => {
    const ctx = input as { runId?: string; onSpawn?: (m: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void> } | undefined;
    const runId = ctx?.runId ?? "";
    const { spawn: spawnChild } = await import("node:child_process");
    const { runningProcesses } = await import("../adapters/index.ts");
    const child = spawnChild(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const entry = { child, graceSec: 1, processGroupId: null };
    (runningProcesses as Map<string, unknown>).set(runId, entry);
    if (ctx?.onSpawn && child.pid) await ctx.onSpawn({ pid: child.pid, processGroupId: null, startedAt: new Date().toISOString() });
    executeStarted.add(runId);
    await gateFor(runId).promise;
    if ((runningProcesses as Map<string, unknown>).get(runId) === entry) (runningProcesses as Map<string, unknown>).delete(runId);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    return {
      exitCode: 0, signal: null, timedOut: false, errorMessage: null,
      summary: "Done.", provider: "test", model: "test-model",
    };
  }),
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
vi.mock("../modules/wake-queue/index.js", async () => {
  const actual = await vi.importActual<typeof import("../modules/wake-queue/index.js")>("../modules/wake-queue/index.js");
  return {
    ...actual,
    createWakeQueue: (...args: Parameters<typeof actual.createWakeQueue>) => {
      const queue = actual.createWakeQueue(...args);
      const release = queue.releaseIssueExecution;
      return {
        ...queue,
        releaseIssueExecution: async (input: Parameters<typeof release>[0]) => {
          const stack = new Error().stack ?? "";
          const caller = stack.includes("resumeQueuedRuns") ? "stranded_drain"
            : /executeRun|runExecution|executeHeartbeatRun|startRunExecution/.test(stack) ? "cleanup_trigger" : "other";
          const call: ReleaseCall = { runId: input.runId, caller, start: Date.now(), end: 0 };
          releaseCalls.push(call);
          try {
            return await release(input);
          } finally {
            call.end = Date.now();
          }
        },
      };
    },
  };
});

import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.ts";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping POC ownership park cases: ${support.reason ?? "unsupported environment"}`);
}

d("POC agentos#1508 ownership park and release: restart, paused, race, live pid", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-poc-1508-cases-");
    db = createDb(tempDb.connectionString);
    const now = new Date();
    await db.insert(authUsers).values({
      id: "responsible-user", name: "Responsible User", email: "responsible-user@example.test",
      emailVerified: true, createdAt: now, updatedAt: now,
    });
  }, 60_000);

  afterEach(async () => {
    for (const g of gates.values()) g.open();
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL");
    delete process.env.PAPERCLIP_OWNERSHIP_WAKE_PARK;
    delete process.env.PAPERCLIP_OWNERSHIP_WAKE_PARK_MAX_MS;
    await waitFor(async () => {
      const live = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.status, "running"));
      return live.length === 0 ? true : null;
    }, 15_000);
  });

  afterAll(async () => {
    for (const g of gates.values()) g.open();
    await new Promise((r) => setTimeout(r, 500));
    await tempDb?.cleanup();
  });

  async function waitFor<T>(read: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T | null> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await read();
      if (v) return v as T;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  async function seed() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const builderId = randomUUID();
    const qaId = randomUUID();
    const parentId = randomUUID();
    const cardId = randomUUID();
    const prefix = `PC${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId, name: "POC Park Cases Co", issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user",
    });
    const base = { companyId, status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} };
    await db.insert(agents).values([
      { ...base, id: managerId, name: "IT Manager", role: "manager" },
      { ...base, id: builderId, name: "Agent Improver", role: "engineer", reportsTo: managerId },
      { ...base, id: qaId, name: "Platform QA", role: "qa", reportsTo: managerId },
    ]);
    await db.insert(issues).values({
      id: parentId, companyId, title: "Platform card", status: "in_progress", priority: "medium",
      assigneeAgentId: managerId, issueNumber: 1, identifier: `${prefix}-1`,
    });
    await db.insert(issues).values({
      id: cardId, companyId, parentId, title: "Build card", status: "todo", priority: "medium",
      assigneeAgentId: builderId, issueNumber: 2, identifier: `${prefix}-2`,
      description: "No repository change: post the marker comment.",
    });
    return { companyId, managerId, builderId, qaId, parentId, cardId };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;

  function app(companyId: string, agentId: string, runId: string) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      (req as any).actor = { type: "agent", source: "agent_key", companyId, agentId, runId };
      next();
    });
    a.use("/api", issueRoutes(db, {} as any, {}));
    a.use(errorHandler);
    return a;
  }

  async function wakesFor(s: Seed, agentId: string, issueId = s.cardId) {
    const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, agentId));
    return rows.filter((r) => (r.payload as Record<string, unknown> | null)?.issueId === issueId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  async function wakeById(id: string) {
    const [row] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id));
    return row!;
  }
  async function runsFor(agentId: string, issueId: string) {
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    return rows.filter((r) => (r.contextSnapshot as Record<string, unknown> | null)?.issueId === issueId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  function brief(rows: Array<typeof agentWakeupRequests.$inferSelect>) {
    return rows.map((w) => ({
      id: w.id.slice(0, 8), status: w.status, reason: w.reason,
      ownerRunId: ((w.payload as Record<string, unknown>)?.executionWait as Record<string, unknown> | undefined)?.ownerRunId ?? null,
      runId: w.runId, updatedAt: w.updatedAt.toISOString(),
    }));
  }
  async function claimedRun(agentId: string, issueId: string, known: string[], ms = 15_000) {
    return waitFor(async () => {
      const r = (await runsFor(agentId, issueId)).find((x) => !known.includes(x.id) && executeStarted.has(x.id));
      return r ?? null;
    }, ms);
  }
  async function leaseHeld(runId: string) {
    const rows = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, runId));
    return rows.some((l) => l.releasedAt === null);
  }

  // A terminal reassignment-stopped run on the card (live shape, pt2b d4.out:
  // acknowledged cancel plus the conversation continuation policy). With
  // `leaseActive` its environment lease is still open; with `processPid` its
  // provider process is recorded and may still be alive.
  async function seedOwnerRun(s: Seed, agentId: string, opts: { leaseActive: boolean; processPid?: number | null; ageMs?: number }) {
    const runId = randomUUID();
    const age = opts.ageMs ?? 5_000;
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: s.companyId, agentId, invocationSource: "automation",
      status: "cancelled", errorCode: "issue_reassigned", runtimeMode: "legacy",
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
      resultJson: { executionCancellation: { state: "acknowledged" }, reassignmentStopConfirmed: true, conversationContinuation: "continue_conversation_v1" },
      processPid: opts.processPid ?? null,
      startedAt: new Date(Date.now() - age - 600_000), finishedAt: new Date(Date.now() - age),
      createdAt: new Date(Date.now() - age - 600_000),
      contextSnapshot: { issueId: s.cardId },
    });
    const [lease] = await db.insert(environmentLeases).values({
      companyId: s.companyId, issueId: s.cardId, heartbeatRunId: runId,
      status: opts.leaseActive ? "active" : "released",
      leasePolicy: "ephemeral", provider: "local", acquiredAt: new Date(Date.now() - age - 600_000),
      lastUsedAt: new Date(Date.now() - age),
      releasedAt: opts.leaseActive ? null : new Date(Date.now() - age),
      cleanupStatus: opts.leaseActive ? null : "succeeded",
    }).returning();
    return { runId, leaseId: lease!.id };
  }
  async function releaseLease(leaseId: string) {
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "succeeded" })
      .where(eq(environmentLeases.id, leaseId));
  }
  async function putInReview(s: Seed) {
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review", assigneeAgentId: s.qaId,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId: s.qaId, userId: null }] }] },
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", agentId: s.qaId, userId: null },
        returnAssignee: { type: "agent", agentId: s.builderId, userId: null }, reviewRequest: null,
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null },
    }).where(eq(issues.id, s.cardId));
    return stageId;
  }
  // Shape of routes/issues.ts reviewer stage wake (2906-2966 @67ef7d74).
  function reviewStageWake(s: Seed, stageId: string, interruptedRunId: string) {
    const executionStage = { wakeRole: "reviewer", stageId, stageType: "review", allowedActions: ["approve", "request_changes"] };
    return {
      source: "assignment" as const, triggerDetail: "system" as const, reason: "execution_review_requested",
      payload: { issueId: s.cardId, mutation: "update", executionStage, interruptedRunId },
      requestedByActorType: "agent" as const, requestedByActorId: s.builderId,
      contextSnapshot: { issueId: s.cardId, taskId: s.cardId, wakeReason: "execution_review_requested", source: "issue.execution_stage", executionStage, interruptedRunId },
    };
  }

  it("T3b RESTART: a parked handoff wake whose owner cleaned up without the trigger is promoted by one stranded tick via ownerRun, not the new owner's own older run", async () => {
    const s = await seed();
    await putInReview(s);
    // The ownLatest trap (pt2b Q1): QA already has an older run on this card,
    // an acknowledged reassignment stop whose lease is long released.
    const qaOld = await seedOwnerRun(s, s.qaId, { leaseActive: false, ageMs: 3_600_000 });
    // The builder's run A handed the card to QA from inside its run: stopped,
    // lease still open (inside the 2.7 s cleanup window).
    const a = await seedOwnerRun(s, s.builderId, { leaseActive: true });
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId, companyId: s.companyId, issueId: s.cardId, authorAgentId: s.builderId,
      createdByRunId: a.runId, body: "Resubmitted for review.",
    });
    const heartbeat = heartbeatService(db);
    // The route's issue_assigned wake with a comment (routes/issues.ts:14944-14974).
    await heartbeat.wakeup(s.qaId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: s.cardId, commentId, mutation: "update", interruptedRunId: a.runId },
      requestedByActorType: "agent", requestedByActorId: s.builderId,
      contextSnapshot: { issueId: s.cardId, taskId: s.cardId, commentId, wakeCommentId: commentId, source: "issue.update", interruptedRunId: a.runId },
    });
    const parked = (await wakesFor(s, s.qaId)).at(-1)!;
    const parkedBrief = brief([parked])[0];

    // Restart shape: the builder's process and lease are gone, but the server
    // died before the executor's post-cleanup trigger ran, so nothing drained.
    // A fresh service instance runs scheduler ticks; no executor exists for A.
    await releaseLease(a.leaseId);
    const restarted = heartbeatService(db);
    const ticks: unknown[] = [];
    for (let i = 0; i < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      await restarted.resumeQueuedRuns();
      ticks.push(brief([await wakeById(parked.id)])[0]);
    }
    const qaRun = await claimedRun(s.qaId, s.cardId, [qaOld.runId], 5_000);
    console.log("POC T3b", JSON.stringify({ parked: parkedBrief, ticks, qaRun: qaRun?.id.slice(0, 8) ?? null,
      qaRunWake: qaRun?.wakeupRequestId?.slice(0, 8) ?? null }));

    expect(parked.status).toBe("deferred_issue_execution");
    expect(parkedBrief.ownerRunId).toBe(a.runId);
    expect(qaRun, `T3b stall: no QA run after 3 stranded ticks; ticks=${JSON.stringify(ticks)}`).toBeTruthy();
    expect(qaRun!.wakeupRequestId).toBe(parked.id);
    const final = await wakeById(parked.id);
    expect(final.status).not.toBe("deferred_issue_execution");
    expect(final.runId).toBe(qaRun!.id);
    // Exactly one new QA run.
    expect((await runsFor(s.qaId, s.cardId)).filter((r) => r.id !== qaOld.runId)).toHaveLength(1);
  }, 60_000);

  it("T5(ii) PAUSED: a parked review wake for a reviewer paused before release is failed at promotion, no run", async () => {
    const s = await seed();
    const stageId = await putInReview(s);
    const owner = await seedOwnerRun(s, s.builderId, { leaseActive: true });
    const heartbeat = heartbeatService(db);
    expect(await heartbeat.wakeup(s.qaId, reviewStageWake(s, stageId, owner.runId))).toBeNull();
    const parked = (await wakesFor(s, s.qaId)).at(-1)!;
    // The reviewer is paused while the wake is parked.
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, s.qaId));
    await releaseLease(owner.leaseId);
    await heartbeat.resumeQueuedRuns();
    const after = await wakeById(parked.id);
    const qaRuns = await runsFor(s.qaId, s.cardId);
    console.log("POC T5ii paused", JSON.stringify({ parked: brief([parked]), after: brief([after]), error: after.error, qaRuns: qaRuns.length }));
    expect(parked.status).toBe("deferred_issue_execution");
    expect(after.status).toBe("failed");
    expect(after.runId).toBeNull();
    expect(qaRuns).toHaveLength(0);
  }, 60_000);

  it("T5(iv) RACE: the cleanup trigger and the stranded drain on the same parked wake promote it once, one run", async () => {
    const s = await seed();
    const heartbeat = heartbeatService(db);
    await heartbeat.wakeup(s.builderId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: s.cardId, mutation: "update" },
      requestedByActorType: "system", requestedByActorId: "poc",
      contextSnapshot: { issueId: s.cardId, taskId: s.cardId, wakeReason: "issue_assigned", source: "issue.update" },
    });
    const b1 = await claimedRun(s.builderId, s.cardId, []);
    expect(b1, "builder run never reached the adapter").toBeTruthy();
    // Today's review handoff body through the real route (LOOP step 1).
    const h = await request(app(s.companyId, s.builderId, b1!.id)).patch(`/api/issues/${s.cardId}`).send({
      status: "in_review", comment: "handoff", assigneeAgentId: s.qaId,
      executionPolicy: { mode: "normal", stages: [{ type: "review", participants: [{ type: "agent", agentId: s.qaId }] }] },
    });
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    await waitFor(async () => (await wakesFor(s, s.qaId)).length > 0 || null, 5_000);
    const parked = (await wakesFor(s, s.qaId)).at(-1)!;
    const [cardRow] = await db.select().from(issues).where(eq(issues.id, s.cardId));
    const parkedBrief = { ...brief([parked])[0], leaseHeld: await leaseHeld(b1!.id), executionRunId: cardRow!.executionRunId };

    // Open the gate (executor cleanup: lease release, then the issue-wide
    // trigger) while stranded-drain ticks run back to back from two service
    // instances until the QA run exists.
    releaseCalls.length = 0;
    const tickers = [heartbeatService(db), heartbeatService(db)];
    let stop = false;
    let tickCount = 0;
    const loops = tickers.map(async (t) => {
      while (!stop) {
        await t.resumeQueuedRuns().catch(() => undefined);
        tickCount += 1;
      }
    });
    gateFor(b1!.id).open();
    const q1 = await claimedRun(s.qaId, s.cardId, [], 15_000);
    // Keep ticking briefly after the claim: a late second promoter must not win.
    await new Promise((r) => setTimeout(r, 750));
    stop = true;
    await Promise.all(loops);

    const qaRuns = await runsFor(s.qaId, s.cardId);
    const qaWakes = await wakesFor(s, s.qaId);
    const promoted = qaWakes.filter((w) => w.runId !== null);
    const forB1 = releaseCalls.filter((c) => c.runId === b1!.id);
    const callers = [...new Set(forB1.map((c) => c.caller))];
    const trig = forB1.filter((c) => c.caller === "cleanup_trigger");
    const strand = forB1.filter((c) => c.caller === "stranded_drain");
    const overlapped = trig.some((t) => strand.some((x) => x.start < (t.end || Infinity) && t.start < (x.end || Infinity)));
    console.log("POC T5iv race", JSON.stringify({
      parked: parkedBrief, tickCount, releaseCallsForOwner: forB1.length, callers,
      trigger: trig.length, stranded: strand.length, overlapped,
      qaRuns: qaRuns.map((r) => ({ id: r.id.slice(0, 8), wake: r.wakeupRequestId?.slice(0, 8) ?? null, status: r.status })),
      qaWakes: brief(qaWakes),
    }));
    expect(parked.status).toBe("deferred_issue_execution");
    expect(parkedBrief.ownerRunId).toBe(b1!.id);
    expect(q1, "RACE: no QA run claimed").toBeTruthy();
    // Both promoters reached the drain for the owner run.
    expect(trig.length).toBeGreaterThanOrEqual(1);
    expect(strand.length).toBeGreaterThanOrEqual(1);
    // Exactly one promotion and one run.
    expect(qaRuns).toHaveLength(1);
    expect(promoted).toHaveLength(1);
    expect(promoted[0]!.id).toBe(parked.id);
    expect(qaRuns[0]!.wakeupRequestId).toBe(parked.id);
  }, 60_000);

  it("T5(v) LIVE PID: a wake blocked by a live provider pid (lease released) stays parked while the pid lives and is promoted once it dies", async () => {
    const s = await seed();
    const stageId = await putInReview(s);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(child);
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    const owner = await seedOwnerRun(s, s.builderId, { leaseActive: false, processPid: child.pid! });
    const heartbeat = heartbeatService(db);
    expect(await heartbeat.wakeup(s.qaId, reviewStageWake(s, stageId, owner.runId))).toBeNull();
    const parked = (await wakesFor(s, s.qaId)).at(-1)!;
    await heartbeat.resumeQueuedRuns();
    const whileAlive = await wakeById(parked.id);
    const runsWhileAlive = (await runsFor(s.qaId, s.cardId)).length;
    child.kill("SIGKILL");
    await exited;
    await heartbeat.resumeQueuedRuns();
    const qaRun = await claimedRun(s.qaId, s.cardId, [], 5_000);
    const after = await wakeById(parked.id);
    console.log("POC T5v live pid", JSON.stringify({ parked: brief([parked]), whileAlive: brief([whileAlive]), runsWhileAlive,
      after: brief([after]), qaRun: qaRun?.id.slice(0, 8) ?? null }));
    expect(parked.status).toBe("deferred_issue_execution");
    expect(brief([parked])[0].ownerRunId).toBe(owner.runId);
    expect(whileAlive.status).toBe("deferred_issue_execution");
    expect(runsWhileAlive).toBe(0);
    expect(qaRun, "LIVE PID: no QA run after the pid died").toBeTruthy();
    expect(after.runId).toBe(qaRun!.id);
    expect((await runsFor(s.qaId, s.cardId))).toHaveLength(1);
  }, 60_000);
});
