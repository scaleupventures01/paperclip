import { and, eq, gt, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const STATEMENT_TIMEOUT_MS = 5_000;

type NewerRunKeyRow = {
  agentId: string;
  createdAt: Date;
  runIssueId: string | null;
  runTaskId: string | null;
};

function isStatementTimeout(error: unknown) {
  let current: unknown = error;
  while (current) {
    if ((current as { code?: unknown } | null)?.code === "57014") return true;
    current = (current as { cause?: unknown } | null)?.cause;
  }
  return false;
}

function contextKeyEquals(expression: SQL, values: string[]) {
  const conditions = values.map((value) => eq(expression, value));
  return conditions.length === 1 ? conditions[0]! : or(...conditions);
}

export async function withAttentionStatementTimeout<T>(
  db: Db,
  query: (database: Db) => Promise<T>,
  timeoutMs = STATEMENT_TIMEOUT_MS,
) {
  const startedAt = Date.now();
  try {
    return await db.transaction(async (transaction) => {
      await transaction.execute(sql.raw(`set local statement_timeout = ${timeoutMs}`));
      return query(transaction as Db);
    }, { accessMode: "read only" });
  } catch (error) {
    if (isStatementTimeout(error)) {
      logger.warn(
        { durationMs: Date.now() - startedAt, timeoutMs },
        "attention newer-run lookup exceeded its lease-safety statement timeout",
      );
    }
    throw error;
  }
}

export function listAttentionNewerRunKeys(
  db: Db,
  input: {
    companyId: string;
    agentIds: string[];
    issueIds: string[];
    taskIds: string[];
    hasEmptyRunKey: boolean;
    oldestRunCreatedAt: Date;
  },
) {
  const sharedFilters = and(
    eq(heartbeatRuns.companyId, input.companyId),
    gt(heartbeatRuns.createdAt, input.oldestRunCreatedAt),
  );
  const agentScopedFilters = and(
    sharedFilters,
    inArray(heartbeatRuns.agentId, input.agentIds),
  );
  const columns = {
    agentId: heartbeatRuns.agentId,
    createdAt: heartbeatRuns.createdAt,
    runIssueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
    runTaskId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'taskId'`,
  };
  const queries: Array<Promise<NewerRunKeyRow[]>> = [];

  if (input.issueIds.length > 0) {
    queries.push(withAttentionStatementTimeout(db, (database) => database
      .select(columns)
      .from(heartbeatRuns)
      .where(and(
        sharedFilters,
        contextKeyEquals(
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
          input.issueIds,
        ),
      ))));
  }
  if (input.taskIds.length > 0) {
    queries.push(withAttentionStatementTimeout(db, (database) => database
      .select(columns)
      .from(heartbeatRuns)
      .where(and(
        sharedFilters,
        contextKeyEquals(
          sql`${heartbeatRuns.contextSnapshot} ->> 'taskId'`,
          input.taskIds,
        ),
      ))));
  }
  if (input.hasEmptyRunKey) {
    queries.push(withAttentionStatementTimeout(db, (database) => database
      .select(columns)
      .from(heartbeatRuns)
      .where(and(
        agentScopedFilters,
        or(
          isNull(heartbeatRuns.contextSnapshot),
          and(
            sql`${heartbeatRuns.contextSnapshot} -> 'issueId' is null`,
            sql`${heartbeatRuns.contextSnapshot} -> 'taskId' is null`,
          ),
        ),
      ))));
  }

  return Promise.all(queries).then((rows) => rows.flat());
}
