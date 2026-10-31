// agentos#1612, #1613, #1614: follow-ups to the agent self-close guard (agentos#1567).
//
// #1612: a checkout with expectedStatuses ["done"] reopens an approved card but keeps its
//        completed review state, so the next agent done closes the new work with no review.
// #1613: after a PATCH reopen the next review skips QA; a board done after a comment reopen
//        lands in review instead of closing.
// #1614: an agent can block its reviewer's PASS by reordering or adding review stages.
//
// Every request goes through the real issue routes (supertest as the acting agent's own run, or
// as the board) on embedded Postgres. Harness pattern from the agentos#1567 verifier probes.
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

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

// agentos#1612 P0-A: lets a test run a request between svc.checkout and the route's executionState
// reset (routes/issues.ts, the second statement after svc.checkout). Test-only wrapper around the real
// service: with no hook armed it is a pass-through. No product source is edited.
vi.mock("../services/index.js", async () => {
  const actual = await vi.importActual<typeof import("../services/index.js")>("../services/index.js");
  return {
    ...actual,
    issueService: (...args: Parameters<typeof actual.issueService>) => {
      const real = actual.issueService(...args);
      return {
        ...real,
        checkout: async (...a: Parameters<typeof real.checkout>) => {
          const out = await real.checkout(...a);
          const hook = (globalThis as any).__rr1612AfterCheckout as undefined | ((issueId: string) => Promise<void>);
          if (hook) await hook(a[0] as string);
          return out;
        },
      };
    },
  };
});

import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;
const T = 60_000;

d("review reopen follow-ups through the issue routes (agentos#1612, #1613, #1614)", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-reopen-followups-");
    db = createDb(tempDb.connectionString);
    const now = new Date();
    await db.insert(authUsers).values({
      id: "responsible-user", name: "Responsible User", email: "responsible-user@example.test",
      emailVerified: true, createdAt: now, updatedAt: now,
    });
  }, 60_000);

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 300));
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const builderId = randomUUID();
    const qaId = randomUUID();
    const parentId = randomUUID();
    const prefix = `RR${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId, name: "Reopen Co", issuePrefix: prefix,
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
    return { companyId, managerId, builderId, qaId, parentId };
  }
  type Seed = Awaited<ReturnType<typeof seed>>;

  const runs = new Map<string, string>();
  async function newRun(s: Seed, agentId: string, issueId: string) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id, companyId: s.companyId, agentId, invocationSource: "assignment", status: "running",
      startedAt: new Date(), contextSnapshot: { issueId, taskId: issueId },
    });
    runs.set(`${agentId}:${issueId}`, id);
    return id;
  }
  async function runOf(s: Seed, agentId: string, issueId: string) {
    return runs.get(`${agentId}:${issueId}`) ?? newRun(s, agentId, issueId);
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
  const asAgent = (s: Seed, agentId: string, runId: string) =>
    app({ type: "agent", source: "agent_key", companyId: s.companyId, agentId, runId });
  const asBoard = (s: Seed) =>
    app({ type: "board", userId: "local-board", source: "local_implicit", companyIds: [s.companyId], isInstanceAdmin: false });

  // Simulates the agent's own checkout run holding the card (no route call).
  async function holdRun(s: Seed, agentId: string, id: string) {
    const fresh = await newRun(s, agentId, id);
    await db.update(issues).set({ checkoutRunId: fresh, executionRunId: fresh }).where(eq(issues.id, id));
    return fresh;
  }
  async function card(id: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, id));
    return row!;
  }
  async function patch(s: Seed, agentId: string, id: string, body: Record<string, unknown>) {
    const c = await card(id);
    let runId = await runOf(s, agentId, id);
    if (c.status === "in_progress" && c.assigneeAgentId === agentId && c.checkoutRunId !== runId) {
      runId = await holdRun(s, agentId, id);
    }
    return asAgent(s, agentId, runId).patch(`/api/issues/${id}`).send(body);
  }
  async function checkoutRoute(s: Seed, agentId: string, id: string, expectedStatuses: string[]) {
    const runId = await runOf(s, agentId, id);
    return asAgent(s, agentId, runId).post(`/api/issues/${id}/checkout`).send({ agentId, expectedStatuses });
  }
  const st = (row: { executionState: unknown }) => (row.executionState ?? null) as Record<string, any> | null;
  const cur = (row: { executionState: unknown }) => st(row)?.currentParticipant?.agentId ?? null;
  const body = (r: request.Response) => JSON.stringify({ status: r.status, body: r.body });

  const reviewPolicy = (s: Seed) => ({
    mode: "normal", maxReviewRounds: 2,
    stages: [{ type: "review", participants: [
      { type: "agent", agentId: s.qaId }, { type: "agent", agentId: s.managerId },
    ] }],
  });
  const twoStage = (s: Seed) => ({ mode: "normal", maxReviewRounds: 2, stages: [
    { type: "review", participants: [{ type: "agent", agentId: s.qaId }] },
    { type: "review", participants: [{ type: "agent", agentId: s.managerId }] },
  ] });
  const fix = JSON.stringify({ schema: "agentos.improver-fix/v1", pr: "none" });
  const handoff = (s: Seed) => ({ status: "in_review", comment: fix, assigneeAgentId: s.qaId });
  const qaFail = (s: Seed) => ({ status: "todo", comment: "FAIL: acceptance failed", assigneeAgentId: s.builderId });
  const qaPass = { status: "done", comment: "PASS at head" };

  // A build card created by the manager with the review policy, checked out by the builder.
  async function buildCard(s: Seed, policy: Record<string, unknown> = reviewPolicy(s)) {
    const res = await asAgent(s, s.managerId, await runOf(s, s.managerId, s.parentId))
      .post(`/api/companies/${s.companyId}/issues`)
      .send({ parentId: s.parentId, title: `Build: fix ${randomUUID().slice(0, 8)}`, description: "what must change",
        assigneeAgentId: s.builderId, status: "todo", executionPolicy: policy });
    expect(res.status, body(res)).toBe(201);
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, res.body.id));
    await holdRun(s, s.builderId, res.body.id);
    return res.body.id as string;
  }
  async function toPending(s: Seed, id: string) {
    const h = await patch(s, s.builderId, id, handoff(s));
    expect(h.status, `handoff: ${body(h)}`).toBe(200);
    const c = await card(id);
    expect(c.status).toBe("in_review");
    expect(st(c)?.status).toBe("pending");
    expect(cur(c)).toBe(s.qaId);
  }
  // Builder handoff, QA PASS: done, assigned to QA, review state completed.
  async function approvedDoneCard(s: Seed) {
    const id = await buildCard(s);
    await toPending(s, id);
    const q = await patch(s, s.qaId, id, qaPass);
    expect(q.status, body(q)).toBe(200);
    const c = await card(id);
    expect(c.status).toBe("done");
    expect(c.assigneeAgentId).toBe(s.qaId);
    expect(st(c)?.status).toBe("completed");
    return id;
  }
  // agentos#1612 A13 steps 2 and 3: builder takes the approved card and checks it out with ["done"].
  async function builderCheckoutReopen(s: Seed, id: string) {
    await newRun(s, s.builderId, id);
    const a = await patch(s, s.builderId, id, { assigneeAgentId: s.builderId, comment: "taking it" });
    expect(a.status, `self-assign: ${body(a)}`).toBe(200);
    const co = await checkoutRoute(s, s.builderId, id, ["done"]);
    expect(co.status, `checkout: ${body(co)}`).toBe(200);
    expect((await card(id)).status).toBe("in_progress");
  }
  // Closed without review: the card is done again and no review ran on the reopened work.
  function expectNotClosedWithoutReview(r: request.Response, c: Awaited<ReturnType<typeof card>>, s: Seed) {
    const refused = r.status === 422;
    const freshReviewToQa = c.status === "in_review" && st(c)?.status === "pending" && cur(c) === s.qaId;
    expect(c.status, `done after reopen with state ${JSON.stringify(st(c))}: ${body(r)}`).not.toBe("done");
    expect(refused || freshReviewToQa, `neither a refusal nor a fresh review to QA: ${body(r)} ${JSON.stringify(st(c))}`).toBe(true);
  }

  // ---------------- agentos#1612 ----------------
  it("1612-A13 builder checkout ['done'] of an approved card, then builder done, does not close it unreviewed", async () => {
    const s = await seed(); const id = await approvedDoneCard(s);
    await builderCheckoutReopen(s, id);
    const r = await patch(s, s.builderId, id, { status: "done", comment: "follow-up shipped" });
    expectNotClosedWithoutReview(r, await card(id), s);
  }, T);

  it("1612-A6b QA checkout ['done'] of its approved card, then QA done, does not close it unreviewed", async () => {
    const s = await seed(); const id = await approvedDoneCard(s);
    await newRun(s, s.qaId, id);
    const co = await checkoutRoute(s, s.qaId, id, ["done"]);
    expect(co.status, `checkout: ${body(co)}`).toBe(200);
    expect((await card(id)).status).toBe("in_progress");
    const r = await patch(s, s.qaId, id, { status: "done", comment: "follow-up shipped" });
    const c = await card(id);
    expect(c.status, `QA closed its own reopened work: ${body(r)} ${JSON.stringify(st(c))}`).not.toBe("done");
  }, T);

  it("1612-handoff after a checkout reopen, the builder's in_review handoff starts a fresh QA review and QA PASS closes it", async () => {
    const s = await seed(); const id = await approvedDoneCard(s);
    await builderCheckoutReopen(s, id);
    const h = await patch(s, s.builderId, id, handoff(s));
    expect(h.status, `handoff: ${body(h)}`).toBe(200);
    const mid = await card(id);
    expect(mid.status).toBe("in_review");
    expect(st(mid)?.status).toBe("pending");
    expect(cur(mid)).toBe(s.qaId);
    expect(mid.assigneeAgentId).toBe(s.qaId);
    const q = await patch(s, s.qaId, id, qaPass);
    expect(q.status, `QA PASS: ${body(q)}`).toBe(200);
    const c = await card(id);
    expect(c.status).toBe("done");
    expect(st(c)?.status).toBe("completed");
  }, T);

  // ---------------- agentos#1613 ----------------
  it("1613-X4n_patch after a PATCH reopen of an approved card still assigned to QA, the builder's handoff goes to QA first", async () => {
    const s = await seed(); const id = await approvedDoneCard(s);
    await newRun(s, s.builderId, id);
    const r1 = await patch(s, s.builderId, id, { status: "todo", comment: "reopen" });
    expect(r1.status, `reopen: ${body(r1)}`).toBe(200);
    const h = await patch(s, s.builderId, id, handoff(s));
    expect(h.status, `handoff: ${body(h)}`).toBe(200);
    const c = await card(id);
    expect(c.status).toBe("in_review");
    expect(st(c)?.status).toBe("pending");
    expect(cur(c), `review went to ${cur(c) === s.managerId ? "IT Manager" : cur(c)}`).toBe(s.qaId);
    expect(c.assigneeAgentId).toBe(s.qaId);
  }, T);

  // Orchestrator's decision (a guess, not Calvin's): the board is the human authority, and before
  // agentos#1567 a board done after a comment reopen closed the card in one request.
  it("1613-L7_comment board done after a board comment reopen of an approved card closes it in one request", async () => {
    const s = await seed(); const id = await approvedDoneCard(s);
    const b = asBoard(s);
    const r1 = await b.post(`/api/issues/${id}/comments`).send({ body: "board reopen", reopen: true });
    expect(r1.status, `comment reopen: ${body(r1)}`).toBe(201);
    expect((await card(id)).status).not.toBe("done");
    const r2 = await b.patch(`/api/issues/${id}`).send({ status: "done", comment: "board closes again" });
    expect(r2.status, `board done: ${body(r2)}`).toBe(200);
    const c = await card(id);
    expect(c.status, `board done landed in ${c.status} with state ${JSON.stringify(st(c))}`).toBe("done");
  }, T);

  // ---------------- agentos#1614 ----------------
  async function pendingTwoStage(s: Seed) {
    const id = await buildCard(s, twoStage(s));
    await toPending(s, id);
    const pol = (await card(id)).executionPolicy as any;
    return { id, pol, swapped: { ...pol, stages: [pol.stages[1], pol.stages[0]] } };
  }
  const stageIds = (c: Awaited<ReturnType<typeof card>>) => ((c.executionPolicy as any)?.stages ?? []).map((x: any) => x.id);

  it("1614-X6b agent reorders review stages while QA's stage is pending: 422 review_policy_change_refused, QA PASS still works", async () => {
    const s = await seed(); const { id, pol, swapped } = await pendingTwoStage(s);
    const r = await patch(s, s.builderId, id, { executionPolicy: swapped });
    expect(r.status, `reorder: ${body(r)}`).toBe(422);
    expect(r.body?.details?.code ?? r.body?.code).toBe("review_policy_change_refused");
    const c = await card(id);
    expect(stageIds(c)).toEqual(pol.stages.map((x: any) => x.id));
    const q = await patch(s, s.qaId, id, qaPass);
    expect(q.status, `QA PASS: ${body(q)}`).toBe(200);
    expect(cur(await card(id))).toBe(s.managerId);
  }, T);

  it("1614-X6e agent reorders review stages after a FAIL (changes_requested): 422 review_policy_change_refused", async () => {
    const s = await seed(); const { id, pol, swapped } = await pendingTwoStage(s);
    const f = await patch(s, s.qaId, id, qaFail(s));
    expect(f.status, `QA FAIL: ${body(f)}`).toBe(200);
    expect(st(await card(id))?.status).toBe("changes_requested");
    const r = await patch(s, s.builderId, id, { executionPolicy: swapped });
    expect(r.status, `reorder: ${body(r)}`).toBe(422);
    expect(r.body?.details?.code ?? r.body?.code).toBe("review_policy_change_refused");
    expect(stageIds(await card(id))).toEqual(pol.stages.map((x: any) => x.id));
  }, T);

  it("1614-X6c agent adds a self-only review stage while QA's stage is pending: 422 review_policy_change_refused", async () => {
    const s = await seed(); const id = await buildCard(s); await toPending(s, id);
    const pol = (await card(id)).executionPolicy as any;
    const added = { ...pol, stages: [...pol.stages, { type: "review", participants: [{ type: "agent", agentId: s.builderId }] }] };
    const r = await patch(s, s.builderId, id, { executionPolicy: added });
    expect(r.status, `add stage: ${body(r)}`).toBe(422);
    expect(r.body?.details?.code ?? r.body?.code).toBe("review_policy_change_refused");
    expect(stageIds(await card(id))).toEqual(pol.stages.map((x: any) => x.id));
    const q = await patch(s, s.qaId, id, qaPass);
    expect(q.status, `QA PASS: ${body(q)}`).toBe(200);
    expect((await card(id)).status).toBe("done");
  }, T);

  // ---------------- agentos#1612 verify findings ----------------
  // P0-B: the reviewer reopens the approved card and does the work itself. The reopen carries the
  // original builder as returnAssignee, so QA's own in_review handoff excluded the builder, not QA,
  // and QA became the reviewer of its own work. Required: QA's handoff is not reviewed by QA, and
  // QA's done is refused or does not close the card.
  async function qaSelfReview(s: Seed, id: string, reopen: "patch" | "checkout", explicit: boolean) {
    await newRun(s, s.qaId, id);
    const steps: Record<string, string> = {};
    if (reopen === "patch") {
      const r = await patch(s, s.qaId, id, { status: "in_progress", comment: "QA reopens to fix it" });
      steps.reopen = body(r);
    } else {
      const r = await checkoutRoute(s, s.qaId, id, ["done"]);
      expect(r.status, `QA checkout: ${body(r)}`).toBe(200);
      steps.reopen = body(r);
    }
    const handoffBody = explicit ? handoff(s) : { status: "in_review", comment: fix };
    const h = await patch(s, s.qaId, id, handoffBody);
    steps.handoff = body(h);
    const afterHandoff = await card(id);
    const d = await patch(s, s.qaId, id, qaPass);
    steps.done = body(d);
    const fin = await card(id);
    return { h, afterHandoff, d, fin, steps };
  }
  for (const reopen of ["patch", "checkout"] as const) {
    for (const explicit of [false, true]) {
      it(`1612-N11_${reopen}${explicit ? "_explicit" : ""} QA reopens its approved card and hands off to itself: not reviewed by QA, QA done does not close`, async () => {
        const s = await seed(); const id = await approvedDoneCard(s);
        const { h, afterHandoff, fin, steps } = await qaSelfReview(s, id, reopen, explicit);
        const handoffRefused = h.status === 422;
        expect(
          handoffRefused || cur(afterHandoff) !== s.qaId,
          `QA is the current reviewer of its own handoff (state ${JSON.stringify(st(afterHandoff))}) ${JSON.stringify(steps)}`,
        ).toBe(true);
        expect(fin.status, `QA closed its own reopened work: state ${JSON.stringify(st(fin))} ${JSON.stringify(steps)}`).not.toBe("done");
      }, T);
    }
  }

  // P0-A: the checkout reset is a second statement after svc.checkout. A done from the same run
  // that reads the card in that gap sees in_progress with the old completed state and closes it.
  // Approach A (deterministic): the vi.mock wrapper above runs the builder's PATCH done between the
  // real svc.checkout write and the route's reset. Approach B (stress): real concurrent requests.
  async function raceSetup(s: Seed) {
    const id = await approvedDoneCard(s);
    const a = await builderTakes(s, id);
    return { id, runId: await runOf(s, s.builderId, id), a };
  }
  async function builderTakes(s: Seed, id: string) {
    await newRun(s, s.builderId, id);
    const a = await patch(s, s.builderId, id, { assigneeAgentId: s.builderId, comment: "taking it" });
    expect(a.status, `self-assign: ${body(a)}`).toBe(200);
    return a;
  }

  it("1612-N5c_forced checkout ['done'] with the builder's done landing between the checkout write and the reset does not close the card", async () => {
    const s = await seed(); const { id, runId } = await raceSetup(s);
    const ag = asAgent(s, s.builderId, runId);
    let donePromise: Promise<request.Response> | null = null;
    (globalThis as any).__rr1612AfterCheckout = async (issueId: string) => {
      if (issueId !== id || donePromise) return;
      donePromise = ag.patch(`/api/issues/${id}`).send({ status: "done", comment: "race" }).then((r) => r);
      // A fix that serializes the two requests would hold this PATCH; do not deadlock on it.
      await Promise.race([donePromise, new Promise((r) => setTimeout(r, 1500))]);
    };
    let co: request.Response;
    try {
      co = await ag.post(`/api/issues/${id}/checkout`).send({ agentId: s.builderId, expectedStatuses: ["done"] }).then((r) => r);
    } finally {
      delete (globalThis as any).__rr1612AfterCheckout;
    }
    expect(donePromise, "the interleaved done was never sent").not.toBeNull();
    const dn = await donePromise!;
    const c = await card(id);
    expect(c.status, `closed unreviewed: checkout ${co.status}, interleaved done ${body(dn)}, state ${JSON.stringify(st(c))}`).not.toBe("done");
  }, T);

  it("1612-N5c_stress concurrent checkout ['done'] and done from the same run, either order, 0 to 50 ms apart: zero trials end done unreviewed", async () => {
    const closed: string[] = [];
    let trials = 0;
    for (const order of ["checkout-first", "done-first"] as const) {
      for (const delay of [0, 5, 20, 50]) {
        for (let i = 0; i < 2; i++) {
          const s = await seed(); const { id, runId } = await raceSetup(s);
          const ag = asAgent(s, s.builderId, runId);
          const doCo = () => ag.post(`/api/issues/${id}/checkout`).send({ agentId: s.builderId, expectedStatuses: ["done"] }).then((r) => r);
          const doDone = () => ag.patch(`/api/issues/${id}`).send({ status: "done", comment: "race" }).then((r) => r);
          const later = <X,>(f: () => Promise<X>) => new Promise<X>((res) => setTimeout(() => res(f()), delay));
          const [co, dn] = order === "checkout-first"
            ? await Promise.all([doCo(), later(doDone)])
            : await Promise.all([later(doCo), doDone()]);
          const c = await card(id);
          trials += 1;
          if (c.status === "done") closed.push(`${order}/${delay}ms co=${co.status} done=${dn.status} state=${st(c)?.status ?? null}`);
        }
      }
    }
    expect(closed, `${closed.length} of ${trials} trials ended done unreviewed: ${JSON.stringify(closed)}`).toEqual([]);
  }, 5 * T);

  // ---------------- controls (expected to pass on the base) ----------------
  it("control-1612 (c) builder PATCH-reopens an approved card and works: the handoff goes to QA and QA PASS closes it", async () => {
    const s = await seed(); const id = await approvedDoneCard(s);
    await newRun(s, s.builderId, id);
    const r1 = await patch(s, s.builderId, id, { status: "todo", comment: "reopen" });
    expect(r1.status, `reopen: ${body(r1)}`).toBe(200);
    const h = await patch(s, s.builderId, id, handoff(s));
    expect(h.status, `handoff: ${body(h)}`).toBe(200);
    const mid = await card(id);
    expect(mid.status).toBe("in_review");
    expect(cur(mid)).toBe(s.qaId);
    const q = await patch(s, s.qaId, id, qaPass);
    expect(q.status, `QA PASS: ${body(q)}`).toBe(200);
    const c = await card(id);
    expect(c.status).toBe("done");
    expect(st(c)?.status).toBe("completed");
  }, T);

  it("control-1612 (d) sequential: builder done sent after the checkout response returns is refused with 422", async () => {
    const s = await seed(); const id = await approvedDoneCard(s);
    await builderCheckoutReopen(s, id);
    const r = await patch(s, s.builderId, id, { status: "done", comment: "follow-up shipped" });
    expect(r.status, `done after checkout: ${body(r)}`).toBe(422);
    expect((await card(id)).status).not.toBe("done");
  }, T);

  it("control-1614 board reorders review stages while QA's stage is pending: allowed", async () => {
    const s = await seed(); const { id, swapped } = await pendingTwoStage(s);
    const r = await asBoard(s).patch(`/api/issues/${id}`).send({ executionPolicy: swapped });
    expect(r.status, `board reorder: ${body(r)}`).toBe(200);
    expect(stageIds(await card(id))).toEqual(swapped.stages.map((x: any) => x.id));
  }, T);

  it("control-1614 board adds a review stage while QA's stage is pending: allowed", async () => {
    const s = await seed(); const id = await buildCard(s); await toPending(s, id);
    const pol = (await card(id)).executionPolicy as any;
    const added = { ...pol, stages: [...pol.stages, { type: "review", participants: [{ type: "agent", agentId: s.managerId }] }] };
    const r = await asBoard(s).patch(`/api/issues/${id}`).send({ executionPolicy: added });
    expect(r.status, `board add stage: ${body(r)}`).toBe(200);
    expect(stageIds(await card(id)).length).toBe(2);
  }, T);

  it("control QA PASS closes an unmodified pending card", async () => {
    const s = await seed(); const id = await buildCard(s); await toPending(s, id);
    const q = await patch(s, s.qaId, id, qaPass);
    expect(q.status, `QA PASS: ${body(q)}`).toBe(200);
    expect((await card(id)).status).toBe("done");
  }, T);

  it("control board done on a never-reopened pending card closes it", async () => {
    const s = await seed(); const id = await buildCard(s); await toPending(s, id);
    const r = await asBoard(s).patch(`/api/issues/${id}`).send({ status: "done", comment: "board closes" });
    expect(r.status, `board done: ${body(r)}`).toBe(200);
    expect((await card(id)).status).toBe("done");
  }, T);

  it("control agent non-review PATCH (title) on a pending card still 200", async () => {
    const s = await seed(); const id = await buildCard(s); await toPending(s, id);
    const r = await patch(s, s.builderId, id, { title: "Build: renamed while in review" });
    expect(r.status, `title patch: ${body(r)}`).toBe(200);
    const c = await card(id);
    expect(c.title).toBe("Build: renamed while in review");
    expect(c.status).toBe("in_review");
    expect(st(c)?.status).toBe("pending");
  }, T);
});
