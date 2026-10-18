import {
  activityLog,
  agentWakeupRequests,
  agents,
  g6CertificationReservationIssues,
  g6CertificationReservations,
  heartbeatRuns,
  issueTreeHoldMembers,
  issueTreeHolds,
  issues,
  type Db,
} from "@paperclipai/db";
import { and, asc, desc, eq, gte, inArray, isNull, lte, notExists, or, sql } from "drizzle-orm";
import { conflict, notFound, unprocessable } from "../errors.js";

const ACTIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const ACTIONABLE_ISSUE_STATUSES = ["todo", "in_progress"] as const;

export type G6ReservationActor = { userId: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function maxConcurrentRuns(runtimeConfig: unknown) {
  const heartbeat = record(record(runtimeConfig).heartbeat);
  const value = Number(heartbeat.maxConcurrentRuns);
  return Number.isFinite(value) ? Math.floor(value) : null;
}

function withMaxConcurrentRuns(runtimeConfig: unknown, value: number) {
  const config = record(runtimeConfig);
  return {
    ...config,
    heartbeat: { ...record(config.heartbeat), maxConcurrentRuns: value },
  };
}

async function lockAdmission(tx: Db, companyId: string, agentId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${companyId}:${agentId}`}, 0))`);
}

function sameIds(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const expected = [...left].sort();
  const observed = [...right].sort();
  return expected.every((id, index) => id === observed[index]);
}

export function g6CertificationReservationService(
  db: Db,
  options: { beforeActivate?: () => Promise<void> } = {},
) {
  async function listMembers(queryDb: Db, reservationId: string) {
    return queryDb.select().from(g6CertificationReservationIssues)
      .where(eq(g6CertificationReservationIssues.reservationId, reservationId))
      .orderBy(asc(g6CertificationReservationIssues.ordinal));
  }

  async function expireLocked(
    tx: Db,
    reservation: typeof g6CertificationReservations.$inferSelect,
    now: Date,
  ) {
    if (reservation.status !== "active" || reservation.expiresAt > now) return false;
    const expired = await tx.update(g6CertificationReservations).set({
      status: "expired",
      expiredAt: now,
      containmentRequiredAt: now,
      closeReason: "Reservation expired before explicit verification and release",
      updatedAt: now,
    }).where(and(
      eq(g6CertificationReservations.id, reservation.id),
      eq(g6CertificationReservations.status, "active"),
    )).returning().then((rows) => rows[0] ?? null);
    if (!expired) return false;
    await tx.update(agents).set({
      status: "paused",
      runtimeConfig: reservation.previousRuntimeConfig,
      pauseReason: "G6 certification reservation expired; operator verification required",
      pausedAt: now,
      updatedAt: now,
    }).where(and(eq(agents.id, reservation.agentId), eq(agents.companyId, reservation.companyId)));
    await tx.insert(activityLog).values({
      companyId: reservation.companyId,
      actorType: "system",
      actorId: "g6-certification-reservation",
      action: "g6_certification.reservation_expired",
      entityType: "g6_certification_reservation",
      entityId: reservation.id,
      details: { agentId: reservation.agentId, expiresAt: reservation.expiresAt.toISOString() },
    });
    return true;
  }

  async function activeLocked(tx: Db, companyId: string, agentId: string, now: Date) {
    await lockAdmission(tx, companyId, agentId);
    const reservation = await tx.select().from(g6CertificationReservations).where(and(
      eq(g6CertificationReservations.companyId, companyId),
      eq(g6CertificationReservations.agentId, agentId),
      eq(g6CertificationReservations.status, "active"),
    )).for("update").limit(1).then((rows) => rows[0] ?? null);
    if (!reservation) return { reservation: null, expired: false };
    const expired = await expireLocked(tx, reservation, now);
    return { reservation: expired ? null : reservation, expired };
  }

  async function create(input: {
    companyId: string;
    agentId: string;
    expectedIssueIds: string[];
    expiresAt: Date;
    actor: G6ReservationActor;
  }) {
    const now = new Date();
    if (input.expiresAt <= now) throw unprocessable("Reservation expiry must be in the future");
    if (input.expiresAt.getTime() - now.getTime() > 4 * 60 * 60 * 1000) {
      throw unprocessable("Reservation expiry cannot be more than four hours in the future");
    }
    return db.transaction(async (tx) => {
      await lockAdmission(tx as unknown as Db, input.companyId, input.agentId);
      const agent = await tx.select().from(agents).where(and(
        eq(agents.id, input.agentId), eq(agents.companyId, input.companyId),
      )).for("update").limit(1).then((rows) => rows[0] ?? null);
      if (!agent) throw notFound("Agent not found");
      if (agent.status !== "paused" || !agent.pausedAt) {
        throw conflict("G6 reservation requires a manually paused agent", { status: agent.status });
      }
      const manualPause = await tx.select({ id: activityLog.id }).from(activityLog).where(and(
        eq(activityLog.companyId, input.companyId),
        eq(activityLog.entityType, "agent"),
        eq(activityLog.entityId, input.agentId),
        eq(activityLog.action, "agent.paused"),
        eq(activityLog.actorType, "user"),
        gte(activityLog.createdAt, agent.pausedAt),
      )).orderBy(desc(activityLog.createdAt)).limit(1).then((rows) => rows[0] ?? null);
      if (!manualPause) {
        throw conflict("G6 reservation requires a current board-authenticated manual pause");
      }
      if (maxConcurrentRuns(agent.runtimeConfig) !== 1) {
        throw conflict("G6 reservation requires heartbeat maxConcurrentRuns preset 1");
      }
      const activeRun = await tx.select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, input.agentId),
          inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
        )).limit(1).then((rows) => rows[0] ?? null);
      if (activeRun) throw conflict("G6 reservation requires zero active or queued runs", activeRun);

      const actionable = await tx.select({ id: issues.id }).from(issues).where(and(
        eq(issues.companyId, input.companyId),
        eq(issues.assigneeAgentId, input.agentId),
        isNull(issues.assigneeUserId),
        isNull(issues.hiddenAt),
        inArray(issues.status, [...ACTIONABLE_ISSUE_STATUSES]),
        notExists(
          tx.select({ id: issueTreeHoldMembers.id }).from(issueTreeHoldMembers)
            .innerJoin(issueTreeHolds, eq(issueTreeHolds.id, issueTreeHoldMembers.holdId))
            .where(and(
              eq(issueTreeHoldMembers.companyId, input.companyId),
              eq(issueTreeHoldMembers.issueId, issues.id),
              eq(issueTreeHoldMembers.skipped, false),
              eq(issueTreeHolds.status, "active"),
              eq(issueTreeHolds.mode, "pause"),
            )),
        ),
      )).orderBy(asc(issues.id));
      const observedIssueIds = actionable.map((row) => row.id);
      if (!sameIds(observedIssueIds, input.expectedIssueIds)) {
        throw conflict("Actionable issue demand does not exactly match the reservation", {
          expectedIssueIds: [...input.expectedIssueIds].sort(),
          observedIssueIds: [...observedIssueIds].sort(),
        });
      }

      const reservation = await tx.insert(g6CertificationReservations).values({
        companyId: input.companyId,
        agentId: input.agentId,
        expectedIssueCount: input.expectedIssueIds.length,
        previousRuntimeConfig: record(agent.runtimeConfig),
        reservedAt: now,
        expiresAt: input.expiresAt,
        createdByUserId: input.actor.userId,
      }).returning().then((rows) => rows[0]!);
      await tx.insert(g6CertificationReservationIssues).values(
        input.expectedIssueIds.map((issueId, ordinal) => ({
          reservationId: reservation.id,
          companyId: input.companyId,
          agentId: input.agentId,
          issueId,
          ordinal,
        })),
      );
      await options.beforeActivate?.();
      await tx.update(agents).set({
        status: "idle",
        runtimeConfig: withMaxConcurrentRuns(agent.runtimeConfig, input.expectedIssueIds.length),
        pauseReason: null,
        pausedAt: null,
        errorReason: null,
        updatedAt: now,
      }).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId), eq(agents.status, "paused")));
      await tx.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "user",
        actorId: input.actor.userId,
        action: "g6_certification.reservation_created",
        entityType: "g6_certification_reservation",
        entityId: reservation.id,
        details: { agentId: input.agentId, expectedIssueIds: input.expectedIssueIds, expiresAt: input.expiresAt.toISOString() },
      });
      return { ...reservation, issues: await listMembers(tx as unknown as Db, reservation.id) };
    });
  }

  async function getActive(companyId: string, agentId: string) {
    return db.transaction(async (tx) => {
      const current = await activeLocked(tx as unknown as Db, companyId, agentId, new Date());
      const reservation = current.reservation;
      if (!reservation) return null;
      return { ...reservation, issues: await listMembers(tx as unknown as Db, reservation.id) };
    });
  }

  async function getById(companyId: string, agentId: string, reservationId: string) {
    const reservation = await db.select().from(g6CertificationReservations).where(and(
      eq(g6CertificationReservations.id, reservationId),
      eq(g6CertificationReservations.companyId, companyId),
      eq(g6CertificationReservations.agentId, agentId),
    )).limit(1).then((rows) => rows[0] ?? null);
    if (!reservation) return null;
    return { ...reservation, issues: await listMembers(db, reservation.id) };
  }

  async function expireDue(now = new Date(), limit = 100) {
    const due = await db.select({
      companyId: g6CertificationReservations.companyId,
      agentId: g6CertificationReservations.agentId,
    }).from(g6CertificationReservations).where(and(
      isNull(g6CertificationReservations.containmentCompletedAt),
      or(
        and(
          eq(g6CertificationReservations.status, "active"),
          lte(g6CertificationReservations.expiresAt, now),
        ),
        inArray(g6CertificationReservations.status, ["aborted", "expired"]),
      ),
    )).orderBy(asc(g6CertificationReservations.expiresAt)).limit(limit);
    let expired = 0;
    const expiredAgentIds: string[] = [];
    for (const row of due) {
      const result = await db.transaction(async (tx) => {
        const current = await activeLocked(tx as unknown as Db, row.companyId, row.agentId, now);
        const pending = current.expired || await tx.select({ id: g6CertificationReservations.id })
          .from(g6CertificationReservations).where(and(
            eq(g6CertificationReservations.companyId, row.companyId),
            eq(g6CertificationReservations.agentId, row.agentId),
            inArray(g6CertificationReservations.status, ["aborted", "expired"]),
            isNull(g6CertificationReservations.containmentCompletedAt),
          )).limit(1).then((rows) => rows.length > 0);
        return { ...current, pending };
      });
      if (result.expired) {
        expired += 1;
      }
      if (result.pending && !expiredAgentIds.includes(row.agentId)) {
        expiredAgentIds.push(row.agentId);
      }
    }
    return { checked: due.length, expired, expiredAgentIds };
  }

  async function markContainmentCompleted(agentId: string) {
    const now = new Date();
    return db.update(g6CertificationReservations).set({
      containmentCompletedAt: now,
      updatedAt: now,
    }).where(and(
      eq(g6CertificationReservations.agentId, agentId),
      inArray(g6CertificationReservations.status, ["aborted", "expired"]),
      isNull(g6CertificationReservations.containmentCompletedAt),
    )).returning({ id: g6CertificationReservations.id });
  }

  async function admitWake(companyId: string, agentId: string, issueId: string | null) {
    const observed = await db.select({ id: g6CertificationReservations.id })
      .from(g6CertificationReservations).where(and(
        eq(g6CertificationReservations.companyId, companyId),
        eq(g6CertificationReservations.agentId, agentId),
        eq(g6CertificationReservations.status, "active"),
      )).limit(1).then((rows) => rows[0] ?? null);
    if (!observed) return { kind: "unreserved" as const };
    return db.transaction(async (tx) => {
      const { reservation, expired } = await activeLocked(tx as unknown as Db, companyId, agentId, new Date());
      if (expired) return { kind: "expired" as const };
      if (!reservation) return { kind: "unreserved" as const };
      if (!issueId) return { kind: "deferred" as const, reservationId: reservation.id };
      const member = await tx.select({ issueId: g6CertificationReservationIssues.issueId })
        .from(g6CertificationReservationIssues).where(and(
          eq(g6CertificationReservationIssues.reservationId, reservation.id),
          eq(g6CertificationReservationIssues.issueId, issueId),
        )).limit(1).then((rows) => rows[0] ?? null);
      return member
        ? { kind: "allowed" as const, reservationId: reservation.id }
        : { kind: "deferred" as const, reservationId: reservation.id };
    });
  }

  async function admitClaim(run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "contextSnapshot" | "nativeIssueId">) {
    const issueId = typeof run.contextSnapshot?.issueId === "string"
      ? run.contextSnapshot.issueId
      : run.nativeIssueId;
    const boundReservationId = typeof run.contextSnapshot?.g6CertificationReservationId === "string"
      ? run.contextSnapshot.g6CertificationReservationId
      : null;
    if (boundReservationId) {
      return db.transaction(async (tx) => {
        await lockAdmission(tx as unknown as Db, run.companyId, run.agentId);
        const reservation = await tx.select().from(g6CertificationReservations).where(and(
          eq(g6CertificationReservations.id, boundReservationId),
          eq(g6CertificationReservations.companyId, run.companyId),
          eq(g6CertificationReservations.agentId, run.agentId),
        )).for("update").limit(1).then((rows) => rows[0] ?? null);
        if (!reservation) return { allowed: false, reason: "reservation_missing" as const };
        if (await expireLocked(tx as unknown as Db, reservation, new Date())) {
          return { allowed: false, reason: "expired" as const };
        }
        if (reservation.status !== "active") {
          return { allowed: false, reason: "reservation_closed" as const };
        }
        return admitMemberClaim(tx as unknown as Db, reservation, issueId, run.id);
      });
    }
    const observed = await db.select({ id: g6CertificationReservations.id })
      .from(g6CertificationReservations).where(and(
        eq(g6CertificationReservations.companyId, run.companyId),
        eq(g6CertificationReservations.agentId, run.agentId),
        eq(g6CertificationReservations.status, "active"),
      )).limit(1).then((rows) => rows[0] ?? null);
    if (!observed) return { allowed: true, reservationId: null };
    return db.transaction(async (tx) => {
      const { reservation, expired } = await activeLocked(tx as unknown as Db, run.companyId, run.agentId, new Date());
      if (expired) return { allowed: false, reason: "expired" as const };
      if (!reservation) return { allowed: true, reservationId: null };
      return admitMemberClaim(tx as unknown as Db, reservation, issueId, run.id);
    });
  }

  async function admitMemberClaim(
    tx: Db,
    reservation: typeof g6CertificationReservations.$inferSelect,
    issueId: string | null,
    runId: string,
  ) {
    if (!issueId) return { allowed: false, reason: "non_reserved_issue" as const };
    const member = await tx.select().from(g6CertificationReservationIssues).where(and(
      eq(g6CertificationReservationIssues.reservationId, reservation.id),
      eq(g6CertificationReservationIssues.issueId, issueId),
    )).for("update").limit(1).then((rows) => rows[0] ?? null);
    if (!member) return { allowed: false, reason: "non_reserved_issue" as const };
    if (member.admittedRunId && member.admittedRunId !== runId) {
      return { allowed: false, reason: "duplicate_reserved_issue_run" as const };
    }
    if (!member.admittedRunId) {
      await tx.update(g6CertificationReservationIssues).set({ admittedRunId: runId, updatedAt: new Date() })
        .where(and(
          eq(g6CertificationReservationIssues.reservationId, reservation.id),
          eq(g6CertificationReservationIssues.issueId, issueId),
          isNull(g6CertificationReservationIssues.admittedRunId),
        ));
    }
    return { allowed: true, reservationId: reservation.id };
  }

  async function close(input: {
    companyId: string;
    agentId: string;
    reservationId: string;
    actor: G6ReservationActor;
    mode: "verify_release" | "abort";
    reason?: string;
  }) {
    return db.transaction(async (tx) => {
      await lockAdmission(tx as unknown as Db, input.companyId, input.agentId);
      const reservation = await tx.select().from(g6CertificationReservations).where(and(
        eq(g6CertificationReservations.id, input.reservationId),
        eq(g6CertificationReservations.companyId, input.companyId),
        eq(g6CertificationReservations.agentId, input.agentId),
      )).for("update").limit(1).then((rows) => rows[0] ?? null);
      if (!reservation) throw notFound("G6 certification reservation not found");
      if (reservation.status === "released" && input.mode === "verify_release") {
        return { ...reservation, issues: await listMembers(tx as unknown as Db, reservation.id) };
      }
      if (reservation.status !== "active") {
        throw conflict("G6 certification reservation close mode does not match its existing disposition", {
          status: reservation.status,
          requestedMode: input.mode,
        });
      }
      if (await expireLocked(tx as unknown as Db, reservation, new Date())) {
        const expired = await tx.select().from(g6CertificationReservations)
          .where(eq(g6CertificationReservations.id, reservation.id))
          .limit(1).then((rows) => rows[0]!);
        return { ...expired, issues: await listMembers(tx as unknown as Db, reservation.id) };
      }
      const agent = await tx.select().from(agents).where(and(
        eq(agents.id, input.agentId),
        eq(agents.companyId, input.companyId),
      )).for("update").limit(1).then((rows) => rows[0] ?? null);
      if (!agent) throw notFound("Agent not found");
      const members = await listMembers(tx as unknown as Db, reservation.id);
      const activeRun = await tx.select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
        .from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId),
          inArray(heartbeatRuns.status, [...ACTIVE_RUN_STATUSES]),
        )).limit(1).then((rows) => rows[0] ?? null);
      const now = new Date();
      let verification: Record<string, unknown> | null = null;
      if (input.mode === "verify_release") {
        if (activeRun) throw conflict("Agent has not drained", activeRun);
        if (agent.status !== "idle" || maxConcurrentRuns(agent.runtimeConfig) !== reservation.expectedIssueCount) {
          throw conflict("Agent is not drained at the reserved concurrency preset", {
            status: agent.status,
            maxConcurrentRuns: maxConcurrentRuns(agent.runtimeConfig),
            expectedConcurrentRuns: reservation.expectedIssueCount,
          });
        }
        const runRows = await tx.select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          contextSnapshot: heartbeatRuns.contextSnapshot,
          nativeIssueId: heartbeatRuns.nativeIssueId,
          createdAt: heartbeatRuns.createdAt,
        }).from(heartbeatRuns).where(and(
          eq(heartbeatRuns.companyId, input.companyId),
          eq(heartbeatRuns.agentId, input.agentId),
          gte(heartbeatRuns.createdAt, reservation.reservedAt),
        ));
        const terminalByIssue = new Map<string, typeof runRows>();
        for (const run of runRows) {
          const runIssueId = typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : run.nativeIssueId;
          if (!runIssueId) continue;
          const rows = terminalByIssue.get(runIssueId) ?? [];
          rows.push(run);
          terminalByIssue.set(runIssueId, rows);
        }
        const receipts = members.map((member) => ({ member, runs: terminalByIssue.get(member.issueId) ?? [] }));
        const invalid = receipts.filter(({ member, runs }) =>
          runs.length !== 1 || runs[0]?.status !== "succeeded" || member.admittedRunId !== runs[0]?.id,
        );
        if (invalid.length > 0) {
          throw conflict("Reservation cannot be released until every issue has exactly one admitted succeeded run", {
            issues: invalid.map(({ member, runs }) => ({ issueId: member.issueId, admittedRunId: member.admittedRunId, runs: runs.map((run) => ({ id: run.id, status: run.status })) })),
          });
        }
        for (const { member, runs } of receipts) {
          await tx.update(g6CertificationReservationIssues).set({ terminalRunId: runs[0]!.id, updatedAt: now })
            .where(and(eq(g6CertificationReservationIssues.reservationId, reservation.id), eq(g6CertificationReservationIssues.issueId, member.issueId)));
        }
        verification = { issueRuns: receipts.map(({ member, runs }) => ({ issueId: member.issueId, runId: runs[0]!.id, status: "succeeded" })) };
      }
      const status = input.mode === "verify_release" ? "released" : "aborted";
      await tx.update(g6CertificationReservations).set({
        status,
        releasedAt: input.mode === "verify_release" ? now : null,
        abortedAt: input.mode === "abort" ? now : null,
        closeReason: input.reason ?? (input.mode === "abort" ? "Operator aborted reservation" : "Verified and released"),
        closedByUserId: input.actor.userId,
        verification,
        containmentRequiredAt: input.mode === "abort" ? now : null,
        updatedAt: now,
      }).where(and(eq(g6CertificationReservations.id, reservation.id), eq(g6CertificationReservations.status, "active")));
      await tx.update(agents).set({
        status: input.mode === "abort" ? "paused" : "idle",
        runtimeConfig: reservation.previousRuntimeConfig,
        pauseReason: input.mode === "abort" ? (input.reason ?? "G6 certification reservation aborted") : null,
        pausedAt: input.mode === "abort" ? now : null,
        updatedAt: now,
      }).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));
      await tx.update(agentWakeupRequests).set({
        status: "skipped",
        finishedAt: now,
        error: input.mode === "abort"
          ? "G6 reservation aborted; wake must be retried after operator recovery"
          : "G6 reservation released; normal scheduling may retry this wake",
        updatedAt: now,
      }).where(and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.agentId, input.agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"),
        sql`${agentWakeupRequests.payload}->>'g6CertificationReservationId' = ${reservation.id}`,
      ));
      await tx.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "user",
        actorId: input.actor.userId,
        action: input.mode === "verify_release"
          ? "g6_certification.reservation_verified_released"
          : "g6_certification.reservation_aborted",
        entityType: "g6_certification_reservation",
        entityId: reservation.id,
        details: { agentId: input.agentId, reason: input.reason ?? null, verification },
      });
      const closed = await tx.select().from(g6CertificationReservations)
        .where(eq(g6CertificationReservations.id, reservation.id))
        .limit(1).then((rows) => rows[0]!);
      return { ...closed, issues: await listMembers(tx as unknown as Db, reservation.id) };
    });
  }

  return {
    create,
    getActive,
    getById,
    expireDue,
    markContainmentCompleted,
    admitWake,
    admitClaim,
    verifyAndRelease: (input: Omit<Parameters<typeof close>[0], "mode">) => close({ ...input, mode: "verify_release" }),
    abort: (input: Omit<Parameters<typeof close>[0], "mode">) => close({ ...input, mode: "abort" }),
  };
}
