import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  heartbeatRunEvents,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  executeIssuePostCommitActions,
  issueService,
} from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping terminal queued-run reconciliation tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("terminal issue queued-run reconciliation", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "issue-terminal-queued-run-",
    );
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedTerminalRunFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Terminal Reconciliation",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Reconciler",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Terminal duplicate",
      status: "done",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId },
      status: "queued",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId })
      .where(eq(agentWakeupRequests.id, wakeupRequestId));

    return { companyId, issueId, runId, wakeupRequestId };
  }

  it("cancels a queued duplicate immediately when the issue service closes the issue", async () => {
    const seeded = await seedTerminalRunFixture();
    await db
      .update(issues)
      .set({ status: "in_progress" })
      .where(eq(issues.id, seeded.issueId));

    await issueService(db).update(seeded.issueId, { status: "done" });

    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, seeded.runId));
    const [wake] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeupRequestId));
    expect(run).toMatchObject({
      status: "cancelled",
      errorCode: "issue_terminal_status",
    });
    expect(wake).toMatchObject({
      status: "cancelled",
      runId: seeded.runId,
    });
  }, 20_000);

  it("cancels the queued loser without emitting a failed wake", async () => {
    const seeded = await seedTerminalRunFixture();

    await executeIssuePostCommitActions(db, [
      {
        type: "cancel_issue_terminal_queued_run",
        runId: seeded.runId,
        issueId: seeded.issueId,
        issueStatus: "done",
      },
    ]);

    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, seeded.runId));
    const [wake] = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, seeded.wakeupRequestId));
    expect(run).toMatchObject({ status: "cancelled", errorCode: "issue_terminal_status" });
    expect(wake).toMatchObject({ status: "cancelled" });
  }, 20_000);
});
