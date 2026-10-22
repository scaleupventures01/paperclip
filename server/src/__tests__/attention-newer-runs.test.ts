import { randomUUID } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { listAttentionNewerRunKeys } from "../services/attention-exhausted-runs.js";
import { externalConversationStateSql } from "../services/slack-conversation-state.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// The attention feed used to project context_snapshot ->> 'issueId'/'taskId'
// for every run of every failed agent, which forced Postgres to detoast each
// whole snapshot (about 27 KB average in production). These tests pin the
// narrow-column read so the feed never touches context_snapshot again.
describe("attention heartbeat reads avoid context_snapshot", () => {
  it("renders the Slack idle-conversation probe without context_snapshot", () => {
    const rendered = new PgDialect().sqlToQuery(externalConversationStateSql()).sql;
    expect(rendered).not.toContain("context_snapshot");
    expect(rendered).toContain("r.context_issue_id");
    expect(rendered).toContain("r.context_task_id");
  });
});

describeEmbeddedPostgres("listAttentionNewerRunKeys", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-attention-newer-runs-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const otherCompanyId = randomUUID();
    const workerId = randomUUID();
    const reviewerId = randomUUID();
    const otherAgentId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Newer Co", issuePrefix: "NEW", requireBoardApprovalForNewAgents: false },
      { id: otherCompanyId, name: "Other Co", issuePrefix: "OTR", requireBoardApprovalForNewAgents: false },
    ]);
    const agent = (id: string, company: string, name: string) => ({
      id, companyId: company, name, role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(agents).values([
      agent(workerId, companyId, "Worker"),
      agent(reviewerId, companyId, "Reviewer"),
      agent(otherAgentId, otherCompanyId, "Other"),
    ]);
    return { companyId, otherCompanyId, workerId, reviewerId, otherAgentId };
  }

  it("does not reference context_snapshot in the SQL it sends", () => {
    const query = listAttentionNewerRunKeys(db, randomUUID(), [randomUUID()], new Date());
    const text = query.toSQL().sql;
    expect(text).not.toContain("context_snapshot");
    expect(text).toContain("context_issue_id");
    expect(text).toContain("context_task_id");
  });

  it("returns the latest run per agent and issue/task key after the cutoff, company scoped", async () => {
    const { companyId, otherCompanyId, workerId, reviewerId, otherAgentId } = await seed();
    const cutoff = new Date("2026-07-09T12:00:00.000Z");
    const at = (minutes: number) => new Date(cutoff.getTime() + minutes * 60_000);
    const big = "z".repeat(40_000);
    await db.insert(heartbeatRuns).values([
      // Before the cutoff: ignored.
      { companyId, agentId: workerId, status: "succeeded", contextSnapshot: { issueId: "i-1", prompt: big }, createdAt: at(-5) },
      // Two runs for the same key: only the newest createdAt survives.
      { companyId, agentId: workerId, status: "succeeded", contextSnapshot: { issueId: "i-1", prompt: big }, createdAt: at(1) },
      { companyId, agentId: workerId, status: "failed", contextSnapshot: { issueId: "i-1", prompt: big }, createdAt: at(3) },
      // taskId-only run keeps its own key.
      { companyId, agentId: workerId, status: "succeeded", contextSnapshot: { taskId: "t-9" }, createdAt: at(2) },
      // A run with no issue context keys as (null, null).
      { companyId, agentId: workerId, status: "succeeded", contextSnapshot: { wakeReason: "timer" }, createdAt: at(4) },
      // A different agent that is not in the filter: ignored.
      { companyId, agentId: reviewerId, status: "succeeded", contextSnapshot: { issueId: "i-1" }, createdAt: at(6) },
      // Another company: ignored even with a matching agent list entry.
      { companyId: otherCompanyId, agentId: otherAgentId, status: "succeeded", contextSnapshot: { issueId: "i-1" }, createdAt: at(7) },
    ].map((row) => ({ ...row, updatedAt: row.createdAt })));

    const rows = await listAttentionNewerRunKeys(db, companyId, [workerId, otherAgentId], cutoff);
    const normalized = rows
      .map((row) => ({
        agentId: row.agentId,
        runIssueId: row.runIssueId,
        runTaskId: row.runTaskId,
        createdAt: new Date(row.createdAt).toISOString(),
      }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    expect(normalized).toEqual([
      { agentId: workerId, runIssueId: null, runTaskId: "t-9", createdAt: at(2).toISOString() },
      { agentId: workerId, runIssueId: "i-1", runTaskId: null, createdAt: at(3).toISOString() },
      { agentId: workerId, runIssueId: null, runTaskId: null, createdAt: at(4).toISOString() },
    ]);
  });
});
