// agentos#1508 AC4 and agentos#1567: an agent cannot close a card whose review stage is open
// unless it is that stage's current participant, and cannot drop or replace an open review stage.
//
// Every request goes through the real issue route (supertest PATCH as the acting agent's own run)
// on embedded Postgres. AC4_POLICY_MODULE=deployed swaps in a deployed build of
// services/issue-execution-policy (services/issue-execution-policy.deployed.js, not committed) so
// the same cases can run against the runtime-patched module.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.mock("../services/issue-execution-policy.ts", async () => {
  if (process.env.AC4_POLICY_MODULE === "deployed") {
    // Optional local build artifact, present only in the evidence harness.
    const deployed = new URL("../services/issue-execution-policy.deployed.js", import.meta.url).href;
    return await import(/* @vite-ignore */ deployed);
  }
  return await vi.importActual("../services/issue-execution-policy.ts");
});
vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn(), hashPrivateRef: vi.fn(() => "x") }),
}));
vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({
        exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Done.",
        provider: "test", model: "test-model",
      })),
    })),
  };
});

import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  AGENT_SELF_CLOSE_GUARD_COMPANIES_ENV,
  AGENT_SELF_CLOSE_GUARD_ENV,
  agentSelfCloseGuardEnabled,
} from "../services/agent-self-close-guard.js";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
const MODULE = process.env.AC4_POLICY_MODULE === "deployed" ? "deployed" : "src";

describe("agentSelfCloseGuardEnabled", () => {
  it("is on by default and off for 0/false/off/no", () => {
    expect(agentSelfCloseGuardEnabled("c1", {})).toBe(true);
    expect(agentSelfCloseGuardEnabled("c1", { [AGENT_SELF_CLOSE_GUARD_ENV]: "1" })).toBe(true);
    for (const off of ["0", "false", "OFF", " no "]) {
      expect(agentSelfCloseGuardEnabled("c1", { [AGENT_SELF_CLOSE_GUARD_ENV]: off })).toBe(false);
    }
  });
  it("is limited to the listed companies when a scope is set", () => {
    const env = { [AGENT_SELF_CLOSE_GUARD_COMPANIES_ENV]: " c1 , c2 " };
    expect(agentSelfCloseGuardEnabled("c1", env)).toBe(true);
    expect(agentSelfCloseGuardEnabled("c3", env)).toBe(false);
    expect(agentSelfCloseGuardEnabled("c3", { [AGENT_SELF_CLOSE_GUARD_COMPANIES_ENV]: " , " })).toBe(true);
  });
});

d(`agent self-close guard through the issue route (${MODULE} policy module)`, () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  const receipts: Record<string, unknown> = {};

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-self-close-guard-");
    db = createDb(tempDb.connectionString);
    const now = new Date();
    await db.insert(authUsers).values({
      id: "responsible-user", name: "Responsible User", email: "responsible-user@example.test",
      emailVerified: true, createdAt: now, updatedAt: now,
    });
  }, 60_000);

  afterEach(() => {
    delete process.env[AGENT_SELF_CLOSE_GUARD_ENV];
    delete process.env[AGENT_SELF_CLOSE_GUARD_COMPANIES_ENV];
  });

  afterAll(async () => {
    console.log(`SELF CLOSE GUARD RECEIPTS ${MODULE} ${JSON.stringify(receipts)}`);
    await new Promise((r) => setTimeout(r, 300));
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const builderId = randomUUID();
    const qaId = randomUUID();
    const parentId = randomUUID();
    const prefix = `SG${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId, name: "Guard Co", issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user",
    });
    const base = { companyId, status: "idle", adapterType: "process", adapterConfig: {}, runtimeConfig: {} };
    await db.insert(agents).values([
      { ...base, id: managerId, name: "IT Manager", title: "IT Manager", role: "maintenance_manager",
        permissions: { canAssignTasks: true } },
      { ...base, id: builderId, name: "Builder", title: "Agent Improver", role: "engineer",
        reportsTo: managerId, permissions: {} },
      { ...base, id: qaId, name: "QA", title: "Platform QA", role: "tester",
        reportsTo: managerId, permissions: {} },
    ]);
    await db.insert(issues).values({
      id: parentId, companyId, title: "Manager card", status: "in_progress", priority: "medium",
      assigneeAgentId: managerId, issueNumber: 1, identifier: `${prefix}-1`,
    });
    return { companyId, managerId, builderId, qaId, parentId, prefix };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;

  const runs = new Map<string, string>();
  async function runOf(s: Seed, agentId: string, issueId: string) {
    const key = `${agentId}:${issueId}`;
    const known = runs.get(key);
    if (known) return known;
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id, companyId: s.companyId, agentId, invocationSource: "assignment", status: "running",
      startedAt: new Date(), contextSnapshot: { issueId, taskId: issueId },
    });
    runs.set(key, id);
    return id;
  }
  function app(actor: Record<string, unknown>) {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    a.use("/api", issueRoutes(db, {} as any, {}));
    a.use(errorHandler);
    return request(a);
  }
  async function checkout(s: Seed, agentId: string, id: string) {
    const fresh = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: fresh, companyId: s.companyId, agentId, invocationSource: "assignment", status: "running",
      startedAt: new Date(), contextSnapshot: { issueId: id, taskId: id },
    });
    await db.update(issues).set({ checkoutRunId: fresh, executionRunId: fresh }).where(eq(issues.id, id));
    runs.set(`${agentId}:${id}`, fresh);
    return fresh;
  }
  async function patch(s: Seed, agentId: string, id: string, body: Record<string, unknown>) {
    const c = await card(id);
    let runId = await runOf(s, agentId, id);
    if (c.status === "in_progress" && c.assigneeAgentId === agentId && c.checkoutRunId !== runId) {
      runId = await checkout(s, agentId, id);
    }
    return app({ type: "agent", source: "agent_key", companyId: s.companyId, agentId, runId })
      .patch(`/api/issues/${id}`).send(body);
  }
  function boardPatch(s: Seed, id: string, body: Record<string, unknown>) {
    return app({ type: "board", userId: "local-board", source: "local_implicit", companyIds: [s.companyId],
      isInstanceAdmin: false }).patch(`/api/issues/${id}`).send(body);
  }
  async function card(id: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, id));
    return row!;
  }
  const state = (row: { executionState: unknown }) => (row.executionState ?? null) as Record<string, any> | null;

  const reviewPolicy = (s: Seed) => ({
    mode: "normal", maxReviewRounds: 2,
    stages: [{ type: "review", participants: [
      { type: "agent", agentId: s.qaId }, { type: "agent", agentId: s.managerId },
    ] }],
  });
  const fix = JSON.stringify({ schema: "agentos.improver-fix/v1", pr: "none" });
  const handoff = (s: Seed) => ({ status: "in_review", comment: fix, assigneeAgentId: s.qaId });
  const qaFail = (s: Seed) => ({ status: "todo", comment: "FAIL: acceptance failed", assigneeAgentId: s.builderId });
  const qaPass = { status: "done", comment: "PASS at head" };
  const selfClose = { status: "done", comment: "self-close attempt" };

  // A build card created by the manager with the review stage, checked out by the builder.
  async function buildCard(s: Seed, policy: Record<string, unknown> | null = reviewPolicy(s)) {
    const res = await app({ type: "agent", source: "agent_key", companyId: s.companyId, agentId: s.managerId,
      runId: await runOf(s, s.managerId, s.parentId) })
      .post(`/api/companies/${s.companyId}/issues`)
      .send({ parentId: s.parentId, title: `Build: fix ${randomUUID().slice(0, 8)}`, description: "what must change", assigneeAgentId: s.builderId,
        status: "todo", ...(policy ? { executionPolicy: policy } : {}) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, res.body.id));
    await checkout(s, s.builderId, res.body.id);
    return res.body.id as string;
  }
  async function toPending(s: Seed, id: string) {
    const h = await patch(s, s.builderId, id, handoff(s));
    expect(h.status, `handoff: ${JSON.stringify(h.body)}`).toBe(200);
  }
  async function qaFails(s: Seed, id: string) {
    const f = await patch(s, s.qaId, id, qaFail(s));
    expect(f.status, `QA FAIL: ${JSON.stringify(f.body)}`).toBe(200);
  }
  function snapshot(row: Awaited<ReturnType<typeof card>>) {
    return JSON.stringify({ status: row.status, assigneeAgentId: row.assigneeAgentId,
      executionState: row.executionState, executionPolicy: row.executionPolicy });
  }

  // ---- A: agentos#1508 AC4 ------------------------------------------------------------------
  it("A: the builder's done before any review stage ran is refused 422 self_close_refused, card unchanged", async () => {
    const s = await seed();
    const id = await buildCard(s);
    const before = snapshot(await card(id));
    const r = await patch(s, s.builderId, id, selfClose);
    receipts.A_no_stage = { http: r.status, body: r.body };
    expect(r.status).toBe(422);
    expect(r.body.details?.code).toBe("self_close_refused");
    expect(r.body.error).toContain("review stage 1 of 1");
    expect(snapshot(await card(id))).toBe(before);
  });

  it("A: the builder's done while Platform QA holds the pending stage is refused 422 self_close_refused", async () => {
    const s = await seed();
    const id = await buildCard(s);
    await toPending(s, id);
    const before = snapshot(await card(id));
    const r = await patch(s, s.builderId, id, selfClose);
    receipts.A_pending = { http: r.status, code: r.body.details?.code };
    expect(r.status).toBe(422);
    expect(r.body.details?.code).toBe("self_close_refused");
    expect(snapshot(await card(id))).toBe(before);
  });

  it("A: the builder's done in changes_requested (after a QA FAIL) is refused 422 self_close_refused", async () => {
    const s = await seed();
    const id = await buildCard(s);
    await toPending(s, id);
    await qaFails(s, id);
    expect(state(await card(id))?.status).toBe("changes_requested");
    const before = snapshot(await card(id));
    const r = await patch(s, s.builderId, id, selfClose);
    receipts.A_changes_requested = { http: r.status, code: r.body.details?.code };
    expect(r.status).toBe(422);
    expect(r.body.details?.code).toBe("self_close_refused");
    expect(snapshot(await card(id))).toBe(before);
  });

  // ---- B: agentos#1567 ----------------------------------------------------------------------
  it("B: the builder's executionPolicy null plus done in one request is refused 422, card unchanged", async () => {
    const s = await seed();
    const id = await buildCard(s);
    const before = snapshot(await card(id));
    const r = await patch(s, s.builderId, id, { ...selfClose, executionPolicy: null });
    receipts.B_null_and_done = { http: r.status, code: r.body.details?.code };
    expect(r.status).toBe(422);
    expect(r.body.details?.code).toBe("review_policy_change_refused");
    expect(snapshot(await card(id))).toBe(before);
  });

  it("B: the builder's executionPolicy null alone is refused 422", async () => {
    const s = await seed();
    const id = await buildCard(s);
    await toPending(s, id);
    const before = snapshot(await card(id));
    const r = await patch(s, s.builderId, id, { executionPolicy: null });
    expect(r.status).toBe(422);
    expect(r.body.details?.code).toBe("review_policy_change_refused");
    expect(snapshot(await card(id))).toBe(before);
  });

  it("B: replacing the policy with one that drops a reviewer is refused 422", async () => {
    const s = await seed();
    const id = await buildCard(s);
    const r = await patch(s, s.builderId, id, { ...handoff(s),
      executionPolicy: { mode: "normal", stages: [{ type: "review", participants: [{ type: "agent", agentId: s.qaId }] }] } });
    expect(r.status).toBe(422);
    expect(r.body.details?.code).toBe("review_policy_change_refused");
  });

  it("B: replacing the policy with one that adds the builder as its own reviewer is refused 422", async () => {
    const s = await seed();
    const id = await buildCard(s);
    const policy = reviewPolicy(s);
    policy.stages[0]!.participants.push({ type: "agent", agentId: s.builderId });
    const r = await patch(s, s.builderId, id, { executionPolicy: policy });
    expect(r.status).toBe(422);
    expect(r.body.details?.code).toBe("review_policy_change_refused");
  });

  it("B: re-sending the same reviewers is still allowed (no removal)", async () => {
    const s = await seed();
    const id = await buildCard(s);
    const r = await patch(s, s.builderId, id, { ...handoff(s), executionPolicy: reviewPolicy(s) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await card(id)).status).toBe("in_review");
  });

  // ---- C: kill switch and company scope ------------------------------------------------------
  it("C: PAPERCLIP_AGENT_SELF_CLOSE_GUARD=0 restores the old behaviour (done converts to in_review, null closes)", async () => {
    process.env[AGENT_SELF_CLOSE_GUARD_ENV] = "0";
    const s = await seed();
    const id = await buildCard(s);
    const r = await patch(s, s.builderId, id, selfClose);
    const c = await card(id);
    const id2 = await buildCard(s);
    const r2 = await patch(s, s.builderId, id2, { ...selfClose, executionPolicy: null });
    const c2 = await card(id2);
    receipts.C_switch_off = { conversion: { http: r.status, status: c.status }, nullClose: { http: r2.status, status: c2.status } };
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(c.status).toBe("in_review");
    expect(c.assigneeAgentId).toBe(s.qaId);
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect(c2.status).toBe("done");
  });

  it("C: a company scope that does not list this company leaves the old behaviour", async () => {
    process.env[AGENT_SELF_CLOSE_GUARD_COMPANIES_ENV] = randomUUID();
    const s = await seed();
    const id = await buildCard(s);
    const r = await patch(s, s.builderId, id, selfClose);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await card(id)).status).toBe("in_review");
  });

  it("C: a company scope that lists this company keeps the refusal", async () => {
    const s = await seed();
    process.env[AGENT_SELF_CLOSE_GUARD_COMPANIES_ENV] = `${randomUUID()},${s.companyId}`;
    const id = await buildCard(s);
    const r = await patch(s, s.builderId, id, selfClose);
    expect(r.status).toBe(422);
    expect(r.body.details?.code).toBe("self_close_refused");
  });

  // ---- D: the cancel detour (fix round 1, verifier probes P13, P6, P11) ----------------------
  const cancel = { status: "cancelled", comment: "cancel" };

  it("D: after a QA FAIL, cancel then executionPolicy null then done never ends done (P13)", async () => {
    const s = await seed();
    const id = await buildCard(s);
    await toPending(s, id);
    await qaFails(s, id);
    const r1 = await patch(s, s.builderId, id, cancel);
    const r2 = await patch(s, s.builderId, id, { executionPolicy: null });
    const r3 = await patch(s, s.builderId, id, selfClose);
    const c = await card(id);
    receipts.D_p13 = { cancel: r1.status, nullPolicy: [r2.status, r2.body.details?.code],
      done: [r3.status, r3.body.details?.code], status: c.status };
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r2.status).toBe(422);
    expect(r2.body.details?.code).toBe("review_policy_change_refused");
    expect(r3.status).toBe(422);
    expect(r3.body.details?.code).toBe("self_close_refused");
    expect(c.status).toBe("cancelled");
    expect(c.executionPolicy).not.toBeNull();
  });

  it("D: before any handoff, cancel then null then reopen then done never ends done (P6)", async () => {
    const s = await seed();
    const id = await buildCard(s);
    const r1 = await patch(s, s.builderId, id, cancel);
    const r2 = await patch(s, s.builderId, id, { executionPolicy: null });
    const r3 = await patch(s, s.builderId, id, { status: "todo", comment: "reopen" });
    const r4 = await patch(s, s.builderId, id, selfClose);
    const c = await card(id);
    receipts.D_p6 = { cancel: r1.status, nullPolicy: [r2.status, r2.body.details?.code], reopen: r3.status,
      done: [r4.status, r4.body.details?.code], status: c.status };
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(r2.status).toBe(422);
    expect(r2.body.details?.code).toBe("review_policy_change_refused");
    expect(r4.status).toBe(422);
    expect(r4.body.details?.code).toBe("self_close_refused");
    expect(c.status).not.toBe("done");
    expect(c.executionPolicy).not.toBeNull();
  });

  it("D: cancel then done directly is refused 422 self_close_refused, before handoff and after a FAIL", async () => {
    const s = await seed();
    const id = await buildCard(s);
    expect((await patch(s, s.builderId, id, cancel)).status).toBe(200);
    const before = snapshot(await card(id));
    const r = await patch(s, s.builderId, id, selfClose);
    receipts.D_cancel_done = { http: r.status, code: r.body.details?.code, status: (await card(id)).status };
    expect(r.status).toBe(422);
    expect(r.body.details?.code).toBe("self_close_refused");
    expect(snapshot(await card(id))).toBe(before);

    const id2 = await buildCard(s);
    await toPending(s, id2);
    await qaFails(s, id2);
    expect((await patch(s, s.builderId, id2, cancel)).status).toBe(200);
    const r2 = await patch(s, s.builderId, id2, selfClose);
    expect(r2.status).toBe(422);
    expect(r2.body.details?.code).toBe("self_close_refused");
    expect((await card(id2)).status).toBe("cancelled");
  });

  it("D: an agent may still cancel in changes_requested (cancelled is not done); the board may close a cancelled card", async () => {
    const s = await seed();
    const id = await buildCard(s);
    await toPending(s, id);
    await qaFails(s, id);
    const r1 = await patch(s, s.builderId, id, cancel);
    const c = await card(id);
    receipts.D_cancel_allowed = { cancel: r1.status, status: c.status };
    expect(r1.status, JSON.stringify(r1.body)).toBe(200);
    expect(c.status).toBe("cancelled");
    expect(c.executionPolicy).not.toBeNull();

    const id2 = await buildCard(s);
    expect((await patch(s, s.builderId, id2, cancel)).status).toBe(200);
    // The guard never checks the board; the transition's own handling of a board done applies.
    const b = await boardPatch(s, id2, { status: "done", comment: "board closes it" });
    receipts.D_board_on_cancelled = { http: b.status, status: (await card(id2)).status };
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    expect(b.body.details?.code).toBeUndefined();
  });

  it("D: PAPERCLIP_AGENT_SELF_CLOSE_GUARD=0 leaves the cancel detour as before (switch still works)", async () => {
    process.env[AGENT_SELF_CLOSE_GUARD_ENV] = "0";
    const s = await seed();
    const id = await buildCard(s);
    expect((await patch(s, s.builderId, id, cancel)).status).toBe(200);
    expect((await patch(s, s.builderId, id, { executionPolicy: null })).status).toBe(200);
    const r = await patch(s, s.builderId, id, selfClose);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await card(id)).status).toBe("done");
  });

  // ---- unaffected paths ---------------------------------------------------------------------
  it("board: a board done on a pending review stage and a board policy null keep today's behaviour", async () => {
    const s = await seed();
    const id = await buildCard(s);
    await toPending(s, id);
    const r = await boardPatch(s, id, { status: "done", comment: "board closes it" });
    receipts.board_done = { http: r.status, status: (await card(id)).status };
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await card(id)).status).toBe("done");
    const id2 = await buildCard(s);
    const r2 = await boardPatch(s, id2, { executionPolicy: null });
    expect(r2.status, JSON.stringify(r2.body)).toBe(200);
    expect((await card(id2)).executionPolicy).toBeNull();
  });

  it("Platform QA's PASS done as the stage's current participant still closes the card", async () => {
    const s = await seed();
    const id = await buildCard(s);
    await toPending(s, id);
    const r = await patch(s, s.qaId, id, qaPass);
    receipts.qa_pass = { http: r.status, status: (await card(id)).status };
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await card(id)).status).toBe("done");
  });

  it("the builder's handoff with status in_review (no executionPolicy) still starts the stage at Platform QA", async () => {
    const s = await seed();
    const id = await buildCard(s);
    const r = await patch(s, s.builderId, id, handoff(s));
    const c = await card(id);
    receipts.handoff = { http: r.status, status: c.status };
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(c.status).toBe("in_review");
    expect(state(c)?.currentParticipant?.agentId).toBe(s.qaId);
  });

  it("the builder's resubmit after a FAIL (in_review, no policy) is still accepted", async () => {
    const s = await seed();
    const id = await buildCard(s);
    await toPending(s, id);
    await qaFails(s, id);
    const r = await patch(s, s.builderId, id, handoff(s));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await card(id)).status).toBe("in_review");
  });

  it("the IT Manager closing its own card with no review policy done is still allowed", async () => {
    const s = await seed();
    const r = await patch(s, s.managerId, s.parentId, { status: "done", comment: "re-checked: merged" });
    receipts.manager_own_card = { http: r.status, status: (await card(s.parentId)).status };
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await card(s.parentId)).status).toBe("done");
  });

  it("an agent closing a card with no executionPolicy (a merge card) done is still allowed", async () => {
    const s = await seed();
    const id = await buildCard(s, null);
    const r = await patch(s, s.builderId, id, { status: "done", comment: "merged" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await card(id)).status).toBe("done");
  });

  it("the escalated holder (IT Manager after two FAILs) is the current participant and may still decide done", async () => {
    const s = await seed();
    // Only the runtime-patched module (review escalation patch v2) hands the stage to the next
    // participant; the fork's src module escalates to the responsible human instead.
    if (MODULE === "src") return;
    const id = await buildCard(s);
    await toPending(s, id); await qaFails(s, id); await toPending(s, id); await qaFails(s, id);
    expect(state(await card(id))?.currentParticipant?.agentId).toBe(s.managerId);
    const r =await patch(s, s.managerId, id, { status: "done", comment: "re-ran acceptance: pass" });
    receipts.escalated_holder_done = { http: r.status, status: (await card(id)).status };
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await card(id)).status).toBe("done");
  });

  // ---- E: agentos#1567 residuals (verify72r2 R1, R3b, R4, R9) -------------------------------
  // Every E card is approved first: build card, builder in_review handoff, QA PASS done.
  async function approvedDoneCard(s: Seed) {
    const id = await buildCard(s);
    await toPending(s, id);
    const q = await patch(s, s.qaId, id, qaPass);
    expect(q.status, `QA PASS: ${JSON.stringify(q.body)}`).toBe(200);
    const c = await card(id);
    expect(c.status).toBe("done");
    expect(state(c)?.status).toBe("completed");
    expect(c.executionPolicy).not.toBeNull();
    return id;
  }
  async function comment(s: Seed, agentId: string, id: string, body: Record<string, unknown>) {
    const runId = await runOf(s, agentId, id);
    return app({ type: "agent", source: "agent_key", companyId: s.companyId, agentId, runId })
      .post(`/api/issues/${id}/comments`).send(body);
  }
  const reopenTodoNull = { status: "todo", executionPolicy: null, comment: "reopen for follow-up" };

  it("E1 (R1): on an approved done card the builder's {todo, executionPolicy null} is refused 422 review_policy_change_refused; card stays done with its policy", async () => {
    const s = await seed();
    const id = await approvedDoneCard(s);
    const before = snapshot(await card(id));
    const r = await patch(s, s.builderId, id, reopenTodoNull);
    const c = await card(id);
    receipts.E1 = { http: r.status, code: r.body.details?.code ?? null, status: c.status, policyNull: c.executionPolicy === null };
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.details?.code).toBe("review_policy_change_refused");
    expect(c.status).toBe("done");
    expect(c.executionPolicy).not.toBeNull();
    expect(snapshot(c)).toBe(before);
  });

  it("E2 (R3b): on an approved done card the builder's executionPolicy null alone is refused 422 review_policy_change_refused; policy kept", async () => {
    const s = await seed();
    const id = await approvedDoneCard(s);
    const before = snapshot(await card(id));
    const r = await patch(s, s.builderId, id, { executionPolicy: null });
    const c = await card(id);
    receipts.E2 = { http: r.status, code: r.body.details?.code ?? null, status: c.status, policyNull: c.executionPolicy === null };
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.details?.code).toBe("review_policy_change_refused");
    expect(c.executionPolicy).not.toBeNull();
    expect(snapshot(c)).toBe(before);
  });

  it("E3a (R4): the builder's comment reopen on an approved done card clears the completed state, and its next done is refused", async () => {
    const s = await seed();
    const id = await approvedDoneCard(s);
    const r1 = await comment(s, s.builderId, id, { body: "reopening to fix a follow-up", reopen: true });
    const mid = await card(id);
    const r2 = await patch(s, s.builderId, id, selfClose);
    const c = await card(id);
    receipts.E3a = { reopen: r1.status, midStatus: mid.status, midState: state(mid)?.status ?? null,
      done: [r2.status, r2.body.details?.code ?? null], status: c.status };
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    expect(mid.status).toBe("todo");
    expect(state(mid)?.status ?? null).not.toBe("completed");
    expect(r2.status, JSON.stringify(r2.body)).toBe(422);
    expect(r2.body.details?.code).toBe("self_close_refused");
    expect(c.status).not.toBe("done");
  });

  // E3b is the post-fix requirement for a comment reopen: a fresh review runs and the reviewer
  // closes it. It is not required to be RED at base; the report records its base result.
  it("E3b (R4): after a comment reopen the builder's in_review handoff starts a fresh review and the reviewer's done closes it", async () => {
    const s = await seed();
    const id = await approvedDoneCard(s);
    const r1 = await comment(s, s.builderId, id, { body: "reopening to fix a follow-up", reopen: true });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    const h = await patch(s, s.builderId, id, handoff(s));
    const mid = await card(id);
    receipts.E3b_handoff = { http: h.status, code: h.body.details?.code ?? null, status: mid.status,
      state: state(mid)?.status ?? null, current: state(mid)?.currentParticipant?.agentId ?? null };
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    expect(mid.status).toBe("in_review");
    expect(state(mid)?.status).toBe("pending");
    expect(state(mid)?.currentParticipant?.agentId).toBe(s.qaId);
    const q = await patch(s, s.qaId, id, qaPass);
    const c = await card(id);
    receipts.E3b_pass = { http: q.status, status: c.status, state: state(c)?.status ?? null };
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect(c.status).toBe("done");
  });

  it("E4 (R9): after a QA FAIL the builder's re-post of the same reviewers with new stage ids is refused 422; round count kept", async () => {
    const s = await seed();
    const id = await buildCard(s);
    await toPending(s, id);
    await qaFails(s, id);
    const pre = await card(id);
    expect(state(pre)?.status).toBe("changes_requested");
    const rounds = state(pre)?.changesRequestedCount;
    expect(rounds).toBe(1);
    const before = snapshot(pre);
    // reviewPolicy(s) carries no stage ids, so the server mints new ones.
    const r = await patch(s, s.builderId, id, { executionPolicy: reviewPolicy(s) });
    const c = await card(id);
    receipts.E4 = { http: r.status, code: r.body.details?.code ?? null, state: state(c)?.status ?? null,
      rounds: state(c)?.changesRequestedCount ?? null };
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.details?.code).toBe("review_policy_change_refused");
    expect(state(c)?.status).toBe("changes_requested");
    expect(state(c)?.changesRequestedCount).toBe(rounds);
    expect(snapshot(c)).toBe(before);
  });

  // ---- E5: must stay green (base and after the fix) -----------------------------------------
  it("E5: the board may still null the policy on an approved done card", async () => {
    const s = await seed();
    const id = await approvedDoneCard(s);
    const r = await boardPatch(s, id, { executionPolicy: null });
    const c = await card(id);
    receipts.E5_board_null = { http: r.status, status: c.status, policyNull: c.executionPolicy === null };
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(c.executionPolicy).toBeNull();
  });

  it("E5: QA and the builder re-sending the identical policy (same stage ids) on an approved done card is 200", async () => {
    const s = await seed();
    const id = await approvedDoneCard(s);
    const stored = (await card(id)).executionPolicy as Record<string, any>;
    expect(stored.stages[0].id).toBeTruthy();
    const rq = await patch(s, s.qaId, id, { executionPolicy: stored });
    const rb = await patch(s, s.builderId, id, { executionPolicy: stored });
    const c = await card(id);
    receipts.E5_identical_on_done = { qa: rq.status, builder: rb.status, status: c.status };
    expect(rq.status, JSON.stringify(rq.body)).toBe(200);
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    expect(c.status).toBe("done");
    expect((c.executionPolicy as Record<string, any>).stages[0].id).toBe(stored.stages[0].id);
  });

  it("E5: the builder re-sending the identical policy (same stage ids) after a QA FAIL is 200 and keeps the round count", async () => {
    const s = await seed();
    const id = await buildCard(s);
    await toPending(s, id);
    await qaFails(s, id);
    const pre = await card(id);
    const stored = pre.executionPolicy as Record<string, any>;
    const r = await patch(s, s.builderId, id, { executionPolicy: stored });
    const c = await card(id);
    receipts.E5_identical_after_fail = { http: r.status, state: state(c)?.status ?? null, rounds: state(c)?.changesRequestedCount ?? null };
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(state(c)?.status).toBe("changes_requested");
    expect(state(c)?.changesRequestedCount).toBe(state(pre)?.changesRequestedCount);
  });

  it("E5: PAPERCLIP_AGENT_SELF_CLOSE_GUARD=0 restores the old behaviour for E1, E2 and E4", async () => {
    process.env[AGENT_SELF_CLOSE_GUARD_ENV] = "0";
    const s = await seed();
    const id1 = await approvedDoneCard(s);
    const a1 = await patch(s, s.builderId, id1, reopenTodoNull);
    const a2 = await patch(s, s.builderId, id1, selfClose);
    const c1 = await card(id1);
    const id2 = await approvedDoneCard(s);
    const b1 = await patch(s, s.builderId, id2, { executionPolicy: null });
    const c2 = await card(id2);
    const id4 = await buildCard(s);
    await toPending(s, id4);
    await qaFails(s, id4);
    const d1 = await patch(s, s.builderId, id4, { executionPolicy: reviewPolicy(s) });
    receipts.E5_switch_off = { e1: [a1.status, a2.status, c1.status], e2: [b1.status, c2.executionPolicy === null], e4: d1.status };
    expect(a1.status, JSON.stringify(a1.body)).toBe(200);
    expect(a2.status, JSON.stringify(a2.body)).toBe(200);
    expect(c1.status).toBe("done");
    expect(b1.status, JSON.stringify(b1.body)).toBe(200);
    expect(c2.executionPolicy).toBeNull();
    expect(d1.status, JSON.stringify(d1.body)).toBe(200);
  });

  it("E5: a normal FAIL, resubmit in_review, PASS done chain is 200 throughout", async () => {
    const s = await seed();
    const id = await buildCard(s);
    await toPending(s, id);
    await qaFails(s, id);
    const h = await patch(s, s.builderId, id, handoff(s));
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    expect(state(await card(id))?.currentParticipant?.agentId).toBe(s.qaId);
    const q = await patch(s, s.qaId, id, qaPass);
    receipts.E5_fail_resubmit_pass = { handoff: h.status, pass: q.status, status: (await card(id)).status };
    expect(q.status, JSON.stringify(q.body)).toBe(200);
    expect((await card(id)).status).toBe("done");
  });

  // ---- F: agentos#1567 fix round 1 (verify-1567 X8, X8c, X1r, X7r_freshRun) -----------------
  // A new heartbeat run for the actor, so the closing run's same-run exemptions do not apply.
  async function freshRunFor(s: Seed, agentId: string, id: string) {
    const fresh = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: fresh, companyId: s.companyId, agentId, invocationSource: "assignment", status: "running",
      startedAt: new Date(), contextSnapshot: { issueId: id, taskId: id },
    });
    runs.set(`${agentId}:${id}`, fresh);
    return fresh;
  }
  const doneWithoutReview = (c: Awaited<ReturnType<typeof card>>, approvedStageIds: string[]) =>
    c.status === "done" && (c.executionPolicy === null ||
      ((c.executionPolicy as Record<string, any>).stages ?? []).some((x: any) => x.type === "review" && !approvedStageIds.includes(x.id)));

  for (const actorName of ["builder", "qa"] as const) {
    it(`F1 (X8 ${actorName}): approved done card, cancel, then executionPolicy null is refused 422; the chain never ends done without review`, async () => {
      const s = await seed();
      const id = await approvedDoneCard(s);
      const approved = ((await card(id)).executionPolicy as Record<string, any>).stages.map((x: any) => x.id);
      const a = actorName === "builder" ? s.builderId : s.qaId;
      await freshRunFor(s, a, id);
      const r1 = await patch(s, a, id, cancel);
      expect(r1.status, JSON.stringify(r1.body)).toBe(200);
      const r2 = await patch(s, a, id, { executionPolicy: null });
      const r3 = await patch(s, a, id, selfClose);
      const r4 = await patch(s, a, id, { status: "todo", comment: "reopen for new work" });
      const r5 = await patch(s, a, id, { status: "done", comment: "new work shipped" });
      const c = await card(id);
      receipts[`F1_${actorName}`] = { cancel: r1.status, nul: [r2.status, r2.body.details?.code ?? null], done1: r3.status,
        reopen: r4.status, done2: [r5.status, r5.body.details?.code ?? null], status: c.status, policyNull: c.executionPolicy === null };
      expect(r2.status, JSON.stringify(r2.body)).toBe(422);
      expect(r2.body.details?.code).toBe("review_policy_change_refused");
      expect(c.executionPolicy).not.toBeNull();
      expect(doneWithoutReview(c, approved)).toBe(false);
      expect(r5.status).toBe(422);
    });
  }

  it("F2 (X8c): approved done card, cancel, then replacing the reviewers with a manager-only stage is refused 422; never done with an unapproved stage", async () => {
    const s = await seed();
    const id = await approvedDoneCard(s);
    const approved = ((await card(id)).executionPolicy as Record<string, any>).stages.map((x: any) => x.id);
    await freshRunFor(s, s.builderId, id);
    expect((await patch(s, s.builderId, id, cancel)).status).toBe(200);
    const r1 = await patch(s, s.builderId, id, { executionPolicy: { mode: "normal",
      stages: [{ type: "review", participants: [{ type: "agent", agentId: s.managerId }] }] } });
    const r2 = await patch(s, s.builderId, id, selfClose);
    const c = await card(id);
    receipts.F2 = { replace: [r1.status, r1.body.details?.code ?? null], done: r2.status, status: c.status };
    expect(r1.status, JSON.stringify(r1.body)).toBe(422);
    expect(r1.body.details?.code).toBe("review_policy_change_refused");
    expect(doneWithoutReview(c, approved)).toBe(false);
  });

  it("F3 (X1r): approved done card, cancel, null refused, comment resume (fresh run), done refused", async () => {
    const s = await seed();
    const id = await approvedDoneCard(s);
    const approved = ((await card(id)).executionPolicy as Record<string, any>).stages.map((x: any) => x.id);
    await freshRunFor(s, s.builderId, id);
    expect((await patch(s, s.builderId, id, cancel)).status).toBe(200);
    const r1 = await patch(s, s.builderId, id, { executionPolicy: null });
    await freshRunFor(s, s.builderId, id);
    const r2 = await comment(s, s.builderId, id, { body: "resume", resume: true });
    const r3 = await patch(s, s.builderId, id, selfClose);
    const c = await card(id);
    receipts.F3 = { nul: [r1.status, r1.body.details?.code ?? null], resume: r2.status, done: [r3.status, r3.body.details?.code ?? null], status: c.status };
    expect(r1.status, JSON.stringify(r1.body)).toBe(422);
    expect(r1.body.details?.code).toBe("review_policy_change_refused");
    expect(c.executionPolicy).not.toBeNull();
    expect(doneWithoutReview(c, approved)).toBe(false);
    expect(r3.status).toBe(422);
  });

  it("F4 (X7r_freshRun): after QA FAIL 1, cancel and comment resume (fresh run) keep the round count, so FAIL 2 escalates to the responsible user", async () => {
    const s = await seed();
    const id = await buildCard(s);
    await db.update(issues).set({ responsibleUserId: "responsible-user" } as any).where(eq(issues.id, id));
    await db.insert(companyMemberships).values({ companyId: s.companyId, principalType: "user",
      principalId: "responsible-user", status: "active" }).onConflictDoNothing();
    await toPending(s, id);
    await qaFails(s, id);
    expect(state(await card(id))?.changesRequestedCount).toBe(1);
    expect((await patch(s, s.builderId, id, cancel)).status).toBe(200);
    await freshRunFor(s, s.builderId, id);
    const r1 = await comment(s, s.builderId, id, { body: "resuming", resume: true });
    expect(r1.status, JSON.stringify(r1.body)).toBe(201);
    const mid = await card(id);
    if (mid.status !== "cancelled") {
      await db.update(issues).set({ status: "in_progress", assigneeAgentId: s.builderId }).where(eq(issues.id, id));
      await checkout(s, s.builderId, id);
    }
    const h = await patch(s, s.builderId, id, handoff(s));
    expect(h.status, JSON.stringify(h.body)).toBe(200);
    const f2 = await patch(s, s.qaId, id, qaFail(s));
    const c = await card(id);
    receipts.F4 = { midState: state(mid)?.status ?? null, midCount: state(mid)?.changesRequestedCount ?? null, fail2: f2.status,
      assigneeUser: c.assigneeUserId ?? null, count: state(c)?.changesRequestedCount ?? null };
    expect(state(mid)?.changesRequestedCount).toBe(1);
    expect(f2.status, JSON.stringify(f2.body)).toBe(200);
    expect(state(c)?.changesRequestedCount).toBe(2);
    expect(c.assigneeUserId).toBe("responsible-user");
  });

  it("F5 (control): on a cancelled approved card the identical policy re-send (same stage ids) is 200", async () => {
    const s = await seed();
    const id = await approvedDoneCard(s);
    const stored = (await card(id)).executionPolicy as Record<string, any>;
    for (const a of [s.builderId, s.qaId]) {
      await freshRunFor(s, a, id);
    }
    expect((await patch(s, s.builderId, id, cancel)).status).toBe(200);
    const rb = await patch(s, s.builderId, id, { executionPolicy: stored });
    const rq = await patch(s, s.qaId, id, { executionPolicy: stored });
    receipts.F5 = { builder: rb.status, qa: rq.status };
    expect(rb.status, JSON.stringify(rb.body)).toBe(200);
    expect(rq.status, JSON.stringify(rq.body)).toBe(200);
  });
});
