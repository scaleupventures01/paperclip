import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  activityLog,
  companies,
  createDb,
  issueThreadInteractions,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { HttpError } from "../errors.js";
import {
  blockingTerminalConfirmation,
  issueService,
  TERMINAL_ISSUE_STATUSES,
} from "./issues.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping terminal confirmation guard tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("terminal issue confirmation guard", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let companyId!: string;
  let creatorId!: string;
  let resolverId!: string;
  let resolverRunId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-terminal-confirmation-guard-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    creatorId = randomUUID();
    resolverId = randomUUID();
    resolverRunId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Guard Test",
      issuePrefix: "GUARD",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: creatorId,
        companyId,
        name: "Creator",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: resolverId,
        companyId,
        name: "Resolver",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values({
      id: resolverRunId,
      companyId,
      agentId: resolverId,
      status: "running",
    });
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createIssue(title: string) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title,
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: creatorId,
      createdByAgentId: creatorId,
    });
    return issueService(db).getById(id) as Promise<NonNullable<Awaited<ReturnType<ReturnType<typeof issueService>["getById"]>>>>;
  }

  async function createConfirmation(input: {
    issueId: string;
    addresseeAgentId: string;
    status?: "pending" | "accepted" | "cancelled" | "expired";
  }) {
    const id = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id,
      companyId,
      issueId: input.issueId,
      kind: "request_confirmation",
      status: input.status ?? "pending",
      addresseeAgentId: input.addresseeAgentId,
      payload: { version: 1, prompt: "Approve closure?" },
    });
    return db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, id))
      .then((rows) => rows[0]);
  }

  it("classifies only an unresolved addressed confirmation as blocking", () => {
    expect(TERMINAL_ISSUE_STATUSES).toEqual(["done", "cancelled"]);
    const confirmation = {
      id: "pending",
      kind: "request_confirmation",
      status: "pending",
      addresseeAgentId: resolverId,
      addresseeUserId: null,
    };
    expect(blockingTerminalConfirmation([confirmation])?.id).toBe("pending");
    expect(blockingTerminalConfirmation([{ ...confirmation, status: "accepted" }])).toBeUndefined();
    expect(blockingTerminalConfirmation([{ ...confirmation, status: "expired" }])).toBeUndefined();
    expect(blockingTerminalConfirmation([{ ...confirmation, addresseeAgentId: creatorId }])?.id).toBe("pending");
    expect(blockingTerminalConfirmation([{ ...confirmation, addresseeAgentId: null, addresseeUserId: null }])).toBeUndefined();
  });

  it("refuses creator closure, preserves the card, and closes after addressee acceptance", async () => {
    const issue = await createIssue("Guarded issue");
    const otherIssue = await createIssue("Unrelated guarded issue");
    const confirmation = await createConfirmation({ issueId: issue.id, addresseeAgentId: resolverId });
    const unrelated = await createConfirmation({ issueId: otherIssue.id, addresseeAgentId: resolverId });
    const service = issueService(db);

    let refusal: unknown;
    try {
      await service.update(issue.id, { status: "done", actorAgentId: creatorId });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(HttpError);
    const httpError = refusal as HttpError;
    expect(httpError.status).toBe(422);
    expect(httpError.details).toEqual({
      code: "pending_confirmation_blocks_terminal_transition",
      interactionId: confirmation.id,
      requestedStatus: "done",
    });

    const unchangedIssue = await service.getById(issue.id);
    expect(unchangedIssue).toMatchObject({ status: "in_progress", completedAt: null });
    const [unchangedCard] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, confirmation.id));
    expect(unchangedCard).toMatchObject({
      id: confirmation.id,
      status: "pending",
      addresseeAgentId: resolverId,
    });
    const [unchangedOtherCard] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, unrelated.id));
    expect(unchangedOtherCard).toEqual(unrelated);

    await db.insert(heartbeatRuns).values({
      id: resolverRunId,
      companyId,
      agentId: resolverId,
      status: "running",
    });
    if (!unchangedIssue) throw new Error("Expected guarded issue to remain readable");
    await issueThreadInteractionService(db).acceptInteraction(
      unchangedIssue,
      confirmation.id,
      {},
      { agentId: resolverId, runId: resolverRunId },
    );
    const closed = await service.update(issue.id, { status: "done", actorAgentId: creatorId });
    expect(closed).toMatchObject({ status: "done" });
    expect(closed?.completedAt).not.toBeNull();
  });

  it("closes normally with no card and after the addressee's own card is withdrawn", async () => {
    const unguarded = await createIssue("No confirmation");
    await issueService(db).update(unguarded.id, { status: "cancelled", actorAgentId: creatorId });
    expect((await issueService(db).getById(unguarded.id))?.status).toBe("cancelled");

    const owned = await createIssue("Own confirmation withdrawn");
    const ownCard = await createConfirmation({ issueId: owned.id, addresseeAgentId: creatorId });
    await issueThreadInteractionService(db).withdrawInteraction(
      owned,
      ownCard.id,
      {},
      { agentId: creatorId },
    );
    const closed = await issueService(db).update(owned.id, { status: "done", actorAgentId: creatorId });
    expect(closed).toMatchObject({ status: "done" });
  });

  it("guards cancelled closure until the addressee rejects the card", async () => {
    const issue = await createIssue("Cancelled guarded issue");
    const confirmation = await createConfirmation({ issueId: issue.id, addresseeAgentId: resolverId });
    const service = issueService(db);

    let refusal: unknown;
    try {
      await service.update(issue.id, { status: "cancelled", actorAgentId: creatorId });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(HttpError);
    expect((refusal as HttpError).details).toMatchObject({
      code: "pending_confirmation_blocks_terminal_transition",
      interactionId: confirmation.id,
      requestedStatus: "cancelled",
    });
    expect(await service.getById(issue.id)).toMatchObject({ status: "in_progress" });

    await db.insert(heartbeatRuns).values({
      id: resolverRunId,
      companyId,
      agentId: resolverId,
      status: "running",
    });
    await issueThreadInteractionService(db).rejectInteraction(
      issue,
      confirmation.id,
      { reason: "Not ready" },
      { agentId: resolverId, runId: resolverRunId },
    );
    const closed = await service.update(issue.id, { status: "cancelled", actorAgentId: creatorId });
    expect(closed).toMatchObject({ status: "cancelled" });
    expect(closed?.completedAt).toBeNull();
  });

  it("refuses terminal closure for a card addressed to the current actor", async () => {
    const issue = await createIssue("Current actor confirmation");
    const confirmation = await createConfirmation({ issueId: issue.id, addresseeAgentId: resolverId });
    const service = issueService(db);

    let refusal: unknown;
    try {
      await service.update(issue.id, { status: "done", actorAgentId: resolverId });
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(HttpError);
    expect((refusal as HttpError).details).toEqual({
      code: "pending_confirmation_blocks_terminal_transition",
      interactionId: confirmation.id,
      requestedStatus: "done",
    });
    expect(await service.getById(issue.id)).toMatchObject({
      status: "in_progress",
      completedAt: null,
    });

    const [stillPendingCard] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, confirmation.id));
    expect(stillPendingCard).toEqual(confirmation);
  });

  it("refuses terminal closure for a card addressed to the issue creator", async () => {
    const issue = await createIssue("Creator confirmation");
    const confirmation = await createConfirmation({ issueId: issue.id, addresseeAgentId: creatorId });
    const service = issueService(db);

    let refusal: unknown;
    try {
      await service.update(issue.id, { status: "done", actorAgentId: creatorId });
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(HttpError);
    expect((refusal as HttpError).details).toEqual({
      code: "pending_confirmation_blocks_terminal_transition",
      interactionId: confirmation.id,
      requestedStatus: "done",
    });
    expect(await service.getById(issue.id)).toMatchObject({
      status: "in_progress",
      completedAt: null,
    });

    const [stillPendingCard] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, confirmation.id));
    expect(stillPendingCard).toEqual(confirmation);
  });

  it("never lets another issue's pending card block this issue", async () => {
    const target = await createIssue("No local confirmation");
    const other = await createIssue("Other issue");
    const otherCard = await createConfirmation({ issueId: other.id, addresseeAgentId: resolverId });

    await issueService(db).update(target.id, { status: "done", actorAgentId: creatorId });
    expect((await issueService(db).getById(target.id))?.status).toBe("done");
    const [stillPending] = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, otherCard.id));
    expect(stillPending).toMatchObject({ status: "pending", issueId: other.id });
  });
});
