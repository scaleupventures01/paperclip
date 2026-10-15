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
import { classifyContinuationFailure } from "../services/recovery/service.ts";

// A run that ends because our own API refused the agent's request (4xx) is a
// deterministic refusal: running the agent again sends the same request and
// gets the same answer. Live incident 2026-10-15: Chief of Staff on SCAA-1001
// hit HTTP 409 "Delegation cycle" six times in five minutes (c72e8311,
// b01b0365, 5e591dfc, c3523e0d, 259f2ce5 and more), each failure followed by a
// transient_failure_retry (agentos#620).

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres api_refusal retry tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const REFUSAL_ADAPTER = "api_refusal_test";
// Verbatim shape of the live SCAA-1001 failure (company id replaced).
const REFUSAL_409 =
  "agentos_jev_memory: skipped 26 unreadable line(s) in agent memory\n" +
  "agentos-jev-seat: POST /api/companies/00000000-0000-0000-0000-000000000000/issues failed: agentos-http http_error status=409\n" +
  '{"error":"Delegation cycle: SCAA-1001 was created by the agent this child would be assigned to"}';
const REFUSAL_403 =
  "agentos-jev-seat: PATCH /api/issues/00000000-0000-0000-0000-000000000000 failed: agentos-http http_error status=403\n" +
  '{"error":"Agent cannot reassign an issue it does not own"}';

describe("classifyContinuationFailure: api_refusal", () => {
  it("api_refusal is non-retryable, so the stranded sweep blocks the card once", () => {
    const run = { errorCode: "api_refusal" } as unknown as Parameters<typeof classifyContinuationFailure>[0];
    expect(classifyContinuationFailure(run)).toMatchObject({ kind: "non_retryable", maxAttempts: 0 });
  });
});

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

describeEmbeddedPostgres("heartbeat does not transient-retry a deterministic API refusal", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-api-refusal-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: REFUSAL_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: REFUSAL_409,
        errorCode: null,
        resultJson: {
          stdout: "",
          stderr: `${REFUSAL_409}\n`,
          executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        },
      }),
      testEnvironment: async () => ({
        adapterType: REFUSAL_ADAPTER,
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
    unregisterServerAdapter(REFUSAL_ADAPTER);
    await tempDb?.cleanup();
  });

  async function seedAgent(adapterType: string) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Chief of Staff",
      role: "engineer",
      status: "idle",
      adapterType,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedFailedRun(input: { errorCode: string; error: string }) {
    const { companyId, agentId } = await seedAgent("codex_local");
    await db.update(agents).set({ status: "active" }).where(eq(agents.id, agentId));
    const runId = randomUUID();
    const now = new Date("2026-10-15T02:41:30.452Z");
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "failed",
      error: input.error,
      errorCode: input.errorCode,
      exitCode: 1,
      finishedAt: now,
      resultJson: {
        stdout: "",
        stderr: `${input.error}\n`,
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      },
      contextSnapshot: { issueId: randomUUID(), wakeReason: "issue_commented" },
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
    return rows.filter((row) => row.reason === "transient_failure_retry").length;
  }

  it("records a 409 refusal from our own API as api_refusal and queues no transient retry", async () => {
    const { agentId } = await seedAgent(REFUSAL_ADAPTER);
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("api_refusal");

    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(await retryChildren(run!.id)).toHaveLength(0);
    expect(await transientRetryWakes(agentId)).toBe(0);
  });

  // The stranded-issue sweep and process-loss recovery call
  // scheduleBoundedRetryForRun with the default transient reason on rows that
  // were stored before this fix as adapter_failed.
  it.each([
    ["409 delegation cycle stored as adapter_failed", { errorCode: "adapter_failed", error: REFUSAL_409 }],
    ["403 policy refusal stored as adapter_failed", { errorCode: "adapter_failed", error: REFUSAL_403 }],
    ["errorCode api_refusal", { errorCode: "api_refusal", error: "Adapter failed" }],
  ] as const)("refuses a default transient retry for a %s run", async (_label, shape) => {
    const { runId, agentId, now } = await seedFailedRun(shape);
    const scheduled = await heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0 });
    expect(scheduled).toMatchObject({ outcome: "not_scheduled", errorCode: "non_retryable_api_refusal" });
    expect(await retryChildren(runId)).toHaveLength(0);
    expect(await transientRetryWakes(agentId)).toBe(0);
  });

  it.each([
    ["network failure", "agentos-jev-seat: POST /api/companies/x/issues failed: agentos-http network_error ECONNRESET"],
    ["HTTP 503 from our API", "agentos-jev-seat: POST /api/companies/x/issues failed: agentos-http http_error status=503"],
    ["HTTP 429 rate limit", "agentos-jev-seat: POST /api/companies/x/issues failed: agentos-http http_error status=429"],
    ["HTTP 401 expired token", "agentos-jev-seat: GET /api/issues/x failed: agentos-http http_error status=401"],
  ] as const)("control: a %s is still retried", async (_label, error) => {
    const { runId, agentId, now } = await seedFailedRun({ errorCode: "adapter_failed", error });
    const scheduled = await heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0 });
    expect(scheduled).toMatchObject({ outcome: "scheduled", attempt: 1 });
    expect(await retryChildren(runId)).toHaveLength(1);
    expect(await transientRetryWakes(agentId)).toBe(1);
  });
});
