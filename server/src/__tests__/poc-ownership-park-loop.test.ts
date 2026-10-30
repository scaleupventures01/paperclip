// agentos#1508 POC: "ownership park and release" plus role fixes R1/R2.
//
// Drives the whole builder to QA handoff loop with no manual step: every
// handoff goes through the REAL issue route (supertest PATCH as the agent's
// own run), the REAL heartbeat wakeup/admission/claim/execute/cleanup path
// and the real wake-queue drain. Only the adapter process and telemetry are
// mocked. The adapter's execute waits on a per-run gate, so each run is still
// inside its environment lease when it hands the card off; the gate is opened
// only after the handoff, which is the measured live race (2.7 s, 2.8 s).
// No recovery sweep and no stranded-queue tick is run inside the loop: each
// next run must be claimed from the handoff alone.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  createDb,
  environmentLeases,
  heartbeatRuns,
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

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (input?: unknown) => {
    const ctx = input as { runId?: string; onSpawn?: (m: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void> } | undefined;
    const runId = ctx?.runId ?? "";
    // A real provider child, as the live codex/claude adapters have, so the
    // route's reassignment Stop is an acknowledged process stop (live shape:
    // executionCancellation acknowledged + conversationContinuation).
    const { spawn } = await import("node:child_process");
    const { runningProcesses } = await import("../adapters/index.ts");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const entry = { child, graceSec: 1, processGroupId: null };
    (runningProcesses as Map<string, unknown>).set(runId, entry);
    if (ctx?.onSpawn && child.pid) await ctx.onSpawn({ pid: child.pid, processGroupId: null, startedAt: new Date().toISOString() });
    executeStarted.add(runId);
    await gateFor(runId).promise;
    if ((runningProcesses as Map<string, unknown>).get(runId) === entry) (runningProcesses as Map<string, unknown>).delete(runId);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Done.",
      provider: "test",
      model: "test-model",
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

import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { recoveryService } from "../services/recovery/service.ts";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping POC ownership park loop: ${support.reason ?? "unsupported environment"}`);
}

d("POC agentos#1508 ownership park and release: full builder to QA loop", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-poc-1508-");
    db = createDb(tempDb.connectionString);
    const now = new Date();
    await db.insert(authUsers).values({
      id: "responsible-user", name: "Responsible User", email: "responsible-user@example.test",
      emailVerified: true, createdAt: now, updatedAt: now,
    });
  }, 60_000);

  afterEach(async () => {
    for (const g of gates.values()) g.open();
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
    const prefix = `PK${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId, name: "POC Park Co", issuePrefix: prefix,
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
  async function runsFor(agentId: string, issueId: string) {
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, agentId));
    return rows.filter((r) => (r.contextSnapshot as Record<string, unknown> | null)?.issueId === issueId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }
  function brief(rows: Array<typeof agentWakeupRequests.$inferSelect>) {
    return rows.map((w) => ({
      id: w.id.slice(0, 8), status: w.status, reason: w.reason,
      ownerRunId: ((w.payload as Record<string, unknown>)?.executionWait as Record<string, unknown> | undefined)?.ownerRunId ?? null,
      runId: w.runId,
    }));
  }
  async function card(id: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, id));
    return row!;
  }
  async function leaseHeld(runId: string) {
    const rows = await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, runId));
    return rows.some((l) => l.releasedAt === null);
  }

  /** Waits for a new run of `agentId` on `issueId` (not in `known`) that reached the adapter. */
  async function claimedRun(agentId: string, issueId: string, known: string[], ms = 15_000) {
    return waitFor(async () => {
      const r = (await runsFor(agentId, issueId)).find((x) => !known.includes(x.id) && executeStarted.has(x.id));
      return r ?? null;
    }, ms);
  }

  const improverFix = (head: string) => JSON.stringify({
    schema: "agentos.improver-fix/v1", card: "POC", pr: "none", head_sha: head, classification: "SMALL",
    test: "marker comment by id", suites: "n/a", acceptance_command: "select the marker comment by id",
  });
  const qaReceipt = (verdict: "PASS" | "FAIL") => JSON.stringify({
    schema: "agentos.platform-qa-receipt/v1", card_id: "POC", pr: "none", head_sha: "none", base_sha: "none",
    verdict, negative_control: { command: "wrong id", at: "none", expected: "fail", observed: "fail" },
    checks: [], suites: { base: "n/a", head: "n/a" }, reason: verdict === "FAIL" ? "acceptance failed" : "",
  });

  it("LOOP: handoff, FAIL return, R1 resubmit, PASS finish with no human touch and no sweep", async () => {
    const s = await seed();
    const heartbeat = heartbeatService(db);
    const log = (label: string, v: unknown) => console.log(`POC ${label}`, JSON.stringify(v));

    // Step 0: the builder is woken on its card and is executing (lease held).
    await heartbeat.wakeup(s.builderId, {
      source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: s.cardId, mutation: "update" },
      requestedByActorType: "system", requestedByActorId: "poc",
      contextSnapshot: { issueId: s.cardId, taskId: s.cardId, wakeReason: "issue_assigned", source: "issue.update" },
    });
    const b1 = await claimedRun(s.builderId, s.cardId, []);
    expect(b1, "STEP 0: builder run never reached the adapter").toBeTruthy();
    log("step0", { builderRun: b1!.id.slice(0, 8), leaseHeld: await leaseHeld(b1!.id) });

    // Step 1: the builder hands the card to QA with today's role body
    // (agent-improver/AGENTS.md:65): in_review plus executionPolicy review stage.
    const h1 = await request(app(s.companyId, s.builderId, b1!.id)).patch(`/api/issues/${s.cardId}`).send({
      status: "in_review", comment: improverFix("none"), assigneeAgentId: s.qaId,
      executionPolicy: { mode: "normal", stages: [{ type: "review", participants: [{ type: "agent", agentId: s.qaId }] }] },
    });
    expect(h1.status, `STEP 1 handoff PATCH: ${JSON.stringify(h1.body)}`).toBe(200);
    // The stage wake is enqueued after the PATCH commits; wait for its row
    // (still inside the builder's lease) before letting cleanup run.
    await waitFor(async () => (await wakesFor(s, s.qaId)).length > 0 || null, 5_000);
    const qaWakesAfterHandoff = brief(await wakesFor(s, s.qaId));
    log("step1 wakes while builder lease held", { leaseHeld: await leaseHeld(b1!.id), qaWakes: qaWakesAfterHandoff });
    gateFor(b1!.id).open();
    const q1 = await claimedRun(s.qaId, s.cardId, []);
    log("step1 after builder cleanup", { qaRun: q1?.id.slice(0, 8) ?? null, qaWakes: brief(await wakesFor(s, s.qaId)) });
    expect(q1, `STEP 1 stall: no QA run claimed after the builder's lease was released; QA wakes=${JSON.stringify(brief(await wakesFor(s, s.qaId)))}`).toBeTruthy();
    expect(qaWakesAfterHandoff.at(-1)).toMatchObject({ status: "deferred_issue_execution", ownerRunId: b1!.id });

    // Step 2: QA sends the FAIL body (platform-qa/AGENTS.md:46).
    const f = await request(app(s.companyId, s.qaId, q1!.id)).patch(`/api/issues/${s.cardId}`).send({
      status: "todo", comment: qaReceipt("FAIL"), assigneeAgentId: s.builderId,
    });
    expect(f.status, `STEP 2 FAIL PATCH: ${JSON.stringify(f.body)}`).toBe(200);
    await waitFor(async () => (await wakesFor(s, s.builderId)).some((w) => w.reason !== "issue_assigned") || null, 5_000);
    const afterFail = await card(s.cardId);
    log("step2 card after FAIL", { status: afterFail.status, state: (afterFail.executionState as Record<string, unknown> | null)?.status, builderWakes: brief(await wakesFor(s, s.builderId)) });
    gateFor(q1!.id).open();
    const b2 = await claimedRun(s.builderId, s.cardId, [b1!.id]);
    log("step2 after QA cleanup", { builderRun: b2?.id.slice(0, 8) ?? null, builderWakes: brief(await wakesFor(s, s.builderId)) });
    expect(b2, `STEP 2 stall: no builder run claimed after QA's FAIL return; builder wakes=${JSON.stringify(brief(await wakesFor(s, s.builderId)))}`).toBeTruthy();

    // Step 3a (item 5): the OLD resubmit body (resends executionPolicy) is refused.
    const old = await request(app(s.companyId, s.builderId, b2!.id)).patch(`/api/issues/${s.cardId}`).send({
      status: "in_review", comment: improverFix("none"), assigneeAgentId: s.qaId,
      executionPolicy: { mode: "normal", stages: [{ type: "review", participants: [{ type: "agent", agentId: s.qaId }] }] },
    });
    log("step3a old resubmit", { status: old.status, error: old.body?.error ?? null, code: old.body?.details?.code ?? old.body?.code ?? null });
    expect(old.status).toBe(422);
    expect(JSON.stringify(old.body)).toContain("invalid_issue_disposition");

    // Step 3b: the NEW R1 resubmit body: in_review plus assignee, no executionPolicy.
    const r1 = await request(app(s.companyId, s.builderId, b2!.id)).patch(`/api/issues/${s.cardId}`).send({
      status: "in_review", comment: improverFix("none"), assigneeAgentId: s.qaId,
    });
    expect(r1.status, `STEP 3 R1 resubmit: ${JSON.stringify(r1.body)}`).toBe(200);
    await waitFor(async () => (await wakesFor(s, s.qaId)).length > 1 || null, 5_000);
    const afterResubmit = await card(s.cardId);
    log("step3 card after R1", { status: afterResubmit.status, state: afterResubmit.executionState, qaWakes: brief(await wakesFor(s, s.qaId)) });
    expect(afterResubmit.status).toBe("in_review");
    gateFor(b2!.id).open();
    const q2 = await claimedRun(s.qaId, s.cardId, [q1!.id]);
    log("step3 after builder cleanup", { qaRun: q2?.id.slice(0, 8) ?? null, qaWakes: brief(await wakesFor(s, s.qaId)) });
    expect(q2, `STEP 3 stall: no QA run claimed after the R1 resubmit; QA wakes=${JSON.stringify(brief(await wakesFor(s, s.qaId)))}`).toBeTruthy();

    // Step 4: QA sends the PASS body (platform-qa/AGENTS.md:40).
    const p = await request(app(s.companyId, s.qaId, q2!.id)).patch(`/api/issues/${s.cardId}`).send({
      status: "done", comment: qaReceipt("PASS"),
    });
    expect(p.status, `STEP 4 PASS PATCH: ${JSON.stringify(p.body)}`).toBe(200);
    const done = await card(s.cardId);
    gateFor(q2!.id).open();
    const managerWake = await waitFor(async () => (await wakesFor(s, s.managerId, s.parentId))
      .find((w) => w.reason === "issue_children_completed" || (w.payload as Record<string, unknown>)?.completedChildIssueId === s.cardId) ?? null);
    const m = await claimedRun(s.managerId, s.parentId, []);
    log("step4", { cardStatus: done.status, managerWakes: brief(await wakesFor(s, s.managerId, s.parentId)), managerRun: m?.id.slice(0, 8) ?? null });
    expect(done.status).toBe("done");
    expect(managerWake, "STEP 4: parent assignee was not woken").toBeTruthy();
    expect(m, "STEP 4: parent assignee run never claimed").toBeTruthy();
    expect((m!.contextSnapshot as Record<string, unknown>).wakeReason).toBe("issue_children_completed");

    // No recovery machinery was needed anywhere in the loop.
    const all = [
      ...(await wakesFor(s, s.qaId)), ...(await wakesFor(s, s.builderId)),
    ];
    const recoveryWakes = all.filter((w) => ["execution_review_participant_recovery", "issue_continuation_needed"].includes(w.reason ?? ""));
    const skipped = all.filter((w) => w.status === "skipped");
    log("loop summary", { recoveryWakes: recoveryWakes.length, skipped: brief(skipped), all: brief(all) });
    expect(recoveryWakes).toHaveLength(0);
    expect(skipped).toHaveLength(0);
  }, 120_000);

  // A terminal run on the card that still holds its environment lease. Used
  // by the bound and kill switch cases.
  // Live shape (pt2b d4.out): an acknowledged reassignment stop with the
  // conversation continuation policy.
  async function seedHeldOwner(s: Seed, ownerAgentId: string) {
    const ownerRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: ownerRunId, companyId: s.companyId, agentId: ownerAgentId, invocationSource: "automation",
      status: "cancelled", errorCode: "issue_reassigned", runtimeMode: "legacy",
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } },
      resultJson: { executionCancellation: { state: "acknowledged" }, reassignmentStopConfirmed: true, conversationContinuation: "continue_conversation_v1" },
      startedAt: new Date(Date.now() - 600_000), finishedAt: new Date(Date.now() - 5_000),
      contextSnapshot: { issueId: s.cardId },
    });
    const [lease] = await db.insert(environmentLeases).values({
      companyId: s.companyId, issueId: s.cardId, heartbeatRunId: ownerRunId, status: "active",
      leasePolicy: "ephemeral", provider: "local", acquiredAt: new Date(Date.now() - 600_000),
      lastUsedAt: new Date(Date.now() - 5_000), releasedAt: null, cleanupStatus: null,
    }).returning();
    return { ownerRunId, leaseId: lease!.id };
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
  function reviewStageWake(s: Seed, stageId: string, interruptedRunId: string) {
    const executionStage = { wakeRole: "reviewer", stageId, stageType: "review", allowedActions: ["approve", "request_changes"] };
    return {
      source: "assignment" as const, triggerDetail: "system" as const, reason: "execution_review_requested",
      payload: { issueId: s.cardId, mutation: "update", executionStage, interruptedRunId },
      requestedByActorType: "agent" as const, requestedByActorId: s.builderId,
      contextSnapshot: { issueId: s.cardId, taskId: s.cardId, wakeReason: "execution_review_requested", source: "issue.execution_stage", executionStage, interruptedRunId },
    };
  }

  it("BOUND: a parked ownership wake whose blocker clears but is never drained converts to the skip row after the bound", async () => {
    process.env.PAPERCLIP_OWNERSHIP_WAKE_PARK_MAX_MS = "1500";
    const s = await seed();
    const stageId = await putInReview(s);
    // Operator-stop shape: QA's own earlier run, acknowledged, card still QA's.
    // Pre-drain returns released for it (not a handoff), so the drain never promotes.
    const owner = await seedHeldOwner(s, s.qaId);
    const heartbeat = heartbeatService(db);
    expect(await heartbeat.wakeup(s.qaId, reviewStageWake(s, stageId, owner.ownerRunId))).toBeNull();
    const parked = (await wakesFor(s, s.qaId)).at(-1)!;
    expect(parked).toMatchObject({ status: "deferred_issue_execution" });
    expect((parked.payload as any).executionWait).toMatchObject({ cause: "execution_owner_active", ownerRunId: owner.ownerRunId });

    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "succeeded" })
      .where(eq(environmentLeases.id, owner.leaseId));
    await heartbeat.resumeQueuedRuns();
    const beforeBound = (await wakesFor(s, s.qaId)).at(-1)!;
    const sweepBefore = await recoveryService(db, { enqueueWakeup: async () => null } as never).reconcileStrandedAssignedIssues();
    await new Promise((r) => setTimeout(r, 1700));
    await heartbeat.resumeQueuedRuns();
    const afterBound = (await wakesFor(s, s.qaId)).at(-1)!;
    const sweepAfter = await recoveryService(db, { enqueueWakeup: async () => null } as never).reconcileStrandedAssignedIssues();
    console.log("POC bound", JSON.stringify({
      before: brief([beforeBound]), after: brief([afterBound]),
      sweepSeesCardBefore: sweepBefore.issueIds.includes(s.cardId), sweepSeesCardAfter: sweepAfter.issueIds.includes(s.cardId),
      sweepAfter,
    }));
    expect(beforeBound.status).toBe("deferred_issue_execution");
    expect(sweepBefore.issueIds).not.toContain(s.cardId);
    expect(afterBound).toMatchObject({ id: parked.id, status: "skipped", reason: "execution_reconciliation_required" });
    expect((afterBound.payload as any).executionWait.ownerRunId).toBe(owner.ownerRunId);

    // After the bound the card is in exactly today's state: the same fixture
    // with the kill switch off (today's skip at admission) gets the same
    // sweep outcome. (Operator-stop shape: neither path auto-resumes it.)
    process.env.PAPERCLIP_OWNERSHIP_WAKE_PARK = "0";
    const t = await seed();
    const tStage = await putInReview(t);
    const tOwner = await seedHeldOwner(t, t.qaId);
    expect(await heartbeat.wakeup(t.qaId, reviewStageWake(t, tStage, tOwner.ownerRunId))).toBeNull();
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "succeeded" })
      .where(eq(environmentLeases.id, tOwner.leaseId));
    const today = await recoveryService(db, { enqueueWakeup: async () => null } as never).reconcileStrandedAssignedIssues();
    delete process.env.PAPERCLIP_OWNERSHIP_WAKE_PARK;
    const pick = (r: typeof today, id: string) => ({ included: r.issueIds.includes(id), requeued: r.reviewParticipantRequeued, escalated: r.escalated });
    console.log("POC bound vs today", JSON.stringify({ bound: pick(sweepAfter, s.cardId), today: pick(today, t.cardId), todayRow: brief((await wakesFor(t, t.qaId)).slice(-1)) }));
    expect(pick(sweepAfter, s.cardId)).toEqual(pick(today, t.cardId));
    expect((await wakesFor(t, t.qaId)).at(-1)).toMatchObject({ status: "skipped", reason: "execution_reconciliation_required" });
  }, 60_000);

  it("GUARD: a parked review wake whose stage moved to another reviewer is cancelled at release, no run", async () => {
    const s = await seed();
    const stageId = await putInReview(s);
    const owner = await seedHeldOwner(s, s.builderId);
    const heartbeat = heartbeatService(db);
    expect(await heartbeat.wakeup(s.qaId, reviewStageWake(s, stageId, owner.ownerRunId))).toBeNull();
    // The stage now names a different participant (the manager).
    const [row] = await db.select().from(issues).where(eq(issues.id, s.cardId));
    await db.update(issues).set({ executionState: { ...(row!.executionState as Record<string, unknown>),
      currentParticipant: { type: "agent", agentId: s.managerId, userId: null } } }).where(eq(issues.id, s.cardId));
    await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "succeeded" })
      .where(eq(environmentLeases.id, owner.leaseId));
    await heartbeat.resumeQueuedRuns();
    const w = (await wakesFor(s, s.qaId)).at(-1)!;
    console.log("POC guard", JSON.stringify({ wake: brief([w]), error: w.error, qaRuns: (await runsFor(s.qaId, s.cardId)).length }));
    expect(w.status).toBe("cancelled");
    expect(w.error).toContain("Execution stage no longer pending");
    expect(await runsFor(s.qaId, s.cardId)).toHaveLength(0);
  }, 60_000);

  it("KILL SWITCH off: the same wake is written as today's skipped row", async () => {
    process.env.PAPERCLIP_OWNERSHIP_WAKE_PARK = "0";
    const s = await seed();
    const stageId = await putInReview(s);
    const owner = await seedHeldOwner(s, s.builderId);
    const heartbeat = heartbeatService(db);
    expect(await heartbeat.wakeup(s.qaId, reviewStageWake(s, stageId, owner.ownerRunId))).toBeNull();
    const w = (await wakesFor(s, s.qaId)).at(-1)!;
    console.log("POC kill switch off", JSON.stringify(brief([w])));
    expect(w).toMatchObject({ status: "skipped", reason: "execution_reconciliation_required" });
    expect((w.payload as any).executionWait?.ownerRunId ?? null).toBeNull();
    expect((w.payload as any).executionWait?.cause ?? null).toBeNull();

    process.env.PAPERCLIP_OWNERSHIP_WAKE_PARK = "1";
    const s2 = await seed();
    const stage2 = await putInReview(s2);
    const owner2 = await seedHeldOwner(s2, s2.builderId);
    expect(await heartbeat.wakeup(s2.qaId, reviewStageWake(s2, stage2, owner2.ownerRunId))).toBeNull();
    const w2 = (await wakesFor(s2, s2.qaId)).at(-1)!;
    console.log("POC kill switch on (control)", JSON.stringify(brief([w2])));
    expect(w2).toMatchObject({ status: "deferred_issue_execution" });
  }, 60_000);
});
