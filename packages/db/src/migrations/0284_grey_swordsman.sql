CREATE TABLE "g6_certification_reservation_issues" (
	"reservation_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"admitted_run_id" uuid,
	"terminal_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "g6_certification_reservation_issues_reservation_id_issue_id_pk" PRIMARY KEY("reservation_id","issue_id")
);
--> statement-breakpoint
CREATE TABLE "g6_certification_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"expected_issue_count" integer NOT NULL,
	"previous_runtime_config" jsonb NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"aborted_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"close_reason" text,
	"created_by_user_id" text NOT NULL,
	"closed_by_user_id" text,
	"verification" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "g6_certification_reservation_issues" ADD CONSTRAINT "g6_certification_reservation_issues_reservation_id_g6_certification_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."g6_certification_reservations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "g6_certification_reservation_issues" ADD CONSTRAINT "g6_certification_reservation_issues_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "g6_certification_reservation_issues" ADD CONSTRAINT "g6_certification_reservation_issues_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "g6_certification_reservation_issues" ADD CONSTRAINT "g6_certification_reservation_issues_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "g6_certification_reservation_issues" ADD CONSTRAINT "g6_certification_reservation_issues_admitted_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("admitted_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "g6_certification_reservation_issues" ADD CONSTRAINT "g6_certification_reservation_issues_terminal_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("terminal_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "g6_certification_reservations" ADD CONSTRAINT "g6_certification_reservations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "g6_certification_reservations" ADD CONSTRAINT "g6_certification_reservations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "g6_certification_reservation_issues_ordinal_uq" ON "g6_certification_reservation_issues" USING btree ("reservation_id","ordinal");--> statement-breakpoint
CREATE INDEX "g6_certification_reservation_issues_agent_issue_idx" ON "g6_certification_reservation_issues" USING btree ("company_id","agent_id","issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "g6_certification_reservations_one_active_agent_uq" ON "g6_certification_reservations" USING btree ("company_id","agent_id") WHERE "g6_certification_reservations"."status" = 'active';--> statement-breakpoint
CREATE INDEX "g6_certification_reservations_company_status_expiry_idx" ON "g6_certification_reservations" USING btree ("company_id","status","expires_at");
--> statement-breakpoint
-- Serialize actionable demand changes with G6 reserve-and-activate.  The
-- trigger does not reject normal issue assignment: a concurrent mutation
-- either commits before the reservation's exact-demand scan or waits until
-- after activation, where heartbeat admission durably defers it.
CREATE OR REPLACE FUNCTION lock_g6_agent_actionable_demand()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  lock_key text;
  old_key text;
  new_key text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE')
     AND OLD.assignee_agent_id IS NOT NULL
     AND OLD.status IN ('todo', 'in_progress')
     AND OLD.assignee_user_id IS NULL
     AND OLD.hidden_at IS NULL THEN
    old_key := OLD.company_id::text || ':' || OLD.assignee_agent_id::text;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE')
     AND NEW.assignee_agent_id IS NOT NULL
     AND NEW.status IN ('todo', 'in_progress')
     AND NEW.assignee_user_id IS NULL
     AND NEW.hidden_at IS NULL THEN
    new_key := NEW.company_id::text || ':' || NEW.assignee_agent_id::text;
  END IF;
  FOR lock_key IN
    SELECT DISTINCT key FROM unnest(ARRAY[old_key, new_key]) AS keys(key)
    WHERE key IS NOT NULL ORDER BY key
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(lock_key, 0));
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER issues_g6_actionable_demand_lock
BEFORE INSERT OR UPDATE OF company_id, assignee_agent_id, assignee_user_id, status, hidden_at OR DELETE
ON issues
FOR EACH ROW
EXECUTE FUNCTION lock_g6_agent_actionable_demand();
--> statement-breakpoint
-- Pause-hold membership participates in actionable demand. Lock both the
-- member's captured assignee and the issue's current assignee for insert,
-- update, and delete so skipped/member changes cannot cross activation.
CREATE OR REPLACE FUNCTION lock_g6_hold_member_demand()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  lock_key text;
  old_key text;
  new_key text;
  old_issue_id uuid;
  new_issue_id uuid;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    old_issue_id := OLD.issue_id;
    IF OLD.assignee_agent_id IS NOT NULL THEN
      old_key := OLD.company_id::text || ':' || OLD.assignee_agent_id::text;
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    new_issue_id := NEW.issue_id;
    IF NEW.assignee_agent_id IS NOT NULL THEN
      new_key := NEW.company_id::text || ':' || NEW.assignee_agent_id::text;
    END IF;
  END IF;
  FOR lock_key IN
    SELECT DISTINCT candidate.key
    FROM (
      SELECT key FROM unnest(ARRAY[old_key, new_key]) AS keys(key)
      UNION ALL
      SELECT i.company_id::text || ':' || i.assignee_agent_id::text AS key
      FROM issues i
      WHERE i.id IN (old_issue_id, new_issue_id)
        AND i.assignee_agent_id IS NOT NULL
    ) candidate
    WHERE candidate.key IS NOT NULL
    ORDER BY candidate.key
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(lock_key, 0));
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER issue_tree_hold_members_g6_demand_lock
BEFORE INSERT OR UPDATE OF company_id, issue_id, assignee_agent_id, skipped OR DELETE
ON issue_tree_hold_members
FOR EACH ROW
EXECUTE FUNCTION lock_g6_hold_member_demand();
--> statement-breakpoint
-- Activating, releasing, changing, or deleting a hold changes every member's
-- actionable state. Lock all affected current/captured assignees in stable order.
CREATE OR REPLACE FUNCTION lock_g6_hold_state_demand()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_hold_id uuid;
  lock_key text;
BEGIN
  target_hold_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  FOR lock_key IN
    SELECT DISTINCT candidate.key
    FROM (
      SELECT m.company_id::text || ':' || m.assignee_agent_id::text AS key
      FROM issue_tree_hold_members m
      WHERE m.hold_id = target_hold_id AND m.assignee_agent_id IS NOT NULL
      UNION ALL
      SELECT i.company_id::text || ':' || i.assignee_agent_id::text AS key
      FROM issue_tree_hold_members m
      JOIN issues i ON i.id = m.issue_id
      WHERE m.hold_id = target_hold_id AND i.assignee_agent_id IS NOT NULL
    ) candidate
    ORDER BY candidate.key
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(lock_key, 0));
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER issue_tree_holds_g6_demand_lock
BEFORE UPDATE OF status, mode OR DELETE
ON issue_tree_holds
FOR EACH ROW
EXECUTE FUNCTION lock_g6_hold_state_demand();
--> statement-breakpoint
-- A queued/running admission is part of the same reserve precondition. This
-- lock makes the zero-run scan and activation boundary exact without changing
-- ordinary heartbeat behavior when no reservation is being created.
CREATE OR REPLACE FUNCTION lock_g6_agent_heartbeat_admission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  bound_reservation_id uuid;
  active_reservation_id uuid;
  reserved_issue_id uuid;
BEGIN
  IF NEW.status IN ('queued', 'running', 'scheduled_retry') THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(NEW.company_id::text || ':' || NEW.agent_id::text, 0)
    );

    -- A wake admitted under a reservation remains bound to that reservation
    -- through insertion/dispatch. If close/expiry wins the lock before this
    -- write, terminalize the placeholder instead of leaving latent queued work.
    BEGIN
      bound_reservation_id := NULLIF(
        NEW.context_snapshot->>'g6CertificationReservationId', ''
      )::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      bound_reservation_id := NULL;
    END;

    SELECT r.id INTO active_reservation_id
    FROM g6_certification_reservations r
    WHERE r.company_id = NEW.company_id
      AND r.agent_id = NEW.agent_id
      AND r.status = 'active'
      AND r.expires_at > now()
    LIMIT 1;

    IF active_reservation_id IS NOT NULL THEN
      SELECT m.issue_id INTO reserved_issue_id
      FROM g6_certification_reservation_issues m
      WHERE m.reservation_id = active_reservation_id
        AND m.issue_id::text = NEW.context_snapshot->>'issueId'
      LIMIT 1;
    END IF;

    IF (bound_reservation_id IS NOT NULL AND
        bound_reservation_id IS DISTINCT FROM active_reservation_id)
       OR (active_reservation_id IS NOT NULL AND
           (bound_reservation_id IS DISTINCT FROM active_reservation_id OR
            reserved_issue_id IS NULL)) THEN
      NEW.status := 'cancelled';
      NEW.finished_at := now();
      NEW.error := 'Cancelled by G6 certification reservation admission fence';
      NEW.error_code := CASE
        WHEN active_reservation_id IS NULL THEN 'g6_certification_reservation_closed'
        ELSE 'g6_certification_non_reserved_issue'
      END;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER heartbeat_runs_g6_admission_lock
BEFORE INSERT OR UPDATE OF company_id, agent_id, status
ON heartbeat_runs
FOR EACH ROW
EXECUTE FUNCTION lock_g6_agent_heartbeat_admission();
