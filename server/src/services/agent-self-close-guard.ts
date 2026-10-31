// Agent self-close guard (agentos#1508 AC4, agentos#1567).
//
// A card whose execution policy carries a review stage is accepted only by that
// stage. Two agent writes used to get around it:
//
//   1. An agent that is not the review stage's current participant (the builder,
//      for example) PATCHes status done. The execution-policy transition then
//      silently turned the done into in_review for the reviewer (no stage running
//      yet, or changes_requested), or refused it with a generic message (stage
//      pending). The builder never got a clear refusal it could post as a receipt.
//   2. An agent PATCHes executionPolicy null (or a policy without that review
//      stage, or with its reviewers removed) and status done in one request, and
//      the card closes with no review at all.
//
// Both are now refused with HTTP 422 before any state changes:
//   - code `self_close_refused` for (1)
//   - code `review_policy_change_refused` for (2)
// Board (user) actors are never checked here and keep the existing behavior.
//
// agentos#1567 residuals, also refused with `review_policy_change_refused`:
//   - On a done card (an approved review is complete) an agent may still not
//     null the policy or drop or replace any of its review stages, alone or
//     together with a reopen to todo (verify72r2 R1 and R3b). Every review stage
//     of the stored policy counts as one the agent may not remove; completed
//     stage ids are ignored for this check. The self-close check (1) is skipped
//     on a done card, and re-sending the identical policy is still accepted.
//     The same rule applies to any card whose execution state is completed, so a
//     done card PATCHed to cancelled is guarded too (verify-1567 X8, X8c, X1r).
//   - While a review stage is open (state pending or changes_requested on that
//     stage), an agent's new policy must keep a review stage with the same stage
//     id and the same reviewers (verify72r2 R9). A re-post with new stage ids
//     would otherwise clear the review state and its round count.
//
// This lives outside services/issue-execution-policy.ts on purpose: AgentOS
// re-patches that module's built file at every server start (review escalation
// patch v2), and that patch refuses any file whose md5 it does not know. Keeping
// this file separate leaves the patched module byte-identical.
//
// PAPERCLIP_AGENT_SELF_CLOSE_GUARD is read on every call. Default on. Set it to
// "0" (or "false", "off", "no") and restart the service to restore the earlier
// behavior. PAPERCLIP_AGENT_SELF_CLOSE_GUARD_COMPANIES, when set to a comma
// separated list of company ids, limits the guard to those companies; unset or
// empty means every company.
import type {
  IssueExecutionPolicy,
  IssueExecutionStage,
  IssueExecutionStagePrincipal,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

export const AGENT_SELF_CLOSE_GUARD_ENV = "PAPERCLIP_AGENT_SELF_CLOSE_GUARD";
export const AGENT_SELF_CLOSE_GUARD_COMPANIES_ENV = "PAPERCLIP_AGENT_SELF_CLOSE_GUARD_COMPANIES";
export const SELF_CLOSE_REFUSED_CODE = "self_close_refused";
export const REVIEW_POLICY_CHANGE_REFUSED_CODE = "review_policy_change_refused";

const OFF_VALUES = new Set(["0", "false", "off", "no"]);

export function agentSelfCloseGuardEnabled(
  companyId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const value = env[AGENT_SELF_CLOSE_GUARD_ENV]?.trim().toLowerCase();
  if (value && OFF_VALUES.has(value)) return false;
  const scope = (env[AGENT_SELF_CLOSE_GUARD_COMPANIES_ENV] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return scope.length === 0 || scope.includes(companyId);
}

type GuardIssue = {
  companyId: string;
  status: string;
  executionState?: unknown;
};

type GuardInput = {
  issue: GuardIssue;
  actorType: string;
  actorAgentId: string | null | undefined;
  requestedStatus: string | undefined;
  executionPolicyProvided: boolean;
  previousPolicy: IssueExecutionPolicy | null;
  nextPolicy: IssueExecutionPolicy | null;
  env?: NodeJS.ProcessEnv;
};

function principalKey(principal: Pick<IssueExecutionStagePrincipal, "type" | "agentId" | "userId"> | null | undefined) {
  if (!principal) return null;
  if (principal.type === "agent") return principal.agentId ? `agent:${principal.agentId}` : null;
  return principal.userId ? `user:${principal.userId}` : null;
}

function participantKeys(stage: IssueExecutionStage): Set<string> {
  return new Set(stage.participants.map(principalKey).filter((key): key is string => Boolean(key)));
}

function openReviewStages(policy: IssueExecutionPolicy | null, completedStageIds: Set<string>) {
  if (!policy) return [];
  return policy.stages.filter((stage) => stage.type === "review" && !completedStageIds.has(stage.id));
}

function describeStage(policy: IssueExecutionPolicy, stage: IssueExecutionStage) {
  const index = policy.stages.findIndex((candidate) => candidate.id === stage.id);
  return {
    stageId: stage.id,
    stageIndex: index,
    stageType: stage.type,
    participants: stage.participants.map((participant) =>
      participant.type === "agent"
        ? { type: "agent", agentId: participant.agentId ?? null }
        : { type: "user", userId: participant.userId ?? null },
    ),
  };
}

function stageLabel(policy: IssueExecutionPolicy, stage: IssueExecutionStage) {
  const index = policy.stages.findIndex((candidate) => candidate.id === stage.id);
  const who = stage.participants
    .map((participant) => (participant.type === "agent" ? `agent ${participant.agentId}` : `user ${participant.userId}`))
    .join(", ");
  return `review stage ${index + 1} of ${policy.stages.length} (${stage.id}; reviewers: ${who})`;
}

/**
 * Refuses an agent's self-close and an agent's removal of an open review stage.
 * Throws HttpError 422; returns normally when the write may proceed.
 */
export function assertAgentMayCloseOrChangeReview(input: GuardInput): void {
  if (input.actorType !== "agent" || !input.actorAgentId) return;
  if (!agentSelfCloseGuardEnabled(input.issue.companyId, input.env)) return;
  // A cancelled card is still checked: cancel, then drop the review stage, then done
  // was a three-request self-close (fix round 1, verifier probes P13 and P6).
  const isDone = input.issue.status === "done";

  const actorKey = `agent:${input.actorAgentId}`;
  const state = parseIssueExecutionState(input.issue.executionState ?? null);
  const completedStageIds = new Set(state?.completedStageIds ?? []);

  // (2) agentos#1567: an agent may not drop an open review stage or remove its reviewers.
  // On a done card every review stage is guarded, completed or not (R1, R3b).
  if (input.executionPolicyProvided && input.previousPolicy) {
    const nextReviewStages = (input.nextPolicy?.stages ?? []).filter((stage) => stage.type === "review");
    const keepsReviewers = (candidate: IssueExecutionStage, required: Set<string>) => {
      const keys = participantKeys(candidate);
      for (const key of required) if (!keys.has(key)) return false;
      // Adding yourself as a reviewer of your own card is a removal in effect.
      if (!required.has(actorKey) && keys.has(actorKey)) return false;
      return true;
    };
    // A completed workflow is guarded the same way whatever the card status: a done card
    // PATCHed to cancelled keeps its approved state (fix round 1, verify-1567 X8, X8c, X1r).
    const approved = isDone || state?.status === "completed";
    const guardedCompleted = approved ? new Set<string>() : completedStageIds;
    for (const stage of openReviewStages(input.previousPolicy, guardedCompleted)) {
      const required = participantKeys(stage);
      const kept = nextReviewStages.some((candidate) => keepsReviewers(candidate, required));
      if (!kept) {
        throw unprocessable(
          approved
            ? `review_policy_change_refused: an agent cannot remove or replace the review stage of an approved card; ${stageLabel(input.previousPolicy, stage)} approved it. Reopen with a comment instead and hand the card back with status in_review.`
            : `review_policy_change_refused: an agent cannot remove or replace an open review stage; ${stageLabel(input.previousPolicy, stage)} must decide this card first.`,
          {
            code: REVIEW_POLICY_CHANGE_REFUSED_CODE,
            ...describeStage(input.previousPolicy, stage),
            nextPolicy: input.nextPolicy ? "replaced" : "null",
            ...(approved ? { issueStatus: input.issue.status, executionStateStatus: state?.status ?? null } : {}),
          },
        );
      }
    }

    // (2b) agentos#1567 R9: the open stage keeps its id, so its review state and round
    // count survive (a new stage id makes the transition clear the state).
    const openStageId =
      state && (state.status === "pending" || state.status === "changes_requested")
        ? state.currentStageId
        : null;
    const openStage = openStageId
      ? input.previousPolicy.stages.find((stage) => stage.id === openStageId && stage.type === "review") ?? null
      : null;
    if (openStage) {
      const required = participantKeys(openStage);
      const sameStage = nextReviewStages.find((candidate) => candidate.id === openStage.id) ?? null;
      if (!sameStage || !keepsReviewers(sameStage, required)) {
        throw unprocessable(
          `review_policy_change_refused: an agent cannot replace the review stage that is deciding this card; keep ${stageLabel(input.previousPolicy, openStage)} with the same stage id.`,
          {
            code: REVIEW_POLICY_CHANGE_REFUSED_CODE,
            ...describeStage(input.previousPolicy, openStage),
            executionStateStatus: state?.status ?? null,
            nextPolicy: input.nextPolicy ? "replaced" : "null",
          },
        );
      }
    }
  }

  // The self-close check does not apply to a card that is already done.
  if (isDone) return;

  // (1) agentos#1508 AC4: only the review stage's current participant may send done.
  if (input.requestedStatus !== "done") return;
  const policy = input.nextPolicy;
  if (!policy) return;
  const nextCompleted =
    input.executionPolicyProvided && input.nextPolicy !== input.previousPolicy
      ? new Set([...completedStageIds].filter((id) => policy.stages.some((stage) => stage.id === id)))
      : completedStageIds;
  const open = openReviewStages(policy, nextCompleted);
  if (open.length === 0) return;
  // A workflow that already completed is terminal for done (the transition treats it so).
  if (state?.status === "completed" && !input.executionPolicyProvided) return;

  for (const stage of open) {
    const keys = participantKeys(stage);
    const isCurrent =
      state?.status === "pending" &&
      state.currentStageId === stage.id &&
      principalKey(state.currentParticipant ?? null) === actorKey;
    if (isCurrent) return;
    // A stage whose only reviewer is the actor is the policy author's own choice;
    // the transition auto-skips it, as before.
    if (keys.size > 0 && [...keys].every((key) => key === actorKey)) continue;
    throw unprocessable(
      `self_close_refused: an agent cannot close a card while its review is open; ${stageLabel(policy, stage)} must approve it. Hand the card to the reviewer with status in_review instead.`,
      {
        code: SELF_CLOSE_REFUSED_CODE,
        ...describeStage(policy, stage),
        executionStateStatus: state?.status ?? null,
        currentParticipant: state?.currentParticipant ?? null,
      },
    );
  }
}
