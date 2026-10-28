import { heartbeatRuns, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";

export async function hasAgentStartCapacity(
  tx: Db,
  agentId: string,
  maxConcurrentRuns: number,
  lockTimeoutMs = 5_000,
) {
  await tx.execute(
    sql`select set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`,
  );
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`heartbeat-agent-start:${agentId}`}, 0))`,
  );
  const [{ count }] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.agentId, agentId),
        eq(heartbeatRuns.status, "running"),
      ),
    );
  return Number(count ?? 0) < maxConcurrentRuns;
}
