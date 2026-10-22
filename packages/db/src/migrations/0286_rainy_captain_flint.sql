-- Narrow copies of the two hot context_snapshot keys. Reading
-- context_snapshot ->> 'issueId' for many rows detoasts every whole snapshot
-- (about 27 KB average, up to about 1 MB), which made the attention feed take
-- 20+ seconds. Plain nullable columns with no default are a catalog-only
-- change: no table rewrite, unlike a STORED generated column, which would
-- rewrite the whole table under ACCESS EXCLUSIVE.
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_issue_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_task_id" text;--> statement-breakpoint
-- Write-time population. The trigger reads NEW.context_snapshot while it is
-- still the in-memory value being written, so it never detoasts a stored row.
-- UPDATE OF context_snapshot keeps unrelated status updates trigger-free.
CREATE OR REPLACE FUNCTION heartbeat_runs_sync_context_keys() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  NEW.context_issue_id := NEW.context_snapshot ->> 'issueId';
  NEW.context_task_id := NEW.context_snapshot ->> 'taskId';
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE OR REPLACE TRIGGER heartbeat_runs_sync_context_keys
BEFORE INSERT OR UPDATE OF context_snapshot ON heartbeat_runs
FOR EACH ROW EXECUTE FUNCTION heartbeat_runs_sync_context_keys();--> statement-breakpoint
-- One-time backfill of rows written before this migration. The ALTER TABLE
-- above already holds ACCESS EXCLUSIVE until this migration commits, so no
-- writer can land a row between the trigger install and this backfill.
-- Expected cost on the 2026-10-21 production shape (29,958 rows, 2,753 MB):
-- one pass that detoasts each snapshot once; measured locally in
-- packages/db/scripts/bench-heartbeat-context-keys.ts. Migrations run at server boot before
-- the API listens, so the lock costs startup time, not live requests.
-- Re-running is a no-op: rows already filled no longer match.
UPDATE "heartbeat_runs"
SET "context_issue_id" = "context_snapshot" ->> 'issueId',
    "context_task_id" = "context_snapshot" ->> 'taskId'
WHERE "context_issue_id" IS NULL
  AND "context_task_id" IS NULL
  AND "context_snapshot" ?| array['issueId', 'taskId'];--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable. The build reads only the main heap (no TOAST) and runs at boot before the API listens; it replaces a full-snapshot detoast on every attention feed request.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_agent_created_ctx_keys_idx" ON "heartbeat_runs" USING btree ("company_id","agent_id","created_at","context_issue_id","context_task_id");
