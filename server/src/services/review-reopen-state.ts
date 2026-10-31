// Review state after a reopen (agentos#1612, agentos#1613).
//
// A reopen of a closed card whose review completed must start a fresh review on the
// next in_review handoff. The comment reopen (agentos#1567 R4, routes/issues.ts) writes
// a fresh idle state that keeps only the return assignee (who did the work) and the
// monitor history. This module gives the checkout reopen (#1612) and the PATCH reopen
// (#1613) the same shape, and lets the board close such a card in one request again
// (#1613 case 2), as it did before agentos#1567.
//
// It lives outside services/issue-execution-policy.ts on purpose: AgentOS re-patches
// that module's built file at every server start and refuses any md5 it does not know.
import type { IssueExecutionState } from "@paperclipai/shared";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

function idleState(
  returnAssignee: IssueExecutionState["returnAssignee"],
  monitor: IssueExecutionState["monitor"],
): IssueExecutionState {
  return {
    status: "idle",
    currentStageId: null,
    currentStageIndex: null,
    currentStageType: null,
    currentParticipant: null,
    returnAssignee: returnAssignee ?? null,
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    monitor: monitor ?? null,
  };
}

function isClosedStatus(status: string | null | undefined) {
  return status === "done" || status === "cancelled";
}

/**
 * agentos#1612: the execution state to store when a closed card with a completed
 * review is checked out again. Returns undefined when nothing must change (the card
 * was not closed, or its state is not completed: a cancelled changes_requested card
 * keeps its stage and round count, agentos#1567 X7r).
 */
export function executionStateAfterCheckoutReopen(input: {
  previousStatus: string;
  executionState: unknown;
}): IssueExecutionState | null | undefined {
  if (!isClosedStatus(input.previousStatus)) return undefined;
  const parsed = parseIssueExecutionState(input.executionState ?? null);
  if (parsed?.status !== "completed") return undefined;
  if (!parsed.returnAssignee && !parsed.monitor) return null;
  return idleState(parsed.returnAssignee, parsed.monitor);
}

/**
 * agentos#1613 case 1: the PATCH reopen of a closed card clears its execution state
 * in the transition, which drops the return assignee. The next handoff then treats
 * the current assignee (the reviewer who approved the card) as the worker and skips
 * that reviewer. Given the transition's state patch, returns the patch with the
 * completed state's return assignee carried forward, or the patch unchanged.
 */
export function executionStatePatchAfterPatchReopen(input: {
  previousStatus: string;
  previousExecutionState: unknown;
  requestedStatus: string | undefined;
  hasPolicy: boolean;
  patchExecutionState: unknown;
}): unknown {
  if (!input.hasPolicy || !isClosedStatus(input.previousStatus)) return input.patchExecutionState;
  if (!input.requestedStatus || isClosedStatus(input.requestedStatus)) return input.patchExecutionState;
  const previous = parseIssueExecutionState(input.previousExecutionState ?? null);
  if (previous?.status !== "completed" || !previous.returnAssignee) return input.patchExecutionState;
  if (input.patchExecutionState === null) {
    return idleState(previous.returnAssignee, null);
  }
  const next = parseIssueExecutionState(input.patchExecutionState);
  if (next && next.status === "idle" && !next.currentStageId && !next.returnAssignee) {
    return { ...(input.patchExecutionState as Record<string, unknown>), returnAssignee: previous.returnAssignee };
  }
  return input.patchExecutionState;
}

/**
 * agentos#1613 case 2: a card reopened after an approved review carries an idle state
 * with a return assignee and no stage progress. Only the reopen paths write that shape.
 */
export function isReopenedReviewState(executionState: unknown): boolean {
  const parsed = parseIssueExecutionState(executionState ?? null);
  return Boolean(
    parsed &&
      parsed.status === "idle" &&
      !parsed.currentStageId &&
      parsed.returnAssignee &&
      (parsed.completedStageIds ?? []).length === 0,
  );
}

/**
 * agentos#1613 case 2: the issue the PATCH transition sees when the board closes a
 * reopened card. The transition treats done on a completed workflow as terminal, so
 * the board done closes the card in one request, as before agentos#1567, instead of
 * starting a fresh review. Only the transition input changes; the stored state is
 * written only if the monitor transition writes one, as before agentos#1567.
 */
export function issueForBoardCloseOfReopenedCard<T extends { executionState?: unknown }>(issue: T): T {
  const parsed = parseIssueExecutionState(issue.executionState ?? null);
  if (!parsed) return issue;
  return { ...issue, executionState: { ...parsed, status: "completed" } };
}
