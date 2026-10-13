CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_ctx_recovery_action_created_idx" ON "heartbeat_runs" USING btree ("company_id", (("context_snapshot" ->> 'recoveryActionId')), "created_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_retry_of_run_idx" ON "heartbeat_runs" USING btree ("company_id", "retry_of_run_id") WHERE "retry_of_run_id" IS NOT NULL;
