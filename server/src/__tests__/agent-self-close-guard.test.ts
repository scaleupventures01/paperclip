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
import { agents, authUsers, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
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
});
