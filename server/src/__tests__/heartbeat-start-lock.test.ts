import { randomUUID } from "node:crypto";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  type Db,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { hasAgentStartCapacity } from "../services/agent-start-lock.ts";

const support = await getEmbeddedPostgresTestSupport();

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

(support.supported ? describe : describe.skip)("heartbeat agent start lock", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-start-lock-");
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
  });

  async function seedAgent(db: Db) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Agent start capacity",
      issuePrefix: `L${companyId.replace(/-/g, "").slice(0, 7)}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent ${agentId.slice(0, 8)}`,
      role: "engineer",
      adapterType: "codex_local",
      status: "active",
    });
    return { companyId, agentId };
  }

  it("uses the claim transaction connection when the pool has one slot", async () => {
    const db = createDb(database.connectionString, { maxConnections: 1 });
    const { agentId } = await seedAgent(db);

    await expect(
      db.transaction(async (tx) => {
        const available = await hasAgentStartCapacity(
          tx as unknown as Db,
          agentId,
          1,
        );
        await tx.execute(sql`select 1`);
        return available;
      }),
    ).resolves.toBe(true);
  });

  it("lets only one of two database clients claim maxConcurrentRuns 1", async () => {
    const firstDb = createDb(database.connectionString);
    const secondDb = createDb(database.connectionString);
    const { companyId, agentId } = await seedAgent(firstDb);
    const firstClaimed = deferred();
    const releaseFirst = deferred();

    const first = firstDb.transaction(async (tx) => {
      const available = await hasAgentStartCapacity(
        tx as unknown as Db,
        agentId,
        1,
      );
      expect(available).toBe(true);
      await tx.insert(heartbeatRuns).values({
        companyId,
        agentId,
        status: "running",
        startedAt: new Date(),
      });
      firstClaimed.resolve();
      await releaseFirst.promise;
    });
    await firstClaimed.promise;

    let secondFinished = false;
    const second = secondDb
      .transaction((tx) =>
        hasAgentStartCapacity(tx as unknown as Db, agentId, 1),
      )
      .finally(() => {
        secondFinished = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(secondFinished).toBe(false);

    releaseFirst.resolve();
    await first;
    await expect(second).resolves.toBe(false);
  });

  it("known-negative control allows two unguarded claims", async () => {
    const firstDb = createDb(database.connectionString);
    const secondDb = createDb(database.connectionString);
    const { companyId, agentId } = await seedAgent(firstDb);
    const firstCounted = deferred();
    const secondCounted = deferred();

    const first = firstDb.transaction(async (tx) => {
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "running"),
          ),
        );
      expect(Number(count)).toBe(0);
      firstCounted.resolve();
      await secondCounted.promise;
      await tx.insert(heartbeatRuns).values({
        companyId,
        agentId,
        status: "running",
        startedAt: new Date(),
      });
    });
    await firstCounted.promise;

    const second = secondDb.transaction(async (tx) => {
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.agentId, agentId),
            eq(heartbeatRuns.status, "running"),
          ),
        );
      expect(Number(count)).toBe(0);
      secondCounted.resolve();
      await tx.insert(heartbeatRuns).values({
        companyId,
        agentId,
        status: "running",
        startedAt: new Date(),
      });
    });

    await Promise.all([first, second]);
    const [{ count }] = await firstDb
      .select({ count: sql<number>`count(*)` })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.agentId, agentId),
          eq(heartbeatRuns.status, "running"),
        ),
      );
    expect(Number(count)).toBe(2);
  });

  it("does not serialize different agents", async () => {
    const firstDb = createDb(database.connectionString);
    const secondDb = createDb(database.connectionString);
    const firstAgent = await seedAgent(firstDb);
    const secondAgent = await seedAgent(secondDb);
    const releaseFirst = deferred();
    const firstEntered = deferred();

    const first = firstDb.transaction(async (tx) => {
      expect(
        await hasAgentStartCapacity(
          tx as unknown as Db,
          firstAgent.agentId,
          1,
        ),
      ).toBe(true);
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;

    await expect(
      secondDb.transaction((tx) =>
        hasAgentStartCapacity(
          tx as unknown as Db,
          secondAgent.agentId,
          1,
        ),
      ),
    ).resolves.toBe(true);
    releaseFirst.resolve();
    await first;
  });

  it("times out a stuck same-agent lock without claiming capacity", async () => {
    const firstDb = createDb(database.connectionString);
    const secondDb = createDb(database.connectionString);
    const { agentId } = await seedAgent(firstDb);
    const firstEntered = deferred();
    const releaseFirst = deferred();

    const first = firstDb.transaction(async (tx) => {
      expect(
        await hasAgentStartCapacity(tx as unknown as Db, agentId, 1),
      ).toBe(true);
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;

    await expect(
      secondDb.transaction((tx) =>
        hasAgentStartCapacity(tx as unknown as Db, agentId, 1, 50),
      ),
    ).rejects.toThrow();
    releaseFirst.resolve();
    await first;
  });

  it("releases the advisory lock when a claim transaction errors", async () => {
    const db = createDb(database.connectionString);
    const { agentId } = await seedAgent(db);

    await expect(
      db.transaction(async (tx) => {
        expect(
          await hasAgentStartCapacity(tx as unknown as Db, agentId, 1),
        ).toBe(true);
        throw new Error("known claim failure");
      }),
    ).rejects.toThrow("known claim failure");

    await expect(
      db.transaction((tx) =>
        hasAgentStartCapacity(tx as unknown as Db, agentId, 1),
      ),
    ).resolves.toBe(true);
  });
});
