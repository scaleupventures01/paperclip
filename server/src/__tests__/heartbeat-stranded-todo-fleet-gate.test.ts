import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { heartbeatService } from "../services/heartbeat.ts";

// Wake storm on held agents (wakestorm-20261014 section 5, P1/P2): the stranded
// todo sweep re-dispatched an assigned-todo wake about every 15 s for any idle
// owner held off the fleet allowlist, and the fleet gate skipped each one
// (5,566 skipped rows on 2026-10-14, about 240 per hour per held card).

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Stranded todo gate test run.",
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
    `Skipping embedded Postgres stranded-todo fleet gate tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("the stranded todo sweep respects the fleet release gate", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let gateDir = "";
  let gateFile = "";
  const originalGateEnv = process.env.AGENTOS_FLEET_RELEASE_GATE;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-stranded-todo-gate-");
    db = createDb(tempDb.connectionString);
    const now = new Date();
    await db.insert(authUsers).values({
      id: "responsible-user",
      name: "Responsible User",
      email: "responsible-user@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
  }, 30_000);

  beforeEach(() => {
    gateDir = mkdtempSync(path.join(tmpdir(), "stranded-gate-"));
    gateFile = path.join(gateDir, "fleet-release-gate.json");
    process.env.AGENTOS_FLEET_RELEASE_GATE = gateFile;
    mockAdapterExecute.mockClear();
  });

  afterEach(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
    if (originalGateEnv === undefined) delete process.env.AGENTOS_FLEET_RELEASE_GATE;
    else process.env.AGENTOS_FLEET_RELEASE_GATE = originalGateEnv;
    rmSync(gateDir, { recursive: true, force: true });
    // Each test seeds its own company, agent and card, so rows are left in place
    // (the run path also writes skills and environments that reference them).
    // Park every seeded todo card so a later test's sweep sees only its own.
    await db.update(issues).set({ status: "done" }).where(eq(issues.status, "todo"));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function writeGate(gate: Record<string, unknown>) {
    writeFileSync(gateFile, JSON.stringify(gate));
  }

  async function seedIdleOwnerWithTodo() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Gate ${companyId.slice(0, 6)}`,
      issuePrefix: `G${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Held seat",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      assigneeAgentId: agentId,
      title: "Assigned todo card with no run",
      status: "todo",
      priority: "medium",
      responsibleUserId: "responsible-user",
    });
    return { companyId, agentId, issueId };
  }

  async function wakesFor(agentId: string) {
    return db
      .select({ status: agentWakeupRequests.status, reason: agentWakeupRequests.reason })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
  }

  it("P1: one sweep requests no wake for an idle owner held off the allowlist", async () => {
    const { agentId } = await seedIdleOwnerWithTodo();
    writeGate({ version: 1, enabled: true, allowedAgentIds: [randomUUID()] });

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(await wakesFor(agentId)).toEqual([]);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("P2 (control): the same owner on the allowlist is dispatched exactly once", async () => {
    const { agentId } = await seedIdleOwnerWithTodo();
    writeGate({ version: 1, enabled: true, allowedAgentIds: [agentId] });

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    const wakes = await wakesFor(agentId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.status).not.toBe("skipped");
  });

  it("P3 (control): with the gate disabled the owner is dispatched as before", async () => {
    const { agentId } = await seedIdleOwnerWithTodo();
    writeGate({ version: 1, enabled: false, allowedAgentIds: [] });

    await heartbeatService(db).reconcileStrandedAssignedIssues();

    const wakes = await wakesFor(agentId);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.status).not.toBe("skipped");
  });
});
