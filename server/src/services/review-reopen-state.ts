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

// agentos#1612 P0-B: the agent that reopens and does the work is the return assignee, so the
// next in_review handoff excludes that agent. Keeping the original builder let a reviewer that
// reopened its own approved card become the reviewer of its own handoff.
function workerOrPrevious(
  workerAgentId: string | null | undefined,
  previous: IssueExecutionState["returnAssignee"],
): IssueExecutionState["returnAssignee"] {
  return workerAgentId ? { type: "agent", agentId: workerAgentId, userId: null } : previous;
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
  workerAgentId?: string | null;
}): IssueExecutionState | null | undefined {
  if (!isClosedStatus(input.previousStatus)) return undefined;
  const parsed = parseIssueExecutionState(input.executionState ?? null);
  if (parsed?.status !== "completed") return undefined;
  if (!parsed.returnAssignee && !parsed.monitor) return null;
  return idleState(workerOrPrevious(input.workerAgentId, parsed.returnAssignee), parsed.monitor);
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
  workerAgentId?: string | null;
}): unknown {
  if (!input.hasPolicy || !isClosedStatus(input.previousStatus)) return input.patchExecutionState;
  if (!input.requestedStatus || isClosedStatus(input.requestedStatus)) return input.patchExecutionState;
  const previous = parseIssueExecutionState(input.previousExecutionState ?? null);
  if (previous?.status !== "completed" || !previous.returnAssignee) return input.patchExecutionState;
  const returnAssignee = workerOrPrevious(input.workerAgentId, previous.returnAssignee);
  if (input.patchExecutionState === null) {
    return idleState(returnAssignee, null);
  }
  const next = parseIssueExecutionState(input.patchExecutionState);
  if (next && next.status === "idle" && !next.currentStageId && !next.returnAssignee) {
    return { ...(input.patchExecutionState as Record<string, unknown>), returnAssignee };
  }
  return input.patchExecutionState;
}

/**
 * agentos#1612 POC (maker-checker): the issue the PATCH transition sees when an agent submits
 * work for review, that is an agent status in_review, or an agent done that starts the review.
 * The transition excludes the execution state's return assignee from the stage it opens, so the
 * submitting agent becomes the return assignee for this round, whoever reopened the card or was
 * assigned at reopen. A pending stage is left alone (that request is a review decision, not a
 * submission). Returns the issue unchanged when nothing must change.
 */
export function issueForAgentHandoff<
  T extends { executionState?: unknown; assigneeAgentId?: string | null; assigneeUserId?: string | null },
>(issue: T, input: { actorAgentId: string | null | undefined; requestedStatus: string | undefined; hasPolicy: boolean }): T {
  const agentId = input.actorAgentId;
  if (!agentId || !input.hasPolicy) return issue;
  if (input.requestedStatus !== "in_review" && input.requestedStatus !== "done") return issue;
  const parsed = parseIssueExecutionState(issue.executionState ?? null);
  if (parsed?.status === "pending") return issue;
  const submitter = { type: "agent" as const, agentId, userId: null };
  if (!parsed) {
    if (issue.assigneeAgentId === agentId && !issue.assigneeUserId) return issue;
    return { ...issue, executionState: idleState(submitter, null) };
  }
  if (parsed.returnAssignee?.type === "agent" && parsed.returnAssignee.agentId === agentId) return issue;
  return { ...issue, executionState: { ...parsed, returnAssignee: submitter } };
}

/**
 * agentos#1612 POC: an agent done that closed the card only because every open review stage
 * had the submitting agent as its only reviewer (the transition's self-only auto-skip). That is
 * a close with no other party's review.
 */
export function isAgentSelfOnlyAutoSkipClose(input: {
  previousExecutionState: unknown;
  patchExecutionState: unknown;
  hadDecision: boolean;
}): boolean {
  if (input.hadDecision) return false;
  const previous = parseIssueExecutionState(input.previousExecutionState ?? null);
  if (previous?.status === "completed") return false;
  const next = parseIssueExecutionState(input.patchExecutionState ?? null);
  return next?.status === "completed";
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
