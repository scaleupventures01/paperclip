import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  activityLog,
  agentWakeupRequests,
  companies,
  createDb,
  g6CertificationReservationIssues,
  g6CertificationReservations,
  heartbeatRuns,
  issueTreeHoldMembers,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import { createG6CertificationReservationSchema } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { g6CertificationReservationService } from "./g6-certification-reservations.js";
import { heartbeatService } from "./heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();

(support.supported ? describe : describe.skip)("G6 certification reservations", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("g6-certification-reservation-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  async function seed(issueCount = 3) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "G6 reservation test",
      issuePrefix: `G${companyId.slice(0, 4)}`,
      defaultResponsibleUserId: "board",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Certified seat",
      role: "operator",
      adapterType: "process",
      status: "paused",
      pauseReason: "Manual certification staging",
      pausedAt: new Date(),
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, wakeOnDemand: true } },
    });
    await db.insert(activityLog).values({
      companyId,
      actorType: "user",
      actorId: "board",
      action: "agent.paused",
      entityType: "agent",
      entityId: agentId,
    });
    const issueIds = Array.from({ length: issueCount }, () => randomUUID());
    await db.insert(issues).values(issueIds.map((id, ordinal) => ({
      id,
      companyId,
      title: `G6 exact issue ${ordinal + 1}`,
      status: "todo",
      assigneeAgentId: agentId,
    })));
    return { companyId, agentId, issueIds };
  }

  const expiry = () => new Date(Date.now() + 60 * 60 * 1000);

  it("requires exactly three distinct issue IDs at the API boundary", () => {
    const ids = Array.from({ length: 4 }, () => randomUUID());
    expect(createG6CertificationReservationSchema.safeParse({
      expectedIssueIds: ids.slice(0, 3),
      expiresAt: expiry().toISOString(),
    }).success).toBe(true);
    expect(createG6CertificationReservationSchema.safeParse({
      expectedIssueIds: ids.slice(0, 2),
      expiresAt: expiry().toISOString(),
    }).success).toBe(false);
    expect(createG6CertificationReservationSchema.safeParse({
      expectedIssueIds: ids,
      expiresAt: expiry().toISOString(),
    }).success).toBe(false);
  });

  it("atomically activates only an exact paused preset-1 zero-run batch", async () => {
    const f = await seed();
    const reservation = await g6CertificationReservationService(db).create({
      ...f,
      expectedIssueIds: f.issueIds,
      expiresAt: expiry(),
      actor: { userId: "board" },
    });
    expect(reservation.status).toBe("active");
    expect(reservation.issues.map((member) => member.issueId)).toEqual(f.issueIds);
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(agent).toMatchObject({ status: "idle", pausedAt: null });
    expect(agent.runtimeConfig).toMatchObject({ heartbeat: { maxConcurrentRuns: 3 } });
    const [audit] = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, f.companyId),
      eq(activityLog.entityId, reservation.id),
      eq(activityLog.action, "g6_certification.reservation_created"),
    ));
    expect(audit).toMatchObject({ actorType: "user", actorId: "board" });
  });

  it("rejects a known-negative extra actionable issue", async () => {
    const f = await seed(4);
    await expect(g6CertificationReservationService(db).create({
      ...f,
      expectedIssueIds: f.issueIds.slice(0, 3),
      expiresAt: expiry(),
      actor: { userId: "board" },
    })).rejects.toMatchObject({ status: 409 });
    const rows = await db.select().from(g6CertificationReservations)
      .where(eq(g6CertificationReservations.agentId, f.agentId));
    expect(rows).toHaveLength(0);
  });

  it("serializes a pre-commit injected issue and defers it after activation", async () => {
    const f = await seed();
    const injectedIssueId = randomUUID();
    let injection: Promise<unknown> | null = null;
    let settled = false;
    const service = g6CertificationReservationService(db, {
      beforeActivate: async () => {
        injection = db.insert(issues).values({
          id: injectedIssueId,
          companyId: f.companyId,
          title: "Injected during reserve commit",
          status: "todo",
          assigneeAgentId: f.agentId,
        }).then(() => { settled = true; });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(settled).toBe(false);
      },
    });
    const reservation = await service.create({
      ...f,
      expectedIssueIds: f.issueIds,
      expiresAt: expiry(),
      actor: { userId: "board" },
    });
    await injection;
    expect(await service.admitWake(f.companyId, f.agentId, injectedIssueId)).toEqual({
      kind: "deferred",
      reservationId: reservation.id,
    });
  });

  it("serializes a pre-commit queued run and refuses its non-reserved claim", async () => {
    const f = await seed();
    const injectedRunId = randomUUID();
    const unrelatedIssueId = randomUUID();
    let injection: Promise<unknown> | null = null;
    let settled = false;
    const service = g6CertificationReservationService(db, {
      beforeActivate: async () => {
        injection = db.insert(heartbeatRuns).values({
          id: injectedRunId,
          companyId: f.companyId,
          agentId: f.agentId,
          status: "queued",
          contextSnapshot: { issueId: unrelatedIssueId },
        }).then(() => { settled = true; });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(settled).toBe(false);
      },
    });
    await service.create({ ...f, expectedIssueIds: f.issueIds, expiresAt: expiry(), actor: { userId: "board" } });
    await injection;
    const [persisted] = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, injectedRunId));
    expect(persisted).toMatchObject({
      status: "cancelled",
      errorCode: "g6_certification_non_reserved_issue",
    });
    expect(await service.admitClaim({
      id: injectedRunId,
      companyId: f.companyId,
      agentId: f.agentId,
      contextSnapshot: { issueId: unrelatedIssueId },
      nativeIssueId: null,
    })).toEqual({ allowed: false, reason: "non_reserved_issue" });
  });

  it("serializes actionable removal from the reserved agent across activation", async () => {
    const f = await seed();
    let mutation: Promise<unknown> | null = null;
    let settled = false;
    const service = g6CertificationReservationService(db, {
      beforeActivate: async () => {
        mutation = db.update(issues).set({ status: "done" })
          .where(eq(issues.id, f.issueIds[0])).then(() => { settled = true; });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(settled).toBe(false);
      },
    });
    await service.create({ ...f, expectedIssueIds: f.issueIds, expiresAt: expiry(), actor: { userId: "board" } });
    await mutation;
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueIds[0]));
    expect(issue.status).toBe("done");
  });

  it("serializes pause-hold activation across reservation activation", async () => {
    const f = await seed();
    const holdId = randomUUID();
    await db.insert(issueTreeHolds).values({
      id: holdId,
      companyId: f.companyId,
      rootIssueId: f.issueIds[0],
      mode: "pause",
      status: "released",
    });
    await db.insert(issueTreeHoldMembers).values({
      companyId: f.companyId,
      holdId,
      issueId: f.issueIds[0],
      depth: 0,
      issueTitle: "G6 exact issue 1",
      issueStatus: "todo",
      assigneeAgentId: f.agentId,
    });
    let mutation: Promise<unknown> | null = null;
    let settled = false;
    const service = g6CertificationReservationService(db, {
      beforeActivate: async () => {
        mutation = db.update(issueTreeHolds).set({ status: "active" })
          .where(eq(issueTreeHolds.id, holdId)).then(() => { settled = true; });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(settled).toBe(false);
      },
    });
    await service.create({ ...f, expectedIssueIds: f.issueIds, expiresAt: expiry(), actor: { userId: "board" } });
    await mutation;
    const [hold] = await db.select().from(issueTreeHolds).where(eq(issueTreeHolds.id, holdId));
    expect(hold.status).toBe("active");
  });

  it("locks the old issue's current assignee when a nullable hold member moves", async () => {
    const f = await seed();
    const holdId = randomUUID();
    const replacementIssueId = randomUUID();
    await db.insert(issues).values({
      id: replacementIssueId,
      companyId: f.companyId,
      title: "Unassigned replacement hold member",
      status: "todo",
    });
    await db.insert(issueTreeHolds).values({
      id: holdId,
      companyId: f.companyId,
      rootIssueId: f.issueIds[0],
      mode: "pause",
      status: "released",
    });
    await db.insert(issueTreeHoldMembers).values({
      companyId: f.companyId,
      holdId,
      issueId: f.issueIds[0],
      depth: 0,
      issueTitle: "G6 exact issue 1",
      issueStatus: "todo",
      assigneeAgentId: null,
    });
    let mutation: Promise<unknown> | null = null;
    let settled = false;
    const service = g6CertificationReservationService(db, {
      beforeActivate: async () => {
        mutation = db.update(issueTreeHoldMembers).set({ issueId: replacementIssueId })
          .where(and(
            eq(issueTreeHoldMembers.holdId, holdId),
            eq(issueTreeHoldMembers.issueId, f.issueIds[0]),
          )).then(() => { settled = true; });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(settled).toBe(false);
      },
    });
    await service.create({ ...f, expectedIssueIds: f.issueIds, expiresAt: expiry(), actor: { userId: "board" } });
    await mutation;
    const [member] = await db.select().from(issueTreeHoldMembers)
      .where(eq(issueTreeHoldMembers.holdId, holdId));
    expect(member.issueId).toBe(replacementIssueId);
  });

  it("allows expected issues and defers a post-commit issue and generic wake", async () => {
    const f = await seed();
    const service = g6CertificationReservationService(db);
    const reservation = await service.create({
      ...f,
      expectedIssueIds: f.issueIds,
      expiresAt: expiry(),
      actor: { userId: "board" },
    });
    const injectedIssueId = randomUUID();
    await db.insert(issues).values({
      id: injectedIssueId,
      companyId: f.companyId,
      title: "Injected after activation",
      status: "todo",
      assigneeAgentId: f.agentId,
    });
    expect(await service.admitWake(f.companyId, f.agentId, f.issueIds[0])).toEqual({
      kind: "allowed",
      reservationId: reservation.id,
    });
    expect((await service.admitWake(f.companyId, f.agentId, injectedIssueId)).kind).toBe("deferred");
    expect((await service.admitWake(f.companyId, f.agentId, null)).kind).toBe("deferred");
  });

  it("persists a non-reserved heartbeat wake as deferred without creating a run", async () => {
    const f = await seed();
    const service = g6CertificationReservationService(db);
    const reservation = await service.create({ ...f, expectedIssueIds: f.issueIds, expiresAt: expiry(), actor: { userId: "board" } });
    const injectedIssueId = randomUUID();
    await db.insert(issues).values({
      id: injectedIssueId,
      companyId: f.companyId,
      title: "Ordinary work arriving during certification",
      status: "todo",
      assigneeAgentId: f.agentId,
    });
    const run = await heartbeatService(db, { runtimeEnv: {} }).wakeup(f.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: injectedIssueId },
      contextSnapshot: { issueId: injectedIssueId },
      requestedByActorType: "system",
      requestedByActorId: "autoscaler",
    });
    expect(run).toBeNull();
    const wakes = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, f.agentId),
      eq(agentWakeupRequests.status, "deferred_issue_execution"),
    ));
    expect(wakes).toHaveLength(1);
    expect(wakes[0].payload).toMatchObject({
      issueId: injectedIssueId,
      g6CertificationReservationId: reservation.id,
    });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId));
    expect(runs).toHaveLength(0);
  });

  it("binds exactly one run per expected issue at claim", async () => {
    const f = await seed();
    const service = g6CertificationReservationService(db);
    await service.create({ ...f, expectedIssueIds: f.issueIds, expiresAt: expiry(), actor: { userId: "board" } });
    const firstRunId = randomUUID();
    const secondRunId = randomUUID();
    const run = (id: string) => ({ id, companyId: f.companyId, agentId: f.agentId, contextSnapshot: { issueId: f.issueIds[0] }, nativeIssueId: null });
    await db.insert(heartbeatRuns).values([
      { ...run(firstRunId), status: "queued" },
      { ...run(secondRunId), status: "queued" },
    ]);
    expect(await service.admitClaim(run(firstRunId))).toMatchObject({ allowed: true });
    expect(await service.admitClaim(run(secondRunId))).toEqual({ allowed: false, reason: "duplicate_reserved_issue_run" });
    const [member] = await db.select().from(g6CertificationReservationIssues).where(and(
      eq(g6CertificationReservationIssues.agentId, f.agentId),
      eq(g6CertificationReservationIssues.issueId, f.issueIds[0]),
    ));
    expect(member.admittedRunId).toBe(firstRunId);
  });

  it("cancels a wake that inserts after its reservation is closed", async () => {
    const f = await seed();
    const service = g6CertificationReservationService(db);
    const reservation = await service.create({ ...f, expectedIssueIds: f.issueIds, expiresAt: expiry(), actor: { userId: "board" } });
    expect(await service.admitWake(f.companyId, f.agentId, f.issueIds[0])).toEqual({
      kind: "allowed",
      reservationId: reservation.id,
    });
    await service.abort({
      companyId: f.companyId,
      agentId: f.agentId,
      reservationId: reservation.id,
      actor: { userId: "board" },
      reason: "close-race negative control",
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: f.companyId,
      agentId: f.agentId,
      status: "queued",
      contextSnapshot: {
        issueId: f.issueIds[0],
        g6CertificationReservationId: reservation.id,
      },
    });
    await heartbeatService(db, { runtimeEnv: {} }).resumeQueuedRuns();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.status).toBe("cancelled");
    expect(run.errorCode).toBe("g6_certification_reservation_closed");
  });

  it("verifies one succeeded run per issue, restores preset 1, and releases deferred wakes", async () => {
    const f = await seed();
    const service = g6CertificationReservationService(db);
    const reservation = await service.create({ ...f, expectedIssueIds: f.issueIds, expiresAt: expiry(), actor: { userId: "board" } });
    for (const issueId of f.issueIds) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId: f.companyId,
        agentId: f.agentId,
        status: "queued",
        contextSnapshot: { issueId },
      });
      await service.admitClaim({ id: runId, companyId: f.companyId, agentId: f.agentId, contextSnapshot: { issueId }, nativeIssueId: null });
      await db.update(heartbeatRuns).set({
        status: "succeeded",
        startedAt: new Date(),
        finishedAt: new Date(),
      }).where(eq(heartbeatRuns.id, runId));
    }
    await db.insert(agentWakeupRequests).values({
      companyId: f.companyId,
      agentId: f.agentId,
      source: "automation",
      status: "deferred_issue_execution",
      payload: { issueId: randomUUID(), g6CertificationReservationId: reservation.id },
    });
    const closed = await service.verifyAndRelease({
      companyId: f.companyId,
      agentId: f.agentId,
      reservationId: reservation.id,
      actor: { userId: "board" },
    });
    expect(closed.status).toBe("released");
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(agent.status).toBe("idle");
    expect(agent.runtimeConfig).toMatchObject({ heartbeat: { maxConcurrentRuns: 1 } });
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.agentId));
    expect(wake.status).toBe("skipped");

    // Simulate commit followed by a lost HTTP response: the operator can recover
    // the receipt historically and safely replay the same close mode.
    expect(await service.getActive(f.companyId, f.agentId)).toBeNull();
    const historical = await service.getById(f.companyId, f.agentId, reservation.id);
    expect(historical).toEqual(closed);
    expect(await service.getById(randomUUID(), f.agentId, reservation.id)).toBeNull();
    const replayed = await service.verifyAndRelease({
      companyId: f.companyId,
      agentId: f.agentId,
      reservationId: reservation.id,
      actor: { userId: "board" },
    });
    expect(replayed).toEqual(closed);
    await expect(service.abort({
      companyId: f.companyId,
      agentId: f.agentId,
      reservationId: reservation.id,
      actor: { userId: "board" },
      reason: "must not reinterpret a released reservation",
    })).rejects.toMatchObject({ status: 409 });
    const releaseAudits = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, f.companyId),
      eq(activityLog.entityId, reservation.id),
      eq(activityLog.action, "g6_certification.reservation_verified_released"),
    ));
    expect(releaseAudits).toHaveLength(1);
  });

  it("fails closed on abort", async () => {
    const f = await seed();
    const service = g6CertificationReservationService(db);
    const reservation = await service.create({ ...f, expectedIssueIds: f.issueIds, expiresAt: expiry(), actor: { userId: "board" } });
    await db.insert(heartbeatRuns).values({
      companyId: f.companyId,
      agentId: f.agentId,
      status: "queued",
      contextSnapshot: {
        issueId: f.issueIds[0],
        g6CertificationReservationId: reservation.id,
      },
    });
    const closed = await service.abort({
      companyId: f.companyId,
      agentId: f.agentId,
      reservationId: reservation.id,
      actor: { userId: "board" },
      reason: "negative control",
    });
    await heartbeatService(db, { runtimeEnv: {} }).cancelActiveForAgent(
      f.agentId,
      "G6 certification reservation aborted",
    );
    await service.markContainmentCompleted(f.agentId);
    expect(closed.status).toBe("aborted");
    const [run] = await db.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, f.agentId));
    expect(run.status).toBe("cancelled");
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(agent).toMatchObject({ status: "paused", pauseReason: "negative control" });
    expect(agent.runtimeConfig).toMatchObject({ heartbeat: { maxConcurrentRuns: 1 } });
    const [audit] = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, f.companyId),
      eq(activityLog.entityId, reservation.id),
      eq(activityLog.action, "g6_certification.reservation_aborted"),
    ));
    expect(audit).toMatchObject({ actorType: "user", actorId: "board" });
  });

  it("fails closed on expiry and never auto-resumes the agent", async () => {
    const f = await seed();
    const service = g6CertificationReservationService(db);
    const reservation = await service.create({ ...f, expectedIssueIds: f.issueIds, expiresAt: expiry(), actor: { userId: "board" } });
    await db.update(g6CertificationReservations).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(g6CertificationReservations.id, reservation.id));
    expect(await service.expireDue()).toEqual({ checked: 1, expired: 1, expiredAgentIds: [f.agentId] });
    expect(await service.admitWake(f.companyId, f.agentId, f.issueIds[0])).toEqual({ kind: "unreserved" });
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(agent.status).toBe("paused");
    expect(agent.runtimeConfig).toMatchObject({ heartbeat: { maxConcurrentRuns: 1 } });
    const [expired] = await db.select().from(g6CertificationReservations).where(eq(g6CertificationReservations.id, reservation.id));
    expect(expired.status).toBe("expired");
  });

  it("the heartbeat sweep cancels admitted work when a reservation expires", async () => {
    const f = await seed();
    const service = g6CertificationReservationService(db);
    const reservation = await service.create({ ...f, expectedIssueIds: f.issueIds, expiresAt: expiry(), actor: { userId: "board" } });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: f.companyId,
      agentId: f.agentId,
      status: "running",
      startedAt: new Date(),
      contextSnapshot: {
        issueId: f.issueIds[0],
        g6CertificationReservationId: reservation.id,
      },
    });
    await db.update(g6CertificationReservations).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(g6CertificationReservations.id, reservation.id));
    await heartbeatService(db, { runtimeEnv: {} }).resumeQueuedRuns();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.status).toBe("cancelled");
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    expect(agent.status).toBe("paused");
  });

  it("durably picks up containment after lazy GET expiry wins", async () => {
    const f = await seed();
    const service = g6CertificationReservationService(db);
    const reservation = await service.create({ ...f, expectedIssueIds: f.issueIds, expiresAt: expiry(), actor: { userId: "board" } });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: f.companyId,
      agentId: f.agentId,
      status: "running",
      startedAt: new Date(),
      contextSnapshot: {
        issueId: f.issueIds[0],
        g6CertificationReservationId: reservation.id,
      },
    });
    await db.update(g6CertificationReservations).set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(g6CertificationReservations.id, reservation.id));
    const lazyRead = await service.getActive(f.companyId, f.agentId);
    expect(lazyRead).toBeNull();
    const [beforeSweep] = await db.select().from(g6CertificationReservations)
      .where(eq(g6CertificationReservations.id, reservation.id));
    expect(beforeSweep).toMatchObject({ status: "expired", containmentCompletedAt: null });
    await heartbeatService(db, { runtimeEnv: {} }).resumeQueuedRuns();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run.status).toBe("cancelled");
    const [contained] = await db.select().from(g6CertificationReservations)
      .where(eq(g6CertificationReservations.id, reservation.id));
    expect(contained.containmentCompletedAt).toBeInstanceOf(Date);
  });
});
