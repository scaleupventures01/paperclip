// Maker-checker for every review transition (agentos#1612).
//
// Every route that runs the execution-policy transition calls it through
// applyMakerCheckedTransition, so one rule holds on all of them: the agent that
// made the work for a review round is never that round's reviewer and never
// closes it without another party's review. Call sites (agentos#1612): the issue
// PATCH, the recovery action resolve route, the comment auto-approve and the
// execution workspace quarantine restore.
//
// The maker of a round is the acting agent when an agent submits; when a board
// user or the system submits, it is the agent the card is assigned to.
//
// With PAPERCLIP_AGENT_SELF_CLOSE_GUARD off the transition runs unchanged.
//
// It lives outside services/issue-execution-policy.ts on purpose: AgentOS re-patches
// that module's built file at every server start and refuses any md5 it does not know.
import type { IssueExecutionStagePrincipal } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { agentSelfCloseGuardEnabled, SELF_CLOSE_REFUSED_CODE } from "./agent-self-close-guard.js";
import { applyIssueExecutionPolicyTransition, parseIssueExecutionState } from "./issue-execution-policy.js";
import { isAgentSelfOnlyAutoSkipClose, issueForAgentHandoff } from "./review-reopen-state.js";

type TransitionInput = Parameters<typeof applyIssueExecutionPolicyTransition>[0];
type TransitionResult = ReturnType<typeof applyIssueExecutionPolicyTransition>;

export type MakerCheckerContext = {
  companyId: string;
  /** "agent" for an agent actor; anything else is a board user or the system. */
  actorType: string;
  actorAgentId: string | null | undefined;
  env?: NodeJS.ProcessEnv;
};

type Principal = Pick<IssueExecutionStagePrincipal, "type" | "agentId" | "userId"> | null | undefined;

function samePrincipal(a: Principal, b: Principal): boolean {
  if (!a || !b || a.type !== b.type) return false;
  return a.type === "agent" ? Boolean(a.agentId) && a.agentId === b.agentId : Boolean(a.userId) && a.userId === b.userId;
}

function makerAgentId(
  issue: { assigneeAgentId?: string | null; assigneeUserId?: string | null },
  ctx: MakerCheckerContext,
): string | null {
  if (ctx.actorType === "agent") return ctx.actorAgentId ?? null;
  if (issue.assigneeAgentId && !issue.assigneeUserId) return issue.assigneeAgentId;
  return null;
}

function refuse(message: string, reason: string): never {
  throw unprocessable(`self_close_refused: ${message}`, { code: SELF_CLOSE_REFUSED_CODE, reason });
}

/**
 * agentos#1612: the only entry to applyIssueExecutionPolicyTransition outside the policy
 * module. Throws HttpError 422 code self_close_refused when the transition would let the
 * round's maker review or close its own work.
 */
export function applyMakerCheckedTransition(input: TransitionInput, ctx: MakerCheckerContext): TransitionResult {
  if (!agentSelfCloseGuardEnabled(ctx.companyId, ctx.env)) {
    return applyIssueExecutionPolicyTransition(input);
  }
  const maker = makerAgentId(input.issue, ctx);
  const issue = maker
    ? issueForAgentHandoff(input.issue, {
        actorAgentId: maker,
        requestedStatus: input.requestedStatus,
        hasPolicy: input.policy != null,
      })
    : input.issue;
  const result = applyIssueExecutionPolicyTransition({ ...input, issue });

  const previous = parseIssueExecutionState(input.issue.executionState ?? null);
  const actor: Principal = ctx.actorType === "agent" && ctx.actorAgentId
    ? { type: "agent", agentId: ctx.actorAgentId, userId: null }
    : input.actor.userId
      ? { type: "user", agentId: null, userId: input.actor.userId }
      : null;

  // (1) An approval by the round's maker.
  if (result.decision?.outcome === "approved" && previous && samePrincipal(actor, previous.returnAssignee)) {
    refuse("you made the work under review, so another reviewer must approve it.", "maker_approval");
  }

  // (2) A review stage handed to the round's maker.
  const next = result.patch.executionState === undefined
    ? undefined
    : parseIssueExecutionState(result.patch.executionState ?? null);
  if (next?.status === "pending" && next.currentParticipant) {
    const makerPrincipal: Principal = maker ? { type: "agent", agentId: maker, userId: null } : null;
    const touchesMaker =
      samePrincipal(next.currentParticipant, next.returnAssignee) ||
      (previous?.status !== "pending" && samePrincipal(next.currentParticipant, makerPrincipal));
    if (touchesMaker) {
      refuse("the review stage would go to the agent that made the work; another reviewer must review it.", "maker_is_reviewer");
    }
  }

  // (3) An agent close where every open review stage had only the maker as reviewer.
  if (
    ctx.actorType === "agent" &&
    input.requestedStatus === "done" &&
    isAgentSelfOnlyAutoSkipClose({
      previousExecutionState: input.issue.executionState,
      patchExecutionState: result.patch.executionState,
      hadDecision: Boolean(result.decision),
    })
  ) {
    refuse(
      "you submitted this work and are the only reviewer configured for its review stage; another reviewer or a board user must review it.",
      "no_other_reviewer",
    );
  }
  return result;
}
