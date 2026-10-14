# Handoff wake release

## What it fixes

An agent can hand its card to another agent from inside its own run (a PATCH
that changes the assignee, usually with a comment). The PATCH cancels the
caller's own run with `errorCode = issue_reassigned` and enqueues the new
owner's assignment wake in the same request. At that moment the old run's
process and environment lease are still alive, so the ownership blocker
(`getConversationOwnershipBlocker`, cause `execution_owner_active`) parks the
new owner's wake as `deferred_issue_execution` with
`executionWait.recoveryActionId = null`.

Before this change nothing released that wake:

- the release drain treated the acknowledged `issue_reassigned` cancel as an
  operator stop (`decidePreDrain` returned `released`), and
- the stranded-queue sweep in `resumeQueuedRuns` looked only for the new
  owner's own run on the card, found none, and skipped the wake.

The wake then fired only after some other wake gave the new owner a run on the
card (for example the pod watchdog's `dead_run` wake), which made it a second
run: a double wake.

## What it does now

- F-b: a cancelled legacy run with `errorCode = issue_reassigned`, on a card
  now assigned to a different agent and to no user, sets the pre-drain fact
  `handoffStop`. `decidePreDrain` does not release it untouched; the drain
  continues. (`server/src/modules/wake-queue/adapters/postgres.ts`,
  `server/src/modules/wake-queue/domain/policy.ts`)
- F-a: when the stranded-queue sweep finds a deferred wake whose agent has no
  run on the card, it uses the wake's `payload.interruptedRunId` if that run is
  another agent's cancelled `issue_reassigned` legacy run on the same card, and
  calls `releaseIssueExecutionAndPromote(run, { suppressImmediateRecovery: true })`.
  (`server/src/services/heartbeat.ts`, `findHandoffSourceRun`)
- The ownership-blocker check is unchanged and still runs before any
  promotion. Nothing is promoted while the old process is alive or its
  environment lease is open. An operator stop (`errorCode = cancelled`) and an
  `issue_reassigned` stop on a card that is still, or again, assigned to the
  same agent stay operator stops.

Result: the parked wake promotes on the first scheduler tick after the old
run's lease releases, and the new owner runs once. If the card is already
`cancelled` or `done` by then, the same release reaches the drain's
terminal-task branch instead, which cancels the wake (`status = cancelled`,
`error = "Deferred execution wake no longer applies to a terminal task"`), so
it is neither promoted nor left parked.

## Kill switch

`PAPERCLIP_HANDOFF_WAKE_RELEASE`

- Default: on (unset or any value other than the off values).
- Off values: `0`, `false`, `off`, `no` (case and surrounding spaces ignored).
- Off restores the earlier behavior exactly: no `handoffStop` fact and no
  handoff-run lookup in the sweep, so the wake stays parked as before.
- It is read on every call (`server/src/services/handoff-wake-release.ts`), so
  it needs no deploy. To halt: set `PAPERCLIP_HANDOFF_WAKE_RELEASE=0` in the
  service environment (for a systemd unit, `systemctl edit <unit>` or the env
  file the unit reads) and restart the service. A restart takes well under 60
  seconds.

## Review note: self-authored comment ids

When the sweep releases the handoff run, the finishing run is the reassigning
run, which also wrote the handoff comment. The drain's liveness check treats
comments written by the finishing run as self-authored, so the handoff comment
id can be normalized out of the promoted wake's queued ids. That behavior is
left as it is on purpose. The wake still promotes because `issue_assigned`
preserves independent continuation, and the comment stays on the thread. In
the integration test (T2) the promoted run's context still carried the handoff
comment (`contextSnapshot.commentId` and `paperclipWake.comments`).

## Tests

- `server/src/modules/wake-queue/domain/policy.test.ts` (T1)
- `server/src/__tests__/heartbeat-handoff-wake-release.test.ts` (T2 to T5 and
  the kill switch, T6 for cancelled and done cards)
