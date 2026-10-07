import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { activityRoutes } from "../routes/activity.ts";
import { agentRoutes } from "../routes/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue run binding tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("issue run binding routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-run-binding-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixtures() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();
    const activeRunId = randomUUID();
    const completedRunId = randomUUID();
    const unboundRunId = randomUUID();
    const cancelledRunId = randomUUID();
    const failedRunId = randomUUID();
    const startedAt = new Date("2026-10-07T04:37:50.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Run Binding",
      issuePrefix: `RB${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Heartbeat Worker",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        title: "Bound issue",
        status: "in_progress",
        priority: "high",
        assigneeAgentId: agentId,
      },
      {
        id: otherIssueId,
        companyId,
        title: "Other issue",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: activeRunId,
        companyId,
        agentId,
        nativeIssueId: issueId,
        invocationSource: "heartbeat",
        status: "running",
        startedAt,
        contextSnapshot: { issueId: otherIssueId },
        livenessState: "live",
        livenessReason: "Heartbeat process is running",
      },
      {
        id: completedRunId,
        companyId,
        agentId,
        nativeIssueId: issueId,
        invocationSource: "heartbeat",
        status: "succeeded",
        startedAt,
        finishedAt: startedAt,
        contextSnapshot: { issueId },
      },
      {
        id: unboundRunId,
        companyId,
        agentId,
        nativeIssueId: null,
        invocationSource: "heartbeat",
        status: "running",
        startedAt,
        contextSnapshot: {},
      },
      {
        id: cancelledRunId,
        companyId,
        agentId,
        nativeIssueId: issueId,
        invocationSource: "heartbeat",
        status: "cancelled",
        startedAt,
        finishedAt: startedAt,
        contextSnapshot: { issueId },
      },
      {
        id: failedRunId,
        companyId,
        agentId,
        nativeIssueId: issueId,
        invocationSource: "heartbeat",
        status: "failed",
        startedAt,
        finishedAt: startedAt,
        contextSnapshot: { issueId },
      },
    ]);
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "test.stale_issue_link",
      entityType: "issue",
      entityId: issueId,
      runId: unboundRunId,
    });

    return {
      companyId,
      issueId,
      otherIssueId,
      activeRunId,
      completedRunId,
      unboundRunId,
      cancelledRunId,
      failedRunId,
      startedAt,
    };
  }

  function app() {
    const actor = {
      type: "board",
      source: "local_implicit",
      userId: "local-board",
      companyIds: [] as string[],
      isInstanceAdmin: false,
    };
    const routerApp = express();
    routerApp.use(express.json());
    routerApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    routerApp.use("/api", activityRoutes(db));
    routerApp.use("/api", agentRoutes(db));
    return routerApp;
  }

  it("exposes canonical active heartbeat runs consistently and preserves completion", async () => {
    const fixtures = await seedFixtures();
    const issueApp = app();

    const [runsBefore, liveBefore] = await Promise.all([
      request(issueApp).get(`/api/issues/${fixtures.issueId}/runs`).expect(200),
      request(issueApp).get(`/api/issues/${fixtures.issueId}/live-runs`).expect(200),
    ]);

    expect(runsBefore.body.map((run: { runId: string }) => run.runId)).toContain(fixtures.activeRunId);
    expect(liveBefore.body).toHaveLength(1);
    expect(liveBefore.body[0]).toMatchObject({
      id: fixtures.activeRunId,
      issueId: fixtures.issueId,
      status: "running",
      startedAt: fixtures.startedAt.toISOString(),
      livenessState: "live",
      livenessReason: "Heartbeat process is running",
    });
    expect(liveBefore.body.map((run: { id: string }) => run.id)).not.toContain(fixtures.completedRunId);

    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date("2026-10-07T04:39:00.000Z") })
      .where(eq(heartbeatRuns.id, fixtures.activeRunId));

    const [runsAfter, liveAfter] = await Promise.all([
      request(issueApp).get(`/api/issues/${fixtures.issueId}/runs`).expect(200),
      request(issueApp).get(`/api/issues/${fixtures.issueId}/live-runs`).expect(200),
    ]);

    expect(runsAfter.body.map((run: { runId: string }) => run.runId)).toContain(fixtures.activeRunId);
    expect(liveAfter.body).toHaveLength(0);
  });

  it("excludes unbound and terminal no-live heartbeat runs", async () => {
    const fixtures = await seedFixtures();

    const issueApp = app();
    const [runs, live, staleIssueRuns, staleIssueLive] = await Promise.all([
      request(issueApp).get(`/api/issues/${fixtures.issueId}/runs`).expect(200),
      request(issueApp).get(`/api/issues/${fixtures.issueId}/live-runs`).expect(200),
      request(issueApp).get(`/api/issues/${fixtures.otherIssueId}/runs`).expect(200),
      request(issueApp).get(`/api/issues/${fixtures.otherIssueId}/live-runs`).expect(200),
    ]);

    const runIds = runs.body.map((run: { runId: string }) => run.runId);
    const liveIds = live.body.map((run: { id: string }) => run.id);
    expect(runIds).not.toContain(fixtures.unboundRunId);
    expect(liveIds).toEqual([fixtures.activeRunId]);
    expect(liveIds).not.toContain(fixtures.cancelledRunId);
    expect(liveIds).not.toContain(fixtures.failedRunId);
    expect(liveIds).not.toContain(fixtures.unboundRunId);
    expect(staleIssueRuns.body).toHaveLength(0);
    expect(staleIssueLive.body).toHaveLength(0);
  });
});
