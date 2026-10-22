import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  agentWakeupRequests,
  companies,
  companySecretBindings,
  companySecrets,
  companySecretVersions,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  folders,
  heartbeatRunEvents,
  heartbeatRuns,
  issueInboxArchives,
  issues,
  projectWorkspaces,
  projects,
  routineDocuments,
  routineRevisions,
  routineRuns,
  routines,
  routineTriggers,
  secretAccessEvents,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { errorHandler } from "../middleware/index.js";
import { routineRoutes } from "../routes/routines.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { routineService } from "../services/routines.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Fleet release gate route test run.",
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
    `Skipping embedded Postgres routine webhook fleet gate tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const originalGateEnv = process.env.AGENTOS_FLEET_RELEASE_GATE;
const originalApiUrlEnv = process.env.PAPERCLIP_API_URL;

// agentos#596 follow-up: live 2026-10-13 18:36Z, System Steward (status error,
// not on the fleet release allowlist) was woken by a routine webhook and got a
// heartbeat run. The public routine trigger must respect the gate end to end.
describeEmbeddedPostgres("public routine webhook respects the fleet release gate", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const gateDir = mkdtempSync(path.join(tmpdir(), "routine-fleet-gate-"));
  const gatePath = path.join(gateDir, "fleet-release-gate.json");

  beforeAll(async () => {
    process.env.PAPERCLIP_API_URL = "http://localhost:3100";
    process.env.AGENTOS_FLEET_RELEASE_GATE = gatePath;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-routine-fleet-gate-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 60_000);

  afterEach(async () => {
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (let attempt = 0; ; attempt += 1) {
      try {
        await db.delete(activityLog);
        await db.delete(issueInboxArchives);
        await db.delete(secretAccessEvents);
        await db.delete(companySecretBindings);
        await db.delete(routineRuns);
        await db.delete(routineTriggers);
        await db.delete(routineRevisions);
        await db.delete(routines);
        await db.delete(folders);
        await db.delete(routineDocuments);
        await db.delete(documents);
        await db.delete(documentRevisions);
        await db.delete(companySecretVersions);
        await db.delete(companySecrets);
        await db.delete(environmentLeases);
        await db.delete(heartbeatRunEvents);
        await db.delete(heartbeatRuns);
        await db.delete(agentWakeupRequests);
        await db.delete(issues);
        await db.delete(executionWorkspaces);
        await db.delete(projectWorkspaces);
        await db.delete(projects);
        await db.delete(agentRuntimeState);
        await db.delete(agents);
        await db.delete(environments);
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
    if (originalApiUrlEnv === undefined) delete process.env.PAPERCLIP_API_URL;
    else process.env.PAPERCLIP_API_URL = originalApiUrlEnv;
  });

  function writeGate(allowedAgentIds: string[]) {
    writeFileSync(gatePath, JSON.stringify({ version: 1, enabled: true, allowedAgentIds }));
  }

  function app() {
    const routerApp = express();
    routerApp.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
    routerApp.use((req, _res, next) => {
      (req as any).actor = { type: "none", source: "none" };
      next();
    });
    routerApp.use("/api", routineRoutes(db));
    routerApp.use(errorHandler);
    return routerApp;
  }

  async function seedWebhookRoutine() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Fleet Gate",
      issuePrefix: `FG${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      defaultResponsibleUserId: randomUUID(),
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "System Steward",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Routines", status: "in_progress" });
    const svc = routineService(db);
    const routine = await svc.create(companyId, {
      projectId,
      goalId: null,
      parentIssueId: null,
      title: "Steward webhook",
      description: "Run the steward routine",
      assigneeAgentId: agentId,
      priority: "medium",
      status: "active",
      concurrencyPolicy: "coalesce_if_active",
      catchUpPolicy: "skip_missed",
    }, {});
    const { trigger, secretMaterial } = await svc.createTrigger(routine.id, {
      kind: "webhook",
      signingMode: "bearer",
      replayWindowSec: 300,
    }, {});
    return { agentId, publicId: trigger.publicId!, secret: secretMaterial!.webhookSecret };
  }

  async function fire(publicId: string, secret: string) {
    return request(app())
      .post(`/api/routine-triggers/public/${publicId}/fire`)
      .set("Content-Type", "application/json")
      .set("Authorization", `Bearer ${secret}`)
      .send({ event: "steward.check" });
  }

  async function runsFor(agentId: string) {
    return db
      .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, agentId));
  }

  it("creates no heartbeat run for an errored agent outside the allowlist", async () => {
    const { agentId, publicId, secret } = await seedWebhookRoutine();
    await db.update(agents).set({ status: "error" }).where(eq(agents.id, agentId));
    writeGate([]);

    const res = await fire(publicId, secret);
    expect(res.status, JSON.stringify(res.body)).toBe(202);

    expect(await runsFor(agentId)).toEqual([]);
    const wakes = await db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakes).toEqual([{ status: "skipped", reason: "fleet_release_gate.not_allowed" }]);
  });

  it("refuses a user manual wake for an agent outside the allowlist", async () => {
    const { agentId } = await seedWebhookRoutine();
    writeGate([]);

    const run = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_wake",
      requestedByActorType: "user",
      requestedByActorId: "board-user",
    });

    expect(run).toBeNull();
    expect(await runsFor(agentId)).toEqual([]);
  });

  it("control: an allowlisted idle agent gets exactly one queued run", async () => {
    const { agentId, publicId, secret } = await seedWebhookRoutine();
    writeGate([agentId]);

    const res = await fire(publicId, secret);
    expect(res.status, JSON.stringify(res.body)).toBe(202);

    const runs = await runsFor(agentId);
    expect(runs).toHaveLength(1);
  });
});
