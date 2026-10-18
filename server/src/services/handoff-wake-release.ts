// Kill switch for releasing the new owner's wake after a self-reassign handoff.
// An agent that hands its card to another agent from inside its own run has
// that run cancelled as issue_reassigned. The release path treats that stop as
// a handoff (not an operator stop) and promotes the new owner's parked wake
// once the old run's process and lease are gone.
//
// PAPERCLIP_HANDOFF_WAKE_RELEASE is read on every call. Default on. Set it to
// "0" (or "false", "off", "no") and restart the service to restore the earlier
// behavior, where the parked wake waits for a later run by the new owner.
// See doc/handoff-wake-release.md.

export const HANDOFF_WAKE_RELEASE_ENV = "PAPERCLIP_HANDOFF_WAKE_RELEASE";

const OFF_VALUES = new Set(["0", "false", "off", "no"]);

export function handoffWakeReleaseEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[HANDOFF_WAKE_RELEASE_ENV]?.trim().toLowerCase();
  return !value || !OFF_VALUES.has(value);
}

/**
 * A run its own agent stopped by handing the card to a different agent. The
 * card must have a different agent assignee and no user assignee; a stop on
 * a card that came back to the same agent, or went to a person, stays an
 * operator stop. Native runs keep their own reassignment receipt protocol.
 */
export function isLegacyHandoffStop(
  run: { status: string; errorCode: string | null; runtimeMode: string | null; agentId: string },
  issue: { assigneeAgentId: string | null; assigneeUserId: string | null } | null,
): boolean {
  return handoffWakeReleaseEnabled() &&
    run.runtimeMode !== "native" &&
    run.status === "cancelled" &&
    run.errorCode === "issue_reassigned" &&
    issue !== null &&
    !issue.assigneeUserId &&
    issue.assigneeAgentId !== null &&
    issue.assigneeAgentId !== run.agentId;
}
