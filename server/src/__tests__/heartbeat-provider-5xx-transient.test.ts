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
import {
  classifyAdapterFailureForRecovery,
  classifyContinuationFailure,
} from "../services/recovery/service.ts";

// Live incident 2026-10-16 08:03 to 08:51 ET on scaleup-svr: the GLM provider
// intermittently answered "unexpected status 502 Bad Gateway" (nginx html).
// 17 codex_local runs failed with it (cec9150d, 6492ef66, 49b8d12c, 06771a76,
// 27bface3, 9ee0d4e8, 487a85f4 and their retries). Paperclip stored them as
// adapter_failed, configuration_incomplete or provider_quota and put five
// agents into status `error` until a human cleared them at 08:55 ET.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres provider 5xx tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const NGINX_BODY =
  '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body bgcolor="white">\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>alibaba-ga</center>\r\n</body>\r\n</html>';
// Verbatim live codex error (run 487a85f4, heartbeat_runs.error).
const LIVE_502 = `unexpected status 502 Bad Gateway: ${NGINX_BODY}, url: https://api.z.ai/api/v1/responses`;
// Benign codex warning present in every GLM run's output, failed or not.
const GLM_METADATA_WARNING =
  "Model metadata for `glm-5.3-flash` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.";
// Agent transcript text that happens to mention a quota (run 27bface3).
const TRANSCRIPT_QUOTA_NOISE = "Checked the usage limit dashboard; no provider quota exceeded.";
const REFUSAL_409 =
  "agentos-jev-seat: POST /api/companies/00000000-0000-0000-0000-000000000000/issues failed: agentos-http http_error status=409\n" +
  '{"error":"Delegation cycle"}';

type AdapterResultShape = {
  errorMessage: string;
  errorCode?: string | null;
  errorFamily?: string | null;
  stdoutExtra?: string;
};

const ADAPTER = "provider_5xx_test";
let nextResult: AdapterResultShape = { errorMessage: LIVE_502 };

describe("recovery classification ignores the codex model-metadata warning", () => {
  const base = {
    error: LIVE_502,
    resultJson: { stdout: `${GLM_METADATA_WARNING}\n`, stderr: "" },
  };

  it("an adapter_failed run whose only config-looking text is the GLM metadata warning is not configuration_incomplete", () => {
    expect(classifyAdapterFailureForRecovery({ ...base, errorCode: "adapter_failed" } as never)).toBeNull();
  });

  it("a provider_http_5xx run is never reclassified by adapter-failure recovery", () => {
    expect(classifyAdapterFailureForRecovery({ ...base, errorCode: "provider_http_5xx" } as never)).toBeNull();
  });

  it("provider_http_5xx is a transient continuation failure, not a non-retryable one", () => {
    const run = { errorCode: "provider_http_5xx" } as unknown as Parameters<typeof classifyContinuationFailure>[0];
    expect(classifyContinuationFailure(run)).not.toMatchObject({ kind: "non_retryable" });
  });

  it.each([
    ["missing api key", "Error: missing API key for provider glm"],
    ["model not found", "model glm-9-nonexistent not found"],
    ["model_not_found", '{"error":{"code":"model_not_found"}}'],
  ] as const)("control: a real configuration failure (%s) still classifies as configuration_incomplete", (_label, error) => {
    expect(
      classifyAdapterFailureForRecovery({
        error,
        errorCode: "adapter_failed",
        resultJson: { stdout: `${GLM_METADATA_WARNING}\n`, stderr: "" },
      } as never),
    ).toEqual({ kind: "configuration_incomplete" });
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

describeEmbeddedPostgres("heartbeat treats a provider HTTP 5xx as transient", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-provider-5xx-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: nextResult.errorMessage,
        errorCode: nextResult.errorCode ?? null,
        errorFamily: nextResult.errorFamily ?? null,
        resultJson: {
          stdout: `${GLM_METADATA_WARNING}\n${TRANSCRIPT_QUOTA_NOISE}\n${nextResult.stdoutExtra ?? ""}`,
          stderr: `${nextResult.errorMessage}\n`,
          ...(nextResult.errorFamily ? { errorFamily: nextResult.errorFamily } : {}),
        },
      }),
      testEnvironment: async () => ({
        adapterType: ADAPTER,
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
    unregisterServerAdapter(ADAPTER);
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "IT Manager",
      role: "engineer",
      status: "idle",
      adapterType: ADAPTER,
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function runOnce(result: AdapterResultShape) {
    nextResult = result;
    const { agentId } = await seedAgent();
    const run = await heartbeat.invoke(agentId, "on_demand", {}, "manual");
    expect(run).not.toBeNull();
    const finished = await waitForRunToFinish(heartbeat, run!.id);
    const retries = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
    const agent = await db.select().from(agents).where(eq(agents.id, agentId)).then((rows) => rows[0]!);
    return { finished, retries, agent };
  }

  it.each([
    ["the live nginx 502", { errorMessage: LIVE_502 }],
    ["a 502 the adapter mislabelled provider_quota from transcript text", {
      errorMessage: LIVE_502,
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
    }],
    ["a 500", { errorMessage: "unexpected status 500 Internal Server Error: upstream exploded" }],
    ["a 503", { errorMessage: "unexpected status 503 Service Unavailable: <html><head><title>503 Service Temporarily Unavailable</title></head></html>" }],
    ["a 504", { errorMessage: "unexpected status 504 Gateway Timeout: <html><head><title>504 Gateway Time-out</title></head></html>" }],
    ["a bare nginx Bad Gateway page", { errorMessage: NGINX_BODY }],
  ] as const)("%s: transient code, bounded retry queued, agent never goes to error", async (_label, result) => {
    const { finished, retries, agent } = await runOnce(result);
    expect(finished?.status).toBe("failed");
    expect(finished?.errorCode).toBe("provider_http_5xx");
    expect((finished?.resultJson as Record<string, unknown>)?.errorFamily).toBe("transient_upstream");
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({
      status: "scheduled_retry",
      scheduledRetryReason: "transient_failure",
      scheduledRetryAttempt: 1,
    });
    expect(agent.status).not.toBe("error");
    expect(agent.errorReason).toBeNull();
  });

  it("control: a 409 api_refusal still records api_refusal, queues no retry, and errors the agent", async () => {
    const { finished, retries, agent } = await runOnce({ errorMessage: REFUSAL_409 });
    expect(finished?.errorCode).toBe("api_refusal");
    expect(retries).toHaveLength(0);
    expect(agent.status).toBe("error");
  });

  it("control: a 429 keeps its current behavior (adapter_failed, agent error, not provider_http_5xx)", async () => {
    const { finished, agent } = await runOnce({
      errorMessage: "unexpected status 429 Too Many Requests: rate limited",
    });
    expect(finished?.errorCode).toBe("adapter_failed");
    expect(agent.status).toBe("error");
  });

  it("control: a missing credential still errors the agent and classifies configuration_incomplete in recovery", async () => {
    const { finished, retries, agent } = await runOnce({
      errorMessage: "Error: missing API key for provider glm",
    });
    expect(finished?.errorCode).toBe("adapter_failed");
    expect(retries).toHaveLength(0);
    expect(agent.status).toBe("error");
    expect(classifyAdapterFailureForRecovery(finished as never)).toEqual({ kind: "configuration_incomplete" });
  });

  it("control: agent output that merely quotes a 502 does not make a non-5xx failure transient", async () => {
    const { finished } = await runOnce({
      errorMessage: "Codex exited with code 1",
      stdoutExtra: `The deploy log said: ${LIVE_502}\n`,
    });
    expect(finished?.errorCode).toBe("adapter_failed");
  });
});
