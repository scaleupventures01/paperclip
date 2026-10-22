/**
 * Measurement harness for migration 0284 (heartbeat_runs context key columns).
 *
 * Starts a throwaway embedded Postgres (never a shared or production database),
 * applies every migration, seeds heartbeat_runs rows whose context_snapshot is
 * about 27 KB of poorly compressible text (the 2026-10-21 production average),
 * then prints EXPLAIN (ANALYZE, BUFFERS) for the attention feed's newer-run scan
 * in its old form (projecting context_snapshot ->> 'issueId'/'taskId') and its
 * new form (narrow columns, grouped). It also times the 0284 backfill and index
 * build on the seeded rows, for the rollout runbook.
 *
 *   pnpm --filter @paperclipai/db exec tsx scripts/bench-heartbeat-context-keys.ts
 *
 * Environment: BENCH_ROWS (default 10000), BENCH_AGENTS (default 10),
 * BENCH_SNAPSHOT_HEX_BLOCKS (default 860; each block is 32 hex chars).
 */
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import postgres from "postgres";
import { startEmbeddedPostgresTestDatabase } from "../src/test-embedded-postgres.js";

const ROWS = Number(process.env.BENCH_ROWS ?? 10_000);
const AGENTS = Number(process.env.BENCH_AGENTS ?? 10);
const HEX_BLOCKS = Number(process.env.BENCH_SNAPSHOT_HEX_BLOCKS ?? 860);
const BATCH = 500;
const REPEATS = 3;

const OLD_QUERY = `
select "agent_id", "created_at",
  "context_snapshot" ->> 'issueId' as run_issue_id,
  "context_snapshot" ->> 'taskId' as run_task_id
from "heartbeat_runs"
where "company_id" = $1 and "agent_id" = any($2::uuid[]) and "created_at" > $3`;

const NEW_QUERY = `
select "agent_id", "context_issue_id", "context_task_id", max("created_at") as created_at
from "heartbeat_runs"
where "company_id" = $1 and "agent_id" = any($2::uuid[]) and "created_at" > $3
group by "agent_id", "context_issue_id", "context_task_id"`;

function backfillAndIndexStatements(migrationSql: string) {
  const statements = migrationSql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const backfill = statements.find((statement) => /UPDATE "heartbeat_runs"/.test(statement));
  const index = statements.find((statement) => /CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_agent_created_ctx_keys_idx"/.test(statement));
  if (!backfill || !index) throw new Error("0284 backfill or index statement not found");
  return { backfill, index };
}

async function main() {
  const db = await startEmbeddedPostgresTestDatabase("bench-hb-ctx-keys-");
  const sql = postgres(db.connectionString, { max: 1, onnotice: () => {} });
  try {
    const [company] = await sql<{ id: string }[]>`
      INSERT INTO companies (name, issue_prefix) VALUES ('Bench Co', 'BEN') RETURNING id`;
    const agentRows = await sql<{ id: string }[]>`
      INSERT INTO agents (company_id, name, role, status, adapter_type, adapter_config, runtime_config, permissions)
      SELECT ${company!.id}, 'Agent ' || n, 'engineer', 'idle', 'codex_local', '{}', '{}', '{}'
      FROM generate_series(1, ${AGENTS}) AS n RETURNING id`;
    const agentIds = agentRows.map((row) => row.id);

    const seedStart = performance.now();
    for (let offset = 0; offset < ROWS; offset += BATCH) {
      const count = Math.min(BATCH, ROWS - offset);
      await sql`
        INSERT INTO heartbeat_runs (company_id, agent_id, status, context_snapshot, created_at, updated_at)
        SELECT ${company!.id}::uuid,
          (${sql.array(agentIds)}::uuid[])[1 + (s.i % ${AGENTS}::int)],
          'succeeded',
          jsonb_build_object(
            'issueId', 'issue-' || (s.i % 400),
            'taskId', case when s.i % 7 = 0 then 'task-' || (s.i % 50) end,
            'prompt', (SELECT string_agg(md5(random()::text || s.i::text || g::text), '')
              FROM generate_series(1, ${HEX_BLOCKS}::int) AS g)
          ),
          now() - make_interval(secs => ${ROWS}::int - s.i),
          now()
        FROM (SELECT ${offset}::int + n AS i FROM generate_series(1, ${count}::int) AS n) AS s`;
    }
    const seedMs = performance.now() - seedStart;
    await sql.unsafe("VACUUM ANALYZE heartbeat_runs");

    const [shape] = await sql<{ rows: string; avg_snapshot_bytes: string; max_snapshot_bytes: string; total_bytes: string }[]>`
      SELECT count(*)::text AS rows,
        round(avg(pg_column_size(context_snapshot)))::text AS avg_snapshot_bytes,
        max(pg_column_size(context_snapshot))::text AS max_snapshot_bytes,
        pg_total_relation_size('heartbeat_runs')::text AS total_bytes
      FROM heartbeat_runs`;
    console.log(`# seeded ${shape!.rows} rows in ${seedMs.toFixed(0)} ms; context_snapshot pg_column_size avg ${shape!.avg_snapshot_bytes} B, max ${shape!.max_snapshot_bytes} B; heartbeat_runs total ${shape!.total_bytes} B`);

    const params = [company!.id, agentIds, new Date(0).toISOString()];
    for (const [label, query] of [["OLD (context_snapshot ->> projection)", OLD_QUERY], ["NEW (narrow columns, grouped)", NEW_QUERY]] as const) {
      const wall: number[] = [];
      let returned = 0;
      for (let attempt = 0; attempt < REPEATS; attempt += 1) {
        const start = performance.now();
        const rows = await sql.unsafe(query, params as never[]);
        wall.push(performance.now() - start);
        returned = rows.length;
      }
      const plan = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${query}`, params as never[]);
      console.log(`\n## ${label}`);
      console.log(`rows returned: ${returned}; wall ms per run: ${wall.map((ms) => ms.toFixed(1)).join(", ")}`);
      console.log(plan.map((row) => Object.values(row)[0]).join("\n"));
    }

    // Backfill and index build cost on the seeded rows: clear the keys the
    // trigger wrote, then run the exact 0284 statements.
    const migration = await readFile(new URL("../src/migrations/0284_nosy_terror.sql", import.meta.url), "utf8");
    const { backfill, index } = backfillAndIndexStatements(migration);
    await sql.unsafe("DROP INDEX IF EXISTS heartbeat_runs_company_agent_created_ctx_keys_idx");
    await sql.unsafe("UPDATE heartbeat_runs SET context_issue_id = NULL, context_task_id = NULL");
    await sql.unsafe("VACUUM ANALYZE heartbeat_runs");
    let start = performance.now();
    const result = await sql.unsafe(backfill);
    const backfillMs = performance.now() - start;
    start = performance.now();
    await sql.unsafe(index);
    const indexMs = performance.now() - start;
    console.log(`\n## 0284 one-time cost on ${shape!.rows} rows`);
    console.log(`backfill UPDATE: ${backfillMs.toFixed(0)} ms (${result.count} rows); CREATE INDEX: ${indexMs.toFixed(0)} ms`);
  } finally {
    await sql.end();
    await db.cleanup();
  }
}

await main();
