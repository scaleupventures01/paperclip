import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueRelations,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe.sequential
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping terminal blocker reconciliation tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("terminal blocker reconciliation", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-terminal-blocker-reconciliation-",
    );
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Terminal Blocker Reconciliation",
      issuePrefix: "RECON",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Assignee",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
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

  async function seedQueuedCheckoutParent(input: { issueId: string; runId: string }) {
    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId,
      agentId,
      status: "queued",
      contextSnapshot: { issueId: input.issueId, wakeReason: "issue_commented" },
    });
    await db.insert(issues).values({
      id: input.issueId,
      companyId,
      title: "Queued parent",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: input.runId,
      executionRunId: input.runId,
    });
  }

  async function seedBlocker(input: { issueId: string; parentId: string; status?: string }) {
    await db.insert(issues).values({
      id: input.issueId,
      companyId,
      title: input.status === "todo" ? "Open blocker" : "Cancelled blocker",
      status: input.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: input.issueId,
      relatedIssueId: input.parentId,
      type: "blocks",
    });
  }

  async function seedActiveCheckoutParent(input: { issueId: string; ownerRunId: string }) {
    await db.insert(heartbeatRuns).values({
      id: input.ownerRunId,
      companyId,
      agentId,
      status: "running",
      contextSnapshot: { issueId: input.issueId, wakeReason: "issue_commented" },
    });
    await db.insert(issues).values({
      id: input.issueId,
      companyId,
      title: "Active checkout parent",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: input.ownerRunId,
      executionRunId: input.ownerRunId,
    });
  }

  async function withdrawConfirmation(input: { issueId: string }) {
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId: input.issueId,
      kind: "request_confirmation",
      status: "pending",
      requestedResolverPolicy: "human_only",
      effectiveResolverPolicy: "human_only",
      addresseeAgentId: agentId,
      payload: { version: 1, prompt: "Clear this duplicate?" },
    });
    const issue = await issueService(db).getById(input.issueId);
    if (!issue) throw new Error("blocker issue disappeared");
    await issueThreadInteractionService(db).withdrawInteraction(
      issue,
      interactionId,
      { reason: "Duplicate recovery path" },
      { agentId },
    );
  }

  it("makes a cancelled-only edge checkout-ready after its confirmation is withdrawn and records the recovery", async () => {
    const parentId = randomUUID();
    const blockerId = randomUUID();
    const queuedRunId = randomUUID();
    await seedQueuedCheckoutParent({ issueId: parentId, runId: queuedRunId });
    await seedBlocker({ issueId: blockerId, parentId });

    const service = issueService(db);
    const beforeReadiness = await service.getDependencyReadiness(parentId);
    expect(beforeReadiness).toMatchObject({
      unresolvedBlockerIssueIds: [blockerId],
      isDependencyReady: false,
    });
    await expect(service.checkout(parentId, agentId, ["blocked"], queuedRunId))
      .rejects.toMatchObject({ status: 422 });

    await withdrawConfirmation({ issueId: blockerId });
    await service.update(blockerId, {
      status: "cancelled",
      actorAgentId: agentId,
    });

    await expect(service.getDependencyReadiness(parentId)).resolves.toMatchObject({
      blockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [],
      isDependencyReady: true,
    });
    await expect(service.checkout(parentId, agentId, ["blocked"], queuedRunId))
      .resolves.toMatchObject({
        id: parentId,
        status: "in_progress",
        checkoutRunId: queuedRunId,
      });
    await expect(db.select().from(activityLog).where(eq(activityLog.entityId, blockerId)))
      .resolves.toContainEqual(expect.objectContaining({
        action: "issue.dependency_blocker_cancelled",
        entityType: "issue",
        entityId: blockerId,
        details: expect.objectContaining({
          dependentIssueId: parentId,
          withdrawnInteractionCount: 1,
        }),
      }));
  });

  it("keeps an open blocker dependency-blocked", async () => {
    const parentId = randomUUID();
    const openBlockerId = randomUUID();
    const queuedRunId = randomUUID();
    await seedQueuedCheckoutParent({ issueId: parentId, runId: queuedRunId });
    await seedBlocker({ issueId: openBlockerId, parentId, status: "todo" });

    const service = issueService(db);
    await expect(service.getDependencyReadiness(parentId)).resolves.toMatchObject({
      unresolvedBlockerIssueIds: [openBlockerId],
      isDependencyReady: false,
    });
    await expect(service.checkout(parentId, agentId, ["blocked"], queuedRunId))
      .rejects.toMatchObject({ status: 422 });
  });

  it("does not reconcile an active checkout when its confirmation is not withdrawn", async () => {
    const parentId = randomUUID();
    const cancelledBlockerId = randomUUID();
    const activeRunId = randomUUID();
    await seedActiveCheckoutParent({ issueId: parentId, ownerRunId: activeRunId });
    await seedBlocker({ issueId: cancelledBlockerId, parentId, status: "cancelled" });

    const service = issueService(db);
    await expect(service.getDependencyReadiness(parentId)).resolves.toMatchObject({
      unresolvedBlockerIssueIds: [cancelledBlockerId],
      isDependencyReady: false,
    });
    await expect(service.checkout(parentId, agentId, ["blocked"], randomUUID()))
      .rejects.toMatchObject({ status: 422 });
  });
});
