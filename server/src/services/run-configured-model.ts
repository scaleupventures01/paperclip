import { and, inArray, sql } from "drizzle-orm";
import { agents, heartbeatRuns, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// agentos#2104: every heartbeat run that ends records which model it was for.
// When the adapter reported usage, the finish path already wrote usageJson
// with the adapter's model, and this helper leaves it alone. When a run ends
// with no adapter usage (cancelled while queued or started, failed before the
// adapter answered, interrupted, timed out, or finished with nothing
// reported), this records the agent's configured model, adapterConfig.model,
// with usageSource "configured", or model "unknown" when none is configured.
//
// The write is guarded in SQL: it only touches rows that are already terminal
// and whose usageJson has no model, so it can never replace a measured model
// and running rows are never stamped. Callers run it right after their own
// terminal write, only for runs that write just ended.
export const CONFIGURED_RUN_MODEL_USAGE_SOURCE = "configured";
export const CONFIGURED_RUN_MODEL_FALLBACK = "unknown";

const RUN_MODEL_TERMINAL_STATUSES = [
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
] as const;

export function heartbeatRunUsageHasModel(usageJson: unknown): boolean {
  if (!usageJson || typeof usageJson !== "object" || Array.isArray(usageJson)) {
    return false;
  }
  const model = (usageJson as Record<string, unknown>).model;
  return typeof model === "string" && model.trim().length > 0;
}

export async function recordConfiguredRunModel(
  db: Db,
  runIds: ReadonlyArray<string | null | undefined>,
): Promise<Array<typeof heartbeatRuns.$inferSelect>> {
  const ids = [...new Set(runIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return [];
  try {
    return await db
      .update(heartbeatRuns)
      .set({
        usageJson: sql`(case when jsonb_typeof(${heartbeatRuns.usageJson}) = 'object' then ${heartbeatRuns.usageJson} else '{}'::jsonb end) || jsonb_build_object(
          'model', coalesce(
            (select nullif(btrim(${agents.adapterConfig}->>'model'), '') from ${agents} where ${agents.id} = ${heartbeatRuns.agentId}),
            ${CONFIGURED_RUN_MODEL_FALLBACK}::text
          ),
          'usageSource', ${CONFIGURED_RUN_MODEL_USAGE_SOURCE}::text
        )`,
      })
      .where(
        and(
          inArray(heartbeatRuns.id, ids),
          inArray(heartbeatRuns.status, [...RUN_MODEL_TERMINAL_STATUSES]),
          sql`(${heartbeatRuns.usageJson} is null
            or jsonb_typeof(${heartbeatRuns.usageJson}) <> 'object'
            or nullif(btrim(${heartbeatRuns.usageJson}->>'model'), '') is null)`,
        ),
      )
      .returning();
  } catch (error) {
    // Recording the model is bookkeeping. It must never undo or block the
    // terminal write that already happened.
    logger.warn({ error, runIds: ids }, "failed to record configured model for ended heartbeat runs");
    return [];
  }
}
