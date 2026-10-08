import { describe, expect, it, vi } from "vitest";
import {
  assignmentWakeupIdempotencyKey,
  queueIssueAssignmentWakeup,
} from "./issue-assignment-wakeup.js";

describe("assignment wakeup idempotency", () => {
  it("gives duplicate assignment wakes the same issue and status-version identity", async () => {
    const wakeup = vi.fn(
      async (_agentId: string, opts: { idempotencyKey?: string | null }) => ({
        id: "run",
        ...opts,
      }),
    );
    const heartbeat = { wakeup };
    const issue = {
      id: "issue-1",
      assigneeAgentId: "agent-1",
      status: "todo",
      statusVersion: 4,
    };

    await Promise.all([
      queueIssueAssignmentWakeup({
        heartbeat,
        issue,
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "issue.create",
      }),
      queueIssueAssignmentWakeup({
        heartbeat,
        issue,
        reason: "issue_assigned",
        mutation: "create",
        contextSource: "issue.create",
      }),
    ]);

    const key = assignmentWakeupIdempotencyKey({
      issueId: issue.id,
      reason: "issue_assigned",
      statusVersion: issue.statusVersion,
    });
    expect(key).toMatch(/^issue-assignment:issue-1:issue_assigned:v4$/);
    expect(wakeup).toHaveBeenCalledTimes(2);
    expect(wakeup.mock.calls[0]?.[1]?.idempotencyKey).toBe(key);
    expect(wakeup.mock.calls[1]?.[1]?.idempotencyKey).toBe(key);
  });
});
