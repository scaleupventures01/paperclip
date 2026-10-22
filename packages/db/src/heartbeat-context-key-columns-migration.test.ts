import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./test-embedded-postgres.js";

const cleanups: Array<() => Promise<void>> = [];
const support = await getEmbeddedPostgresTestSupport();
const d = support.supported ? describe : describe.skip;

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function migrationStatements(): Promise<string[]> {
  const dir = fileURLToPath(new URL("./migrations", import.meta.url));
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  const matches: string[] = [];
  for (const file of files) {
    const content = await readFile(new URL(`./migrations/${file}`, import.meta.url), "utf8");
    if (content.includes("heartbeat_runs_sync_context_keys")) matches.push(content);
  }
  expect(matches).toHaveLength(1);
  return matches[0]!
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

d("heartbeat_runs context key columns migration", () => {
  it("keeps context_issue_id/context_task_id in step with context_snapshot and backfills old rows", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("hb-ctx-keys-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => { await sql.end(); });

    const columns = await sql<{ column_name: string; data_type: string }[]>`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'heartbeat_runs' AND column_name IN ('context_issue_id', 'context_task_id')
      ORDER BY column_name`;
    expect(columns).toEqual([
      { column_name: "context_issue_id", data_type: "text" },
      { column_name: "context_task_id", data_type: "text" },
    ]);

    const [company] = await sql<{ id: string }[]>`
      INSERT INTO companies (name, issue_prefix) VALUES ('Ctx Co', 'CTX') RETURNING id`;
    const [agent] = await sql<{ id: string }[]>`
      INSERT INTO agents (company_id, name, role, status, adapter_type, adapter_config, runtime_config, permissions)
      VALUES (${company!.id}, 'Worker', 'engineer', 'idle', 'codex_local', '{}', '{}', '{}') RETURNING id`;

    // Insert path: the trigger derives both keys from the snapshot.
    const [run] = await sql<{ id: string; context_issue_id: string | null; context_task_id: string | null }[]>`
      INSERT INTO heartbeat_runs (company_id, agent_id, status, context_snapshot)
      VALUES (${company!.id}, ${agent!.id}, 'queued', ${sql.json({ issueId: "issue-a", taskId: "task-a", prompt: "p" })})
      RETURNING id, context_issue_id, context_task_id`;
    expect(run).toMatchObject({ context_issue_id: "issue-a", context_task_id: "task-a" });

    // Update path: replacing the snapshot moves the keys with it.
    const [moved] = await sql<{ context_issue_id: string | null; context_task_id: string | null }[]>`
      UPDATE heartbeat_runs SET context_snapshot = ${sql.json({ taskId: "task-b" })}
      WHERE id = ${run!.id} RETURNING context_issue_id, context_task_id`;
    expect(moved).toEqual({ context_issue_id: null, context_task_id: "task-b" });

    // Merge-style update (the shape heartbeat.ts uses) also re-derives.
    const [merged] = await sql<{ context_issue_id: string | null; context_task_id: string | null }[]>`
      UPDATE heartbeat_runs SET context_snapshot = context_snapshot || ${sql.json({ issueId: "issue-c" })}
      WHERE id = ${run!.id} RETURNING context_issue_id, context_task_id`;
    expect(merged).toEqual({ context_issue_id: "issue-c", context_task_id: "task-b" });

    // An update that does not touch context_snapshot leaves the keys alone.
    const [untouched] = await sql<{ context_issue_id: string | null }[]>`
      UPDATE heartbeat_runs SET status = 'running' WHERE id = ${run!.id} RETURNING context_issue_id`;
    expect(untouched?.context_issue_id).toBe("issue-c");

    // Null snapshot clears both keys.
    const [cleared] = await sql<{ context_issue_id: string | null; context_task_id: string | null }[]>`
      UPDATE heartbeat_runs SET context_snapshot = NULL WHERE id = ${run!.id}
      RETURNING context_issue_id, context_task_id`;
    expect(cleared).toEqual({ context_issue_id: null, context_task_id: null });

    // Backfill: simulate rows written before the migration (keys absent),
    // then re-run the migration statements. They must be idempotent and must
    // fill the keys from the snapshot without touching unrelated rows.
    const [legacy] = await sql<{ id: string }[]>`
      INSERT INTO heartbeat_runs (company_id, agent_id, status, context_snapshot)
      VALUES (${company!.id}, ${agent!.id}, 'succeeded', ${sql.json({ issueId: "issue-old", taskId: "task-old" })})
      RETURNING id`;
    const [noKeys] = await sql<{ id: string }[]>`
      INSERT INTO heartbeat_runs (company_id, agent_id, status, context_snapshot)
      VALUES (${company!.id}, ${agent!.id}, 'succeeded', ${sql.json({ wakeReason: "timer" })})
      RETURNING id`;
    await sql`UPDATE heartbeat_runs SET context_issue_id = NULL, context_task_id = NULL WHERE id = ${legacy!.id}`;
    const [wiped] = await sql<{ context_issue_id: string | null }[]>`
      SELECT context_issue_id FROM heartbeat_runs WHERE id = ${legacy!.id}`;
    expect(wiped?.context_issue_id).toBeNull();

    for (const statement of await migrationStatements()) {
      await sql.unsafe(statement);
    }

    const after = await sql<{ id: string; context_issue_id: string | null; context_task_id: string | null }[]>`
      SELECT id, context_issue_id, context_task_id FROM heartbeat_runs WHERE id IN (${legacy!.id}, ${noKeys!.id})`;
    expect(after.find((row) => row.id === legacy!.id)).toMatchObject({
      context_issue_id: "issue-old",
      context_task_id: "task-old",
    });
    expect(after.find((row) => row.id === noKeys!.id)).toMatchObject({
      context_issue_id: null,
      context_task_id: null,
    });
  }, 240_000);

  it("serves the attention newer-run scan from the covering index without reading context_snapshot", async () => {
    const dbh = await startEmbeddedPostgresTestDatabase("hb-ctx-keys-idx-");
    cleanups.push(() => dbh.cleanup());
    const sql = postgres(dbh.connectionString, { max: 1, onnotice: () => {} });
    cleanups.push(async () => { await sql.end(); });

    const idx = await sql<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'heartbeat_runs_company_agent_created_ctx_keys_idx'`;
    expect(idx).toHaveLength(1);
    expect(idx[0]!.indexdef).toContain("(company_id, agent_id, created_at, context_issue_id, context_task_id)");

    // An empty table plans any company_id index, so seed a realistic spread
    // (3 companies x 5 agents x 200 runs) and ANALYZE before reading the plan.
    const companyRows = await sql<{ id: string }[]>`
      INSERT INTO companies (name, issue_prefix)
      SELECT 'Plan Co ' || n, 'PL' || n FROM generate_series(1, 3) AS n RETURNING id`;
    for (const company of companyRows) {
      await sql`
        INSERT INTO agents (company_id, name, role, status, adapter_type, adapter_config, runtime_config, permissions)
        SELECT ${company.id}, 'Agent ' || n, 'engineer', 'idle', 'codex_local', '{}', '{}', '{}'
        FROM generate_series(1, 5) AS n`;
    }
    await sql`
      INSERT INTO heartbeat_runs (company_id, agent_id, status, context_snapshot, created_at)
      SELECT a.company_id, a.id, 'succeeded',
        jsonb_build_object('issueId', 'issue-' || (n % 40), 'prompt', repeat('p', 200)),
        now() - (n || ' minutes')::interval
      FROM agents a CROSS JOIN generate_series(1, 200) AS n`;
    await sql.unsafe("VACUUM ANALYZE heartbeat_runs");
    const [target] = await sql<{ company_id: string; id: string }[]>`
      SELECT company_id, id FROM agents ORDER BY name, id LIMIT 1`;

    await sql.unsafe("SET enable_seqscan = off");
    await sql.unsafe("SET enable_bitmapscan = off");
    const plan = await sql.unsafe(
      "EXPLAIN (VERBOSE) SELECT agent_id, context_issue_id, context_task_id, max(created_at) FROM heartbeat_runs "
        + `WHERE company_id = '${target!.company_id}' `
        + `AND agent_id IN ('${target!.id}') `
        + "AND created_at > now() - interval '1 day' GROUP BY agent_id, context_issue_id, context_task_id",
    );
    const planText = plan.map((row) => Object.values(row)[0]).join("\n");
    expect(planText).toContain("Index Only Scan using heartbeat_runs_company_agent_created_ctx_keys_idx");
    expect(planText).not.toContain("context_snapshot");
  }, 240_000);
});
