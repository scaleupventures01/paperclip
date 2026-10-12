import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Issue rewake throttle test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

// agentos#515 regression cases for the issue rewake throttle. Same harness as
// heartbeat-issue-rewake-throttle.test.ts, plus PAPERCLIP_TEST_DATABASE_URL
// support (as heartbeat-process-recovery.test.ts has) and the shared embedded
// Postgres time budget, so the cases still run on a loaded host where a fresh
// cluster plus migrations takes longer than 20s.
const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL?.trim();
const embeddedPostgresSupport = externalTestDatabaseUrl
  ? { supported: true as const, reason: undefined }
  : await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue rewake throttle tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat issue rewake throttle (515)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      db = createDb(externalTestDatabaseUrl);
    } else {
      tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-issue-rewake-throttle-515-");
      db = createDb(tempDb.connectionString);
    }
    heartbeat = heartbeatService(db);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    runningProcesses.clear();
    // Await every in-flight background heartbeat run to quiescence before the
    // deletes below. A wakeup claims a run and dispatches its execution
    // fire-and-forget, and that run can dispatch a follow-up wakeup, so a run or
    // wakeup can still write heartbeat_runs and issues rows when teardown starts
    // and would race the deletes (a heartbeat_runs delete deadlocks on the ON
    // DELETE SET NULL cascade to issues). The shared drain also awaits an
    // in-flight wakeup that is still before run registration, which a plain run
    // table status poll cannot see.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    // Post-run bookkeeping (run-event records, follow-up wake scheduling) can
    // still write for a moment after a run reaches a terminal status, so a
    // single delete sweep can hit a foreign-key violation when a late insert
    // lands between two deletes. Retry the sweep until it goes through clean.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(environmentLeases);
        await db.delete(issueComments);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(activityLog);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(environments);
        await db.delete(executionWorkspaces);
        await db.delete(companySkills);
        await db.delete(companies);
        break;
      } catch (error) {
        if (attempt >= 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAgentIssue() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Interrupted import mission",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });

    return { companyId, agentId, issueId };
  }

  async function seedTerminalRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status?: string;
    finishedSecondsAgo: number;
    startedSecondsAgo?: number;
    sessionIdAfter?: string;
  }) {
    const runId = randomUUID();
    const finishedAt = new Date(Date.now() - input.finishedSecondsAgo * 1000);
    const startedAt = input.startedSecondsAgo === undefined
      ? new Date(finishedAt.getTime() - 5_000)
      : new Date(Date.now() - input.startedSecondsAgo * 1000);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: input.status ?? "succeeded",
      responsibleUserId: "responsible-user",
      createdAt: startedAt,
      startedAt,
      finishedAt,
      sessionIdAfter: input.sessionIdAfter,
      contextSnapshot: { issueId: input.issueId, wakeReason: "issue_assigned" },
    });
    return runId;
  }

  async function latestWakeRequest(agentId: string) {
    return db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        payload: agentWakeupRequests.payload,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(desc(agentWakeupRequests.requestedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  // agentos#515: an agent that posts the same comment every run must not
  // defeat the no-progress throttle. A comment counts as progress only when its
  // first line (trimmed, whitespace collapsed) differs from the first line of
  // the same agent's previous comment on the issue.
  describe("515 repeated identical comment is not progress", () => {
    const REPEATED_FIRST_LINE =
      "waiting on SCAA-3598: its status is blocked after re-reading it before acting";
    const KILL_SWITCH_ENV = "STRANDED_REPEATED_COMMENT_IS_PROGRESS";

    async function seedPriorAgentComment(input: {
      companyId: string;
      agentId: string;
      issueId: string;
      body: string;
      secondsAgo: number;
    }) {
      const createdAt = new Date(Date.now() - input.secondsAgo * 1000);
      await db.insert(issueComments).values({
        companyId: input.companyId,
        issueId: input.issueId,
        authorAgentId: input.agentId,
        body: input.body,
        createdAt,
        updatedAt: createdAt,
      });
    }

    async function seedCommentingRun(input: {
      companyId: string;
      agentId: string;
      issueId: string;
      finishedSecondsAgo: number;
      body: string;
    }) {
      const runId = await seedTerminalRun({
        companyId: input.companyId,
        agentId: input.agentId,
        issueId: input.issueId,
        finishedSecondsAgo: input.finishedSecondsAgo,
      });
      // The comment and its activity row land inside the run, before it
      // finished, so they are not "new input since the last run".
      const createdAt = new Date(Date.now() - (input.finishedSecondsAgo + 1) * 1000);
      await db.insert(issueComments).values({
        companyId: input.companyId,
        issueId: input.issueId,
        authorAgentId: input.agentId,
        createdByRunId: runId,
        body: input.body,
        createdAt,
        updatedAt: createdAt,
      });
      await db.insert(activityLog).values({
        companyId: input.companyId,
        actorType: "agent",
        actorId: input.agentId,
        agentId: input.agentId,
        runId,
        action: "issue.comment_added",
        entityType: "issue",
        entityId: input.issueId,
        createdAt,
      });
      return runId;
    }

    // Three runs whose comments share one first line; later lines vary so the
    // test proves the comparison is on the FIRST line, not the whole body.
    // A prior identical comment (before the sampled runs) means every sampled
    // run's comment repeats its predecessor.
    async function seedRepeatedCommentRuns(companyId: string, agentId: string, issueId: string) {
      await seedPriorAgentComment({
        companyId,
        agentId,
        issueId,
        body: `${REPEATED_FIRST_LINE}\n\nchecked at run 0`,
        secondsAgo: 120,
      });
      const runIds: string[] = [];
      runIds.push(await seedCommentingRun({
        companyId,
        agentId,
        issueId,
        finishedSecondsAgo: 70,
        body: `${REPEATED_FIRST_LINE}\n\nchecked at run 1, blocker still open`,
      }));
      runIds.push(await seedCommentingRun({
        companyId,
        agentId,
        issueId,
        finishedSecondsAgo: 40,
        // Whitespace differences in the first line must normalise away.
        body: `  ${REPEATED_FIRST_LINE.replace(": its", ":   its")}  \nchecked at run 2\n- nothing new`,
      }));
      runIds.push(await seedCommentingRun({
        companyId,
        agentId,
        issueId,
        finishedSecondsAgo: 10,
        body: `${REPEATED_FIRST_LINE}\nchecked at run 3 (different detail line)`,
      }));
      return runIds;
    }

    function continuationWake(agentId: string, issueId: string) {
      return heartbeat.wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "issue_continuation_needed",
        payload: { issueId },
        contextSnapshot: { issueId, wakeReason: "issue_continuation_needed" },
        requestedByActorType: "system",
        requestedByActorId: "test",
      });
    }

    async function withKillSwitch<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
      const previous = process.env[KILL_SWITCH_ENV];
      if (value === undefined) delete process.env[KILL_SWITCH_ENV];
      else process.env[KILL_SWITCH_ENV] = value;
      try {
        return await fn();
      } finally {
        if (previous === undefined) delete process.env[KILL_SWITCH_ENV];
        else process.env[KILL_SWITCH_ENV] = previous;
      }
    }

    it("515-A throttles issue_continuation_needed when every recent run only repeated the same comment first line", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      await seedRepeatedCommentRuns(companyId, agentId, issueId);

      const wake = await withKillSwitch(undefined, () => continuationWake(agentId, issueId));

      const latest = await latestWakeRequest(agentId);
      expect(latest?.reason).toBe("issue_rewake_throttled");
      expect(latest?.status).toBe("skipped");
      expect(wake).toBeNull();
    });

    it("515-A-control does not throttle when each run's comment has a different first line", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      await seedPriorAgentComment({
        companyId,
        agentId,
        issueId,
        body: "started import, reading the spec",
        secondsAgo: 120,
      });
      await seedCommentingRun({
        companyId,
        agentId,
        issueId,
        finishedSecondsAgo: 70,
        body: "frame 01/08 generated\nshared settings",
      });
      await seedCommentingRun({
        companyId,
        agentId,
        issueId,
        finishedSecondsAgo: 40,
        body: "frame 02/08 generated\nshared settings",
      });
      await seedCommentingRun({
        companyId,
        agentId,
        issueId,
        finishedSecondsAgo: 10,
        body: "frame 03/08 generated\nshared settings",
      });

      const wake = await withKillSwitch(undefined, () => continuationWake(agentId, issueId));

      expect(wake).not.toBeNull();
      expect((await latestWakeRequest(agentId))?.reason).not.toBe("issue_rewake_throttled");
    });

    it("515-C still counts a real status change in a repeated-comment run as progress", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      const runIds = await seedRepeatedCommentRuns(companyId, agentId, issueId);
      const newestRunId = runIds[runIds.length - 1]!;
      await db.insert(activityLog).values({
        companyId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        runId: newestRunId,
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: { status: "in_progress", _previous: { status: "todo" } },
        createdAt: new Date(Date.now() - 12_000),
      });

      const wake = await withKillSwitch(undefined, () => continuationWake(agentId, issueId));

      expect(wake).not.toBeNull();
      expect((await latestWakeRequest(agentId))?.reason).not.toBe("issue_rewake_throttled");
    });

    it("515-C still counts a child issue created in a repeated-comment run as progress", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      const runIds = await seedRepeatedCommentRuns(companyId, agentId, issueId);
      const newestRunId = runIds[runIds.length - 1]!;
      await db.insert(activityLog).values({
        companyId,
        actorType: "agent",
        actorId: agentId,
        agentId,
        runId: newestRunId,
        action: "issue.child_created",
        entityType: "issue",
        entityId: issueId,
        details: { childIssueId: randomUUID() },
        createdAt: new Date(Date.now() - 12_000),
      });

      const wake = await withKillSwitch(undefined, () => continuationWake(agentId, issueId));

      expect(wake).not.toBeNull();
      expect((await latestWakeRequest(agentId))?.reason).not.toBe("issue_rewake_throttled");
    });

    it("515-D kill switch STRANDED_REPEATED_COMMENT_IS_PROGRESS=1 restores comment-as-progress in the throttle", async () => {
      const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
      await seedRepeatedCommentRuns(companyId, agentId, issueId);

      const wake = await withKillSwitch("1", () => continuationWake(agentId, issueId));

      expect(wake).not.toBeNull();
      expect((await latestWakeRequest(agentId))?.reason).not.toBe("issue_rewake_throttled");
    });

    // agentos#515 round 2. Live ordering (measured on production, 640 of 1338
    // runs in 24h): a run's own issue.comment_added activity row is written
    // 0.1 to 3 s AFTER heartbeat_runs.finished_at. Activity written by the
    // sampled runs themselves is not "new input since the last run"; genuine
    // input (a user, or activity with no run id or another run's id) still is.
    // Comments whose trimmed body starts with "{" or "[" are compared on the
    // whole body, whitespace-normalised, not on their first line.
    describe("515-r2", () => {
      const ACTIVITY_AFTER_FINISH_MS = [600, 1_800, 2_900];

      async function seedRun(input: {
        companyId: string;
        agentId: string;
        issueId: string;
        finishedSecondsAgo: number;
        body: string | null;
        activityAfterFinishMs: number | null;
      }) {
        const runId = await seedTerminalRun({
          companyId: input.companyId,
          agentId: input.agentId,
          issueId: input.issueId,
          finishedSecondsAgo: input.finishedSecondsAgo,
        });
        const finishedAtMs = Date.now() - input.finishedSecondsAgo * 1000;
        const commentAt = new Date(finishedAtMs - 1_000);
        if (input.body !== null) {
          await db.insert(issueComments).values({
            companyId: input.companyId,
            issueId: input.issueId,
            authorAgentId: input.agentId,
            createdByRunId: runId,
            body: input.body,
            createdAt: commentAt,
            updatedAt: commentAt,
          });
        }
        const activityAt = input.activityAfterFinishMs === null
          ? commentAt
          : new Date(finishedAtMs + input.activityAfterFinishMs);
        await db.insert(activityLog).values({
          companyId: input.companyId,
          actorType: "agent",
          actorId: input.agentId,
          agentId: input.agentId,
          runId,
          action: "issue.comment_added",
          entityType: "issue",
          entityId: input.issueId,
          createdAt: activityAt,
        });
        return runId;
      }

      async function seedRunsWithActivityAfterFinish(companyId: string, agentId: string, issueId: string) {
        await seedPriorAgentComment({
          companyId,
          agentId,
          issueId,
          body: `${REPEATED_FIRST_LINE}\n\nchecked at run 0`,
          secondsAgo: 120,
        });
        const finishes = [70, 40, 10];
        for (let index = 0; index < finishes.length; index += 1) {
          await seedRun({
            companyId,
            agentId,
            issueId,
            finishedSecondsAgo: finishes[index]!,
            body: `${REPEATED_FIRST_LINE}\n\nchecked at run ${index + 1}`,
            activityAfterFinishMs: ACTIVITY_AFTER_FINISH_MS[index]!,
          });
        }
      }

      function jsonBody(decision: string) {
        return `{\n  "schema": "agentos.delivery-manager-decision/v1",\n  "decision": "${decision}"\n}`;
      }

      it("515-r2 throttle-activity-after-finish throttles when each run's own comment activity lands after its finishedAt", async () => {
        const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
        await seedRunsWithActivityAfterFinish(companyId, agentId, issueId);

        const wake = await withKillSwitch(undefined, () => continuationWake(agentId, issueId));

        const latest = await latestWakeRequest(agentId);
        expect(latest?.reason).toBe("issue_rewake_throttled");
        expect(latest?.status).toBe("skipped");
        expect(wake).toBeNull();
      });

      it("515-r2 throttle-genuine-new-input (control) does not throttle when a user commented after the newest run finished", async () => {
        const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
        await seedRunsWithActivityAfterFinish(companyId, agentId, issueId);
        await db.insert(activityLog).values({
          companyId,
          actorType: "user",
          actorId: "responsible-user",
          agentId: null,
          runId: null,
          action: "issue.comment_added",
          entityType: "issue",
          entityId: issueId,
          createdAt: new Date(Date.now() - 3_000),
        });

        const wake = await withKillSwitch(undefined, () => continuationWake(agentId, issueId));

        expect(wake).not.toBeNull();
        expect((await latestWakeRequest(agentId))?.reason).not.toBe("issue_rewake_throttled");
      });

      it("515-r2 throttle-missing-comment-row (control) does not throttle comment-only runs whose comment rows are absent", async () => {
        const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
        for (const finishedSecondsAgo of [70, 40, 10]) {
          await seedRun({
            companyId,
            agentId,
            issueId,
            finishedSecondsAgo,
            body: null,
            activityAfterFinishMs: null,
          });
        }

        const wake = await withKillSwitch(undefined, () => continuationWake(agentId, issueId));

        expect(wake).not.toBeNull();
        expect((await latestWakeRequest(agentId))?.reason).not.toBe("issue_rewake_throttled");
      });

      it("515-r2 throttle-json does not throttle comment-only runs whose JSON comment bodies differ", async () => {
        const { companyId, agentId, issueId } = await seedCompanyAgentIssue();
        await seedPriorAgentComment({
          companyId,
          agentId,
          issueId,
          body: jsonBody("hold: waiting on build receipt"),
          secondsAgo: 120,
        });
        await seedCommentingRun({ companyId, agentId, issueId, finishedSecondsAgo: 70, body: jsonBody("route to QA") });
        await seedCommentingRun({ companyId, agentId, issueId, finishedSecondsAgo: 40, body: jsonBody("request rebuild") });
        await seedCommentingRun({ companyId, agentId, issueId, finishedSecondsAgo: 10, body: jsonBody("approve merge") });

        const wake = await withKillSwitch(undefined, () => continuationWake(agentId, issueId));

        expect(wake).not.toBeNull();
        expect((await latestWakeRequest(agentId))?.reason).not.toBe("issue_rewake_throttled");
      });
    });
  });
});
