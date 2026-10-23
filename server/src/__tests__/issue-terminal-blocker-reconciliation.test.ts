import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

describeEmbeddedPostgres("terminal blocker reconciliation", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null =
    null;

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("resolves done and cancelled blockers while refusing nonterminal ones", async () => {
    tempDb = await startEmbeddedPostgresTestDatabase(
      "paperclip-terminal-blockers-",
    );
    const db = createDb(tempDb.connectionString);
    const svc = issueService(db);
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "TRM",
      requireBoardApprovalForNewAgents: false,
    });

    const cancelledBlockerId = randomUUID();
    const doneBlockerId = randomUUID();
    const reconciledIssueId = randomUUID();
    const assigneeAgentId = randomUUID();
    await db.insert(agents).values({
      id: assigneeAgentId,
      companyId,
      name: "ReconciliationAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: cancelledBlockerId,
        companyId,
        identifier: "TRM-1",
        title: "Cancelled blocker",
        status: "cancelled",
        priority: "medium",
      },
      {
        id: doneBlockerId,
        companyId,
        identifier: "TRM-2",
        title: "Done blocker",
        status: "done",
        priority: "medium",
      },
      {
        id: reconciledIssueId,
        companyId,
        title: "Stale blocked follow-up",
        status: "blocked",
        priority: "high",
        assigneeAgentId,
      },
    ]);
    await svc.update(reconciledIssueId, {
      blockedByIssueIds: [cancelledBlockerId, doneBlockerId],
    });

    await expect(
      svc.getDependencyReadiness(reconciledIssueId),
    ).resolves.toMatchObject({
      blockerIssueIds: expect.arrayContaining([
        cancelledBlockerId,
        doneBlockerId,
      ]),
      unresolvedBlockerIssueIds: [cancelledBlockerId],
      unresolvedBlockerCount: 1,
      allBlockersDone: false,
      isDependencyReady: false,
    });
    await expect(
      svc.getFollowUpBlockerGate(reconciledIssueId),
    ).resolves.toEqual({ nonterminalBlockerIssueIds: [] });
    await expect(
      svc.update(reconciledIssueId, { status: "todo" }),
    ).resolves.toMatchObject({ id: reconciledIssueId, status: "todo" });
    await expect(
      svc.update(reconciledIssueId, { status: "in_progress" }),
    ).resolves.toMatchObject({
      id: reconciledIssueId,
      status: "in_progress",
    });
    await expect(
      svc.update(reconciledIssueId, { status: "cancelled" }),
    ).resolves.toMatchObject({
      id: reconciledIssueId,
      status: "cancelled",
    });

    const resumableIssueId = randomUUID();
    await db.insert(issues).values({
      id: resumableIssueId,
      companyId,
      title: "Resume past cancelled blocker",
      status: "blocked",
      priority: "high",
      assigneeAgentId,
    });
    await svc.update(resumableIssueId, {
      blockedByIssueIds: [cancelledBlockerId],
    });
    await expect(
      svc.update(resumableIssueId, { status: "in_progress" }),
    ).resolves.toMatchObject({
      id: resumableIssueId,
      status: "in_progress",
    });

    const replacementBlockerId = randomUUID();
    const replacedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: replacementBlockerId,
        companyId,
        identifier: "TRM-3",
        title: "Replacement done blocker",
        status: "done",
        priority: "medium",
      },
      {
        id: replacedIssueId,
        companyId,
        title: "Replace stale blocker",
        status: "blocked",
        priority: "high",
      },
    ]);
    await svc.update(replacedIssueId, {
      blockedByIssueIds: [cancelledBlockerId],
    });
    await expect(
      svc.update(replacedIssueId, {
        status: "todo",
        blockedByIssueIds: [replacementBlockerId],
      }),
    ).resolves.toMatchObject({
      blockedByIssueIds: [replacementBlockerId],
      status: "todo",
    });
    await expect(
      svc.getDependencyReadiness(replacedIssueId),
    ).resolves.toMatchObject({
      blockerIssueIds: [replacementBlockerId],
      unresolvedBlockerIssueIds: [],
      isDependencyReady: true,
    });

    const activeBlockerId = randomUUID();
    const refusedIssueId = randomUUID();
    await db.insert(issues).values([
      {
        id: activeBlockerId,
        companyId,
        identifier: "TRM-4",
        title: "Active blocker",
        status: "todo",
        priority: "medium",
      },
      {
        id: refusedIssueId,
        companyId,
        title: "Nonterminal blocker refusal",
        status: "blocked",
        priority: "high",
        assigneeAgentId,
      },
    ]);
    await svc.update(refusedIssueId, {
      blockedByIssueIds: [activeBlockerId],
    });
    await expect(
      svc.getDependencyReadiness(refusedIssueId),
    ).resolves.toMatchObject({
      blockerIssueIds: [activeBlockerId],
      unresolvedBlockerIssueIds: [activeBlockerId],
      unresolvedBlockerCount: 1,
      isDependencyReady: false,
    });
    await expect(
      svc.update(refusedIssueId, { status: "in_progress" }),
    ).rejects.toMatchObject({
      status: 422,
      details: { unresolvedBlockerIssueIds: [activeBlockerId] },
    });
  });
});
