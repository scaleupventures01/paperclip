import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  issues,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";
import { routineService } from "../services/routines.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent pause tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agent pause lifecycle", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-pause-replacement-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Pause ${companyId.slice(0, 6)}`,
      issuePrefix: `P${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string, status = "idle") {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name,
      role: "engineer",
      status,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return id;
  }

  async function seedRoutine(companyId: string, assigneeAgentId: string, title: string, status = "active") {
    const id = randomUUID();
    await db.insert(routines).values({ id, companyId, assigneeAgentId, title, status });
    return id;
  }

  async function seedIssue(companyId: string, assigneeAgentId: string, title: string, status = "todo") {
    const id = randomUUID();
    await db.insert(issues).values({ id, companyId, assigneeAgentId, title, status });
    return id;
  }

  it("moves active schedules and open cards to the replacement in one pause", async () => {
    const companyId = await seedCompany();
    const oldAgentId = await seedAgent(companyId, "Old seat");
    const replacementId = await seedAgent(companyId, "New seat");
    const activeRoutineId = await seedRoutine(companyId, oldAgentId, "Keeps running before the fix");
    const pausedRoutineId = await seedRoutine(companyId, oldAgentId, "Already paused", "paused");
    const openCardId = await seedIssue(companyId, oldAgentId, "Old open card");
    const terminalCardId = await seedIssue(companyId, oldAgentId, "Old terminal card", "done");

    const result = await agentService(db).pause(oldAgentId, { replacementAgentId: replacementId });

    expect(result).toMatchObject({ id: oldAgentId, status: "paused" });
    expect(result?.scheduleChanges).toEqual({ activeBefore: 1, moved: 1, paused: 0 });
    expect(result?.cardChanges).toEqual({ openBefore: 1, moved: 1, closed: 0 });
    expect(await db.select().from(routines).where(eq(routines.id, activeRoutineId)))
      .toMatchObject([{ assigneeAgentId: replacementId, status: "active" }]);
    expect(await db.select().from(routines).where(eq(routines.id, pausedRoutineId)))
      .toMatchObject([{ assigneeAgentId: oldAgentId, status: "paused" }]);
    expect(await db.select().from(issues).where(eq(issues.id, openCardId)))
      .toMatchObject([{ assigneeAgentId: replacementId, status: "todo" }]);
    expect(await db.select().from(issues).where(eq(issues.id, terminalCardId)))
      .toMatchObject([{ assigneeAgentId: oldAgentId, status: "done" }]);

    const activeOnPaused = await db.select({ id: routines.id }).from(routines)
      .innerJoin(agents, eq(agents.id, routines.assigneeAgentId))
      .where(and(eq(routines.status, "active"), eq(agents.status, "paused")));
    expect(activeOnPaused).toEqual([]);
  });

  it("pauses active schedules and closes open cards as superseded when no replacement exists", async () => {
    const companyId = await seedCompany();
    const oldAgentId = await seedAgent(companyId, "Solo seat");
    const activeRoutineId = await seedRoutine(companyId, oldAgentId, "Solo routine");
    const openCardId = await seedIssue(companyId, oldAgentId, "Solo open card");

    const result = await agentService(db).pause(oldAgentId);

    expect(result).toMatchObject({ id: oldAgentId, status: "paused" });
    expect(result?.scheduleChanges).toEqual({ activeBefore: 1, moved: 0, paused: 1 });
    expect(result?.cardChanges).toEqual({ openBefore: 1, moved: 0, closed: 1 });
    expect(await db.select().from(routines).where(eq(routines.id, activeRoutineId)))
      .toMatchObject([{ assigneeAgentId: oldAgentId, status: "paused" }]);
    expect(await db.select().from(issues).where(eq(issues.id, openCardId)))
      .toMatchObject([{ assigneeAgentId: oldAgentId, status: "cancelled" }]);
  });

  it("refuses a replacement from another company before changing the paused agent", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const oldAgentId = await seedAgent(companyId, "Old seat");
    const foreignReplacementId = await seedAgent(otherCompanyId, "Foreign replacement");
    await seedRoutine(companyId, oldAgentId, "Old routine");
    await seedIssue(companyId, oldAgentId, "Old card");

    await expect(agentService(db).pause(oldAgentId, { replacementAgentId: foreignReplacementId }))
      .rejects.toThrow("Replacement agent must be in the same company");

    expect(await db.select().from(agents).where(inArray(agents.id, [oldAgentId])))
      .toMatchObject([{ id: oldAgentId, status: "idle" }]);
    expect(await db.select().from(routines)).toMatchObject([{ status: "active" }]);
    expect(await db.select().from(issues)).toMatchObject([{ status: "todo" }]);
  });

  it("flags and suppresses a due schedule when its agent is already paused", async () => {
    const companyId = await seedCompany();
    const oldAgentId = await seedAgent(companyId, "Old seat", "paused");
    const routineId = await seedRoutine(companyId, oldAgentId, "Escaped watchdog");
    const triggerId = randomUUID();
    await db.insert(routineTriggers).values({
      id: triggerId,
      companyId,
      routineId,
      kind: "schedule",
      cronExpression: "0 0 * * *",
      timezone: "UTC",
      nextRunAt: new Date("2026-10-08T00:00:00.000Z"),
    });

    expect(await routineService(db).tickScheduledTriggers(new Date("2026-10-08T00:01:00.000Z")))
      .toEqual({ triggered: 0, flaggedPausedAgent: 1 });
    expect(await db.select().from(routineRuns).where(eq(routineRuns.routineId, routineId)))
      .toMatchObject([{ failureReason: "agent_paused" }]);
    expect(await db.select().from(routineTriggers).where(eq(routineTriggers.id, triggerId)))
      .toMatchObject([{ nextRunAt: new Date("2026-10-09T00:00:00.000Z") }]);
  });
});
