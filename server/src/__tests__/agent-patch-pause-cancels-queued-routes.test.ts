import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentConfigRevisions,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres PATCH pause route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// agentos#596: PATCH /agents/:id with {status:"paused"} must leave the paused
// agent holding no queued work, the same as POST /agents/:id/pause.
describeEmbeddedPostgres("PATCH /agents/:id pause cancels queued work", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-patch-pause-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentConfigRevisions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app() {
    const routerApp = express();
    routerApp.use(express.json());
    routerApp.use((req, _res, next) => {
      (req as any).actor = {
        type: "board",
        source: "local_implicit",
        userId: "local-board",
        companyIds: [] as string[],
        isInstanceAdmin: false,
      };
      next();
    });
    routerApp.use("/api", agentRoutes(db));
    routerApp.use(errorHandler);
    return routerApp;
  }

  async function seedAgent(status = "active") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Patch Pause ${companyId.slice(0, 6)}`,
      issuePrefix: `PP${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Website Evaluator",
      role: "engineer",
      status,
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function plantQueuedRun(companyId: string, agentId: string) {
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      reason: "issue_assigned",
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
      contextSnapshot: {},
    });
    return { runId, wakeupRequestId };
  }

  async function readRun(runId: string) {
    return db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  it("cancels a queued run when PATCH sets status paused, and again on a repeated pause", async () => {
    const { companyId, agentId } = await seedAgent("active");
    const first = await plantQueuedRun(companyId, agentId);

    const pause = await request(app()).patch(`/api/agents/${agentId}`).send({ status: "paused" });
    expect(pause.status, JSON.stringify(pause.body)).toBe(200);
    expect(pause.body.status).toBe("paused");

    expect(await readRun(first.runId)).toEqual({ status: "cancelled", errorCode: "agent_paused" });
    const firstWake = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, first.wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(firstWake).toEqual({ status: "cancelled" });

    // A row that raced in after the first pause committed is swept by a
    // repeated pause on the already-paused agent.
    const second = await plantQueuedRun(companyId, agentId);
    const repeat = await request(app()).patch(`/api/agents/${agentId}`).send({ status: "paused" });
    expect(repeat.status, JSON.stringify(repeat.body)).toBe(200);
    expect(await readRun(second.runId)).toEqual({ status: "cancelled", errorCode: "agent_paused" });

    const queuedLeft = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.status, "queued"));
    expect(queuedLeft).toEqual([]);
  });

  it("leaves queued work alone when PATCH does not pause the agent", async () => {
    const { companyId, agentId } = await seedAgent("active");
    const planted = await plantQueuedRun(companyId, agentId);

    const rename = await request(app()).patch(`/api/agents/${agentId}`).send({ title: "Evaluator" });
    expect(rename.status, JSON.stringify(rename.body)).toBe(200);

    expect(await readRun(planted.runId)).toEqual({ status: "queued", errorCode: null });
  });
});
