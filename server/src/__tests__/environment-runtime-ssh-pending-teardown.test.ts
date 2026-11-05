import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

// Stub only the SSH command runner at its module boundary. Every other export of
// the SSH module (shellQuote included) stays real.
const runSshCommandMock = vi.hoisted(() => vi.fn());
vi.mock("@paperclipai/adapter-utils/ssh", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/ssh")>();
  return { ...actual, runSshCommand: runSshCommandMock };
});

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { environmentRuntimeService } from "../services/environment-runtime.ts";
import { environmentService } from "../services/environments.ts";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres ssh pending teardown tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

const SSH_CONFIG = {
  host: "ssh.example.test",
  port: 22,
  username: "ssh-user",
  remoteWorkspacePath: "/srv/paperclip/workspace",
  privateKey: null,
  knownHosts: null,
  strictHostKeyChecking: true,
};

function exitError(code: number, stdout = "", stderr = "") {
  return Object.assign(new Error(`Command failed with exit code ${code}`), { code, stdout, stderr });
}

describeEmbeddedPostgres("ssh driver retryPendingSandboxTeardown", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ssh-pending-teardown-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  beforeEach(() => {
    runSshCommandMock.mockReset();
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(heartbeatRuns);
    await db.delete(environments);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(input: {
    driver?: "ssh" | "local";
    provider?: string;
    providerLeaseId?: string | null;
    withRun?: boolean;
  } = {}) {
    const driver = input.driver ?? "ssh";
    const companyId = randomUUID();
    const agentId = randomUUID();
    const environmentId = randomUUID();
    const runId = randomUUID();
    const leaseId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(environments).values({
      id: environmentId,
      name: `${driver}-${environmentId.slice(0, 8)}`,
      driver,
      status: "active",
      config: driver === "ssh" ? SSH_CONFIG : {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const withRun = input.withRun ?? true;
    if (withRun) {
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "manual",
        status: "cancelled",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const defaultProviderLeaseId = driver === "ssh"
      ? `ssh://${SSH_CONFIG.username}@${SSH_CONFIG.host}:${SSH_CONFIG.port}${SSH_CONFIG.remoteWorkspacePath}`
      : null;
    await db.insert(environmentLeases).values({
      id: leaseId,
      companyId,
      environmentId,
      heartbeatRunId: withRun ? runId : null,
      status: "pending_cleanup",
      leasePolicy: "ephemeral",
      provider: input.provider ?? driver,
      providerLeaseId: input.providerLeaseId === undefined ? defaultProviderLeaseId : input.providerLeaseId,
      cleanupStatus: "failed",
      failureReason: "pending_cleanup_retry",
      metadata: { driver },
      acquiredAt: past,
      lastUsedAt: past,
      releasedAt: past,
      createdAt: past,
      updatedAt: past,
    });
    const environment = await environmentService(db).getById(environmentId);
    const lease = await environmentService(db).getLeaseById(leaseId);
    return { companyId, environmentId, runId, leaseId, environment: environment!, lease: lease! };
  }

  async function readLease(leaseId: string) {
    return await db
      .select()
      .from(environmentLeases)
      .where(eq(environmentLeases.id, leaseId))
      .then((rows) => rows[0]!);
  }

  it("resolves when the remote host has no process for the run", async () => {
    const { environment, lease, runId } = await seed();
    runSshCommandMock.mockRejectedValueOnce(exitError(1));
    const runtime = environmentRuntimeService(db);

    await expect(runtime.retryPendingSandboxTeardown({ environment, lease })).resolves.toBeUndefined();

    expect(runSshCommandMock).toHaveBeenCalledTimes(1);
    const [config, command, options] = runSshCommandMock.mock.calls[0]!;
    expect(config).toMatchObject({ host: SSH_CONFIG.host, port: SSH_CONFIG.port, username: SSH_CONFIG.username });
    expect(command).toContain("pgrep -f");
    expect(command).toContain(runId.slice(1));
    expect(options).toMatchObject({ timeoutMs: expect.any(Number) });
  });

  it("throws when the remote host still has a process for the run", async () => {
    const { environment, lease } = await seed();
    runSshCommandMock.mockResolvedValueOnce({ stdout: "4242\n4243\n", stderr: "" });
    const runtime = environmentRuntimeService(db);

    await expect(runtime.retryPendingSandboxTeardown({ environment, lease })).rejects.toThrow(/still running/i);
    expect(runSshCommandMock).toHaveBeenCalledTimes(1);
  });

  it("throws when the ssh connection fails", async () => {
    const { environment, lease } = await seed();
    runSshCommandMock.mockRejectedValueOnce(
      exitError(255, "", "ssh: connect to host ssh.example.test port 22: Connection refused"),
    );
    const runtime = environmentRuntimeService(db);

    await expect(runtime.retryPendingSandboxTeardown({ environment, lease })).rejects.toThrow();
    expect(runSshCommandMock).toHaveBeenCalledTimes(1);
  });

  it("throws when pgrep exits 1 but still printed output", async () => {
    const { environment, lease } = await seed();
    runSshCommandMock.mockRejectedValueOnce(exitError(1, "4242\n"));
    const runtime = environmentRuntimeService(db);

    await expect(runtime.retryPendingSandboxTeardown({ environment, lease })).rejects.toThrow();
  });

  it("throws without running ssh when the environment is gone", async () => {
    const { lease } = await seed();
    const runtime = environmentRuntimeService(db);

    await expect(runtime.retryPendingSandboxTeardown({ environment: null, lease })).rejects.toThrow();
    expect(runSshCommandMock).not.toHaveBeenCalled();
  });

  it("throws without running ssh when the lease has no run id", async () => {
    const { environment, lease } = await seed({ withRun: false });
    const runtime = environmentRuntimeService(db);

    await expect(runtime.retryPendingSandboxTeardown({ environment, lease })).rejects.toThrow();
    expect(runSshCommandMock).not.toHaveBeenCalled();
  });

  it("throws without running ssh when the lease provider is not ssh", async () => {
    const { environment, lease } = await seed({ provider: "fake" });
    const runtime = environmentRuntimeService(db);

    await expect(runtime.retryPendingSandboxTeardown({ environment, lease })).rejects.toThrow();
    expect(runSshCommandMock).not.toHaveBeenCalled();
  });

  it("throws without running ssh when the provider lease id is not an ssh url", async () => {
    const { environment, lease } = await seed({ providerLeaseId: "sandbox://fake/abc" });
    const runtime = environmentRuntimeService(db);

    await expect(runtime.retryPendingSandboxTeardown({ environment, lease })).rejects.toThrow();
    expect(runSshCommandMock).not.toHaveBeenCalled();
  });

  it("throws without running ssh when the lease points at a different host than the environment", async () => {
    const { environment, lease } = await seed({ providerLeaseId: "ssh://other@other.example.test:22/srv/x" });
    const runtime = environmentRuntimeService(db);

    await expect(runtime.retryPendingSandboxTeardown({ environment, lease })).rejects.toThrow();
    expect(runSshCommandMock).not.toHaveBeenCalled();
  });

  it("keeps the local driver behaviour unchanged", async () => {
    const runtime = environmentRuntimeService(db);
    const ok = await seed({ driver: "local" });
    await expect(runtime.retryPendingSandboxTeardown({ environment: ok.environment, lease: ok.lease }))
      .resolves.toBeUndefined();

    const bad = await seed({ driver: "local", providerLeaseId: "ssh://x@y:22/z" });
    await expect(runtime.retryPendingSandboxTeardown({ environment: bad.environment, lease: bad.lease }))
      .rejects.toThrow("Local lease cleanup cannot release a provider resource.");
    expect(runSshCommandMock).not.toHaveBeenCalled();
  });

  it("sweep releases a stuck ssh lease once the remote host has no process", async () => {
    const { leaseId } = await seed();
    runSshCommandMock.mockRejectedValueOnce(exitError(1));
    const heartbeat = heartbeatService(db, { environmentRuntime: environmentRuntimeService(db) });

    const result = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });

    expect(result).toMatchObject({ swept: 1, destroyed: 1 });
    const row = await readLease(leaseId);
    expect(row.status).toBe("expired");
    expect(row.cleanupStatus).toBe("success");
  });

  it("sweep keeps the ssh lease pending while the remote process is alive", async () => {
    const { leaseId } = await seed();
    runSshCommandMock.mockResolvedValueOnce({ stdout: "4242\n", stderr: "" });
    const heartbeat = heartbeatService(db, { environmentRuntime: environmentRuntimeService(db) });

    const result = await heartbeat.sweepPendingCleanupLeases({ backoffMs: 0 });

    expect(result).toMatchObject({ destroyed: 0 });
    const row = await readLease(leaseId);
    expect(row.status).toBe("pending_cleanup");
    expect(row.cleanupStatus).toBe("failed");
  });
});
