import { sql } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

/**
 * A short-lived, operator-created admission fence for an exact G6 certification
 * batch.  This is intentionally durable rather than agent runtimeConfig: the
 * fence must survive a server restart and remain in force until verification,
 * an explicit fail-closed abort, or fail-closed expiry.
 */
export const g6CertificationReservations = pgTable(
  "g6_certification_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    expectedIssueCount: integer("expected_issue_count").notNull(),
    previousRuntimeConfig: jsonb("previous_runtime_config").$type<Record<string, unknown>>().notNull(),
    reservedAt: timestamp("reserved_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    abortedAt: timestamp("aborted_at", { withTimezone: true }),
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    containmentRequiredAt: timestamp("containment_required_at", { withTimezone: true }),
    containmentCompletedAt: timestamp("containment_completed_at", { withTimezone: true }),
    closeReason: text("close_reason"),
    createdByUserId: text("created_by_user_id").notNull(),
    closedByUserId: text("closed_by_user_id"),
    verification: jsonb("verification").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    oneActivePerAgent: uniqueIndex("g6_certification_reservations_one_active_agent_uq")
      .on(table.companyId, table.agentId)
      .where(sql`${table.status} = 'active'`),
    companyStatusExpiryIdx: index("g6_certification_reservations_company_status_expiry_idx")
      .on(table.companyId, table.status, table.expiresAt),
  }),
);

export const g6CertificationReservationIssues = pgTable(
  "g6_certification_reservation_issues",
  {
    reservationId: uuid("reservation_id").notNull().references(() => g6CertificationReservations.id, { onDelete: "cascade" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").notNull().references(() => agents.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "restrict" }),
    ordinal: integer("ordinal").notNull(),
    admittedRunId: uuid("admitted_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    terminalRunId: uuid("terminal_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.reservationId, table.issueId] }),
    reservationOrdinalUq: uniqueIndex("g6_certification_reservation_issues_ordinal_uq")
      .on(table.reservationId, table.ordinal),
    activeLookupIdx: index("g6_certification_reservation_issues_agent_issue_idx")
      .on(table.companyId, table.agentId, table.issueId),
  }),
);
