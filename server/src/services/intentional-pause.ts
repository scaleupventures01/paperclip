// Calvin 2026-10-14: "pausing an agent freezes its cards exactly as they are.
// Releasing the agent puts each card back where it was, and the system stops
// 'recovering' cards of agents paused on purpose."
//
// A pause someone chose (manual, system, archive, import, a disabled built-in or
// plugin seat) freezes the agent's cards. A budget pause is automatic and keeps
// the board escalation. A paused row with no reason predates pause reasons and
// keeps the old escalation too. Shared by the stranded reconciler and the
// wake-queue release decision so both apply the same rule.
export function isIntentionallyPausedAgent(agent: {
  status: string;
  pauseReason: string | null;
}) {
  return (
    agent.status === "paused" &&
    agent.pauseReason !== null &&
    agent.pauseReason !== "budget"
  );
}
