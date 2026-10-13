import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
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
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Claim gate test run.",
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

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres claim gate tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const originalGateEnv = process.env.AGENTOS_FLEET_RELEASE_GATE;

// agentos#596 follow-up: six producers insert queued heartbeat runs without
// enqueueWakeup (wake-queue promotion and recovery, recovery service, native
// safe replacement). The claim path every queued run passes through must
// cancel a run for an agent the fleet release gate excludes, or whose agent is
// paused, before any adapter work, instead of leaving it queued.
describeEmbeddedPostgres("queued run claim honors the fleet release gate and pause", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const gateDir = mkdtempSync(path.join(tmpdir(), "claim-fleet-gate-"));
  const gatePath = path.join(gateDir, "fleet-release-gate.json");

  beforeAll(async () => {
    process.env.AGENTOS_FLEET_RELEASE_GATE = gatePath;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-claim-fleet-gate-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  beforeEach(() => {
    mockAdapterExecute.mockClear();
  });

  afterEach(async () => {
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
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
    rmSync(gateDir, { recursive: true, force: true });
    if (originalGateEnv === undefined) delete process.env.AGENTOS_FLEET_RELEASE_GATE;
    else process.env.AGENTOS_FLEET_RELEASE_GATE = originalGateEnv;
  });

  function writeGate(allowedAgentIds: string[]) {
    writeFileSync(gatePath, JSON.stringify({ version: 1, enabled: true, allowedAgentIds }));
  }

  async function seedAgent(status = "idle") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Claim Gate",
      issuePrefix: `CG${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "System Steward",
      role: "engineer",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  // Same rows finalizePromotedWake (modules/wake-queue/adapters/postgres.ts:444)
  // writes when it promotes a deferred wake: the wakeup request moved to queued
  // with reason issue_execution_promoted, a queued run linked to it, and the
  // issue execution lock pointing at the run. No admission check runs there.
  async function insertPromotedWakeQueuedRun(companyId: string, agentId: string) {
    const issueId = randomUUID();
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Recovered work",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_execution_promoted",
      payload: { issueId },
      status: "queued",
      requestedByActorType: "system",
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      responsibleUserId: "responsible-user",
      // skipIssueComment keeps the missing-comment follow-up out of the count.
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned", skipIssueComment: true },
    });
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, wakeupRequestId));
    await db.update(issues)
      .set({ executionRunId: runId, executionAgentNameKey: "system steward", executionLockedAt: new Date() })
      .where(eq(issues.id, issueId));
    return { issueId, wakeupRequestId, runId };
  }

  async function readRun(runId: string) {
    return db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode, finishedAt: heartbeatRuns.finishedAt, startedAt: heartbeatRuns.startedAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  async function readWake(id: string) {
    return db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, id))
      .then((rows) => rows[0] ?? null);
  }

  async function readIssueLock(id: string) {
    return db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, id))
      .then((rows) => rows[0] ?? null);
  }

  it("cancels a directly inserted queued run for an excluded agent at claim, before any adapter work", async () => {
    const { companyId, agentId } = await seedAgent("error");
    const planted = await insertPromotedWakeQueuedRun(companyId, agentId);
    writeGate([]);

    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const run = await readRun(planted.runId);
    expect(run).toMatchObject({ status: "cancelled", errorCode: "fleet_release_gate_not_allowed", startedAt: null });
    expect(run?.finishedAt).toBeInstanceOf(Date);
    expect(await readWake(planted.wakeupRequestId)).toEqual({ status: "skipped" });
    expect(await readIssueLock(planted.issueId)).toEqual({ executionRunId: null });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("cancels the excluded agent's queued run even when its run slot is busy", async () => {
    const { companyId, agentId } = await seedAgent("running");
    await db.insert(heartbeatRuns).values({
      companyId,
      agentId,
      invocationSource: "automation",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: {},
    });
    const planted = await insertPromotedWakeQueuedRun(companyId, agentId);
    writeGate([]);

    await heartbeat.resumeQueuedRuns();

    expect(await readRun(planted.runId)).toMatchObject({
      status: "cancelled",
      errorCode: "fleet_release_gate_not_allowed",
    });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("cancels a queued race row for a paused agent at claim instead of leaving it queued", async () => {
    const { companyId, agentId } = await seedAgent("paused");
    const planted = await insertPromotedWakeQueuedRun(companyId, agentId);
    writeGate([agentId]);

    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    expect(await readRun(planted.runId)).toMatchObject({ status: "cancelled", errorCode: "agent_paused", startedAt: null });
    expect(await readWake(planted.wakeupRequestId)).toEqual({ status: "skipped" });
    expect(await readIssueLock(planted.issueId)).toEqual({ executionRunId: null });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("control: an allowlisted idle agent's queued run is claimed and started", async () => {
    const { companyId, agentId } = await seedAgent("idle");
    const planted = await insertPromotedWakeQueuedRun(companyId, agentId);
    writeGate([agentId]);

    await heartbeat.resumeQueuedRuns();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const run = await readRun(planted.runId);
    expect(run?.status).not.toBe("queued");
    expect(run?.status).not.toBe("cancelled");
    expect(run?.startedAt).toBeInstanceOf(Date);
    // The planted run started; a follow-up continuation run may also execute.
    expect(mockAdapterExecute).toHaveBeenCalled();
  });
});
