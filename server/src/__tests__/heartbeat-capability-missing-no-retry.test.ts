import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService } from "../services/heartbeat.ts";

// A deterministic capability failure (the AgentOS managed launcher contract:
// exit 78 = EX_CONFIG, stderr "capability_missing: ...") must never be
// retried as a transient failure. Live incident 2026-10-13: Lead Generator
// Pod Manager on SCAA-4008 failed 10 times with exit 78 "capability_missing:
// Akili glm lane unhealthy", each followed by a transient_failure_retry wake,
// until the provider usage breaker blocked the card at 6 of 6.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres capability_missing retry tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const CAPABILITY_MISSING_ADAPTER = "capability_missing_test";
const TRANSIENT_ADAPTER = "transient_upstream_test";
const CAPABILITY_STDERR =
  "capability_missing: Akili glm lane unhealthy (receipt stale; run agentos-akili-canary)";

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat does not transient-retry capability_missing failures", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-capability-missing-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: CAPABILITY_MISSING_ADAPTER,
      // Worst case: the adapter mislabels the launcher refusal as a transient
      // upstream failure. The exit code and marker must still win.
      execute: async () => ({
        exitCode: 78,
        signal: null,
        timedOut: false,
        errorMessage: CAPABILITY_STDERR,
        errorCode: null,
        errorFamily: "transient_upstream",
        resultJson: {
          stdout: "",
          stderr: `${CAPABILITY_STDERR}\n`,
          errorFamily: "transient_upstream",
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        },
      }),
      testEnvironment: async () => ({
        adapterType: CAPABILITY_MISSING_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
    registerServerAdapter({
      type: TRANSIENT_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "We're currently experiencing high demand, which may cause temporary errors.",
        errorCode: "codex_transient_upstream",
        errorFamily: "transient_upstream",
        resultJson: {
          stdout: "",
          stderr: "We're currently experiencing high demand, which may cause temporary errors.\n",
          errorFamily: "transient_upstream",
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        },
      }),
      testEnvironment: async () => ({
        adapterType: TRANSIENT_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.delete(activityLog);
        await db.delete(issues);
        await db.delete(heartbeatRunEvents);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(companySkills);
        await db.delete(companies);
        return;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    unregisterServerAdapter(CAPABILITY_MISSING_ADAPTER);
    unregisterServerAdapter(TRANSIENT_ADAPTER);
    await tempDb?.cleanup();
  });

  async function seedAgent(adapterType: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
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
      name: "Lead Generator Pod Manager",
      role: "engineer",
      status: "idle",
      adapterType,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedFailedRun(input: {
    errorCode: string;
    exitCode: number | null;
    error: string;
    stderr: string;
  }) {
    const { companyId, agentId } = await seedAgent("codex_local");
    await db.update(agents).set({ status: "active" }).where(eq(agents.id, agentId));
    const runId = randomUUID();
    const now = new Date("2026-10-13T14:22:00.000Z");
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: input.error,
      errorCode: input.errorCode,
      exitCode: input.exitCode,
      finishedAt: now,
      resultJson: {
        stdout: "",
        stderr: input.stderr,
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      },
      contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_assigned" },
      updatedAt: now,
      createdAt: now,
    });
    return { runId, agentId, now };
  }

  async function retryChildren(runId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
  }

  async function transientRetryWakes(agentId: string) {
    const rows = await db
      .select({ reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    return { total: rows.length, transient: rows.filter((row) => row.reason === "transient_failure_retry").length };
  }

  it("records an exit-78 capability_missing run as non-retryable and queues no transient retry", async () => {
    const { agentId } = await seedAgent(CAPABILITY_MISSING_ADAPTER);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.exitCode).toBe(78);
    expect(failedRun?.errorCode).toBe("capability_missing");

    // Give any fire-and-forget retry scheduling a chance to land before asserting absence.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await retryChildren(run!.id)).toHaveLength(0);
    expect((await transientRetryWakes(agentId)).transient).toBe(0);

    const events = await db
      .select({ payload: heartbeatRunEvents.payload, message: heartbeatRunEvents.message })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, run!.id));
    expect(
      events.some(
        (event) =>
          (event.payload as Record<string, unknown> | null)?.retryable === false &&
          (event.payload as Record<string, unknown> | null)?.errorCode === "capability_missing",
      ),
    ).toBe(true);
  });

  it("control: a transient upstream failure still schedules exactly one bounded retry", async () => {
    const { agentId } = await seedAgent(TRANSIENT_ADAPTER);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("codex_transient_upstream");

    await expect
      .poll(() => retryChildren(run!.id).then((rows) => rows.length), { timeout: 5_000, interval: 50 })
      .toBe(1);
    const [child] = await retryChildren(run!.id);
    expect(child).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "transient_failure", scheduledRetryAttempt: 1 });
    expect((await transientRetryWakes(agentId)).transient).toBe(1);
  });

  // The recovery service (stranded-issue recovery with a failed predecessor)
  // and process-loss recovery call scheduleBoundedRetryForRun with the default
  // transient reason regardless of how the predecessor failed.
  // Each case isolates one signal so every clause of the classifier is load-bearing.
  it.each([
    ["exit 78 recorded as adapter_failed", { errorCode: "adapter_failed", exitCode: 78, error: "AgentOS GLM environment is unreadable" }],
    ["capability_missing marker with no exit code", { errorCode: "adapter_failed", exitCode: null, error: CAPABILITY_STDERR }],
    ["errorCode capability_missing", { errorCode: "capability_missing", exitCode: 1, error: "Adapter failed" }],
  ] as const)("refuses a default transient retry for a %s run", async (_label, shape) => {
    const { runId, agentId, now } = await seedFailedRun({
      ...shape,
      stderr: `${shape.error}\n`,
    });
    const scheduled = await heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0 });
    expect(scheduled).toMatchObject({ outcome: "not_scheduled", errorCode: "non_retryable_capability_missing" });
    expect(await retryChildren(runId)).toHaveLength(0);
    expect((await transientRetryWakes(agentId)).transient).toBe(0);
  });

  it("control: a launcher EX_TEMPFAIL (exit 75, no GLM slot) failure is still retried", async () => {
    const { runId, agentId, now } = await seedFailedRun({
      errorCode: "adapter_failed",
      exitCode: 75,
      error: "codex-glm: no GLM slot free after 600s",
      stderr: "codex-glm: no GLM slot free after 600s\n",
    });
    const scheduled = await heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0 });
    expect(scheduled).toMatchObject({ outcome: "scheduled", attempt: 1 });
    expect(await retryChildren(runId)).toHaveLength(1);
    expect((await transientRetryWakes(agentId)).transient).toBe(1);
  });
});
