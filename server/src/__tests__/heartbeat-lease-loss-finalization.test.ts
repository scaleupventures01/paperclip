import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

type LeaseWatch = { assertOwned(stage?: "dispatching"): Promise<void>; stop(): void };

const leaseWatches = vi.hoisted(() => new Map<string, LeaseWatch>());
const mockAdapterExecute = vi.hoisted(() => vi.fn());

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

// Keep the real lease watcher; only remember it so a test can force the same
// renewal check the 10 s interval would run, after expiring the lease row.
vi.mock("../services/legacy-controller-lease.ts", async () => {
  const actual = await vi.importActual<typeof import("../services/legacy-controller-lease.ts")>(
    "../services/legacy-controller-lease.ts",
  );
  return {
    ...actual,
    watchLegacyControllerLease: (...args: Parameters<typeof actual.watchLegacyControllerLease>) => {
      const watch = actual.watchLegacyControllerLease(...args);
      leaseWatches.set(args[1].id, watch);
      return watch;
    },
  };
});

const { heartbeatService } = await import("../services/heartbeat.ts");

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function waitFor<T>(fn: () => Promise<T | null | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeEmbeddedPostgres("legacy controller lease loss at finalization", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-lease-loss-finalization-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, {
      runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
    });
  }, 30_000);

  afterEach(async () => {
    mockAdapterExecute.mockReset();
    leaseWatches.clear();
    await waitFor(async () => {
      const rows = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      return rows.every((row) => row.status !== "queued" && row.status !== "running") || null;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await db.execute(sql.raw(`
      TRUNCATE TABLE "heartbeat_run_events", "cost_events", "activity_log", "heartbeat_runs",
        "agent_wakeup_requests", "agent_runtime_state", "agents", "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "QaCodex",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return { companyId, agentId };
  }

  /** Expire this run's lease row, then run the watcher's own renewal check. */
  async function loseLease(runId: string, signal: AbortSignal) {
    await db
      .update(heartbeatRuns)
      .set({ controllerLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(heartbeatRuns.id, runId));
    await leaseWatches.get(runId)?.assertOwned().catch(() => undefined);
    expect(signal.aborted).toBe(true);
    expect(String((signal.reason as Error | undefined)?.message)).toContain("Legacy controller lease lost");
  }

  const usage = { inputTokens: 1200, cachedInputTokens: 200, outputTokens: 34 };

  async function runToTerminal(agentId: string) {
    const queued = await heartbeat.wakeup(agentId, { source: "timer", triggerDetail: "schedule" });
    expect(queued).not.toBeNull();
    return waitFor(async () => {
      const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
      return row && row.status !== "queued" && row.status !== "running" ? row : null;
    });
  }

  it("(a) a lease loss on a run whose adapter exited 0 cleanly finalizes succeeded with usage kept", async () => {
    const { agentId } = await seedAgent();
    mockAdapterExecute.mockImplementation(async (ctx: { runId: string; signal: AbortSignal }) => {
      await loseLease(ctx.runId, ctx.signal);
      return {
        exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "QA finished", provider: "test", model: "test-model", usage,
      };
    });

    const run = await runToTerminal(agentId);

    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    expect(run.status).toBe("succeeded");
    expect(run.error).toBeNull();
    expect(run.errorCode).toBeNull();
    expect(run.usageJson).toMatchObject({ inputTokens: 1200, outputTokens: 34 });
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id));
    expect(events.some((event) => String(event.message ?? "").includes("Legacy controller lease lost"))).toBe(true);
  });

  it("(b) a board cancel still finalizes cancelled", async () => {
    const { agentId } = await seedAgent();
    mockAdapterExecute.mockImplementation(async (ctx: { runId: string; signal: AbortSignal }) => {
      await heartbeat.cancelRun(ctx.runId, "Cancelled by board");
      return {
        exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "stopped", provider: "test", model: "test-model", usage,
      };
    });

    const run = await runToTerminal(agentId);

    expect(run.status).toBe("cancelled");
    expect(run.error).toBe("Cancelled by board");
  });

  it("(b2) a board cancel after a lease loss on an owned adapter still finalizes cancelled", async () => {
    const { agentId } = await seedAgent();
    mockAdapterExecute.mockImplementation(async (ctx: {
      runId: string; signal: AbortSignal; onCancellationReady?: () => Promise<void>;
    }) => {
      await ctx.onCancellationReady?.();
      await loseLease(ctx.runId, ctx.signal);
      // The adapter owns its stop, so Stop records the cancel on the running row
      // and waits for this adapter to settle. Do not await it here.
      void heartbeat.cancelRun(ctx.runId, "Cancelled by board").catch(() => undefined);
      await waitFor(async () => {
        const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ctx.runId));
        return row?.errorCode === "cancelled" ? row : null;
      });
      return {
        exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "stopped", provider: "test", model: "test-model", usage,
      };
    });

    const run = await runToTerminal(agentId);

    expect(run.status).toBe("cancelled");
    expect(run.error).toBe("Cancelled by board");
  });

  it("(c) a lease loss with a nonzero adapter exit is not succeeded", async () => {
    const { agentId } = await seedAgent();
    mockAdapterExecute.mockImplementation(async (ctx: { runId: string; signal: AbortSignal }) => {
      await loseLease(ctx.runId, ctx.signal);
      return {
        exitCode: 1, signal: null, timedOut: false, errorMessage: "codex exited 1",
        summary: null, provider: "test", model: "test-model", usage,
      };
    });

    const run = await runToTerminal(agentId);

    expect(run.status).not.toBe("succeeded");
    expect(run.status).toBe("cancelled");
  });
});
