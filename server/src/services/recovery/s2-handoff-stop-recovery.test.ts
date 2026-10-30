// agentos#1508 S2: a run its own agent stopped by handing the card on (the
// reassignment route's confirmed stop) is not a failed automatic recovery.
// Direct test of didAutomaticRecoveryFail (services/recovery/service.ts).
import { afterEach, describe, expect, it } from "vitest";
import { didAutomaticRecoveryFail } from "./service.js";

type Reason = Parameters<typeof didAutomaticRecoveryFail>[1];
const REASONS: Reason[] = ["execution_review_participant_recovery", "issue_continuation_needed", "assignment_recovery"];

function run(overrides: Record<string, unknown>, retryReason: Reason) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    agentId: "00000000-0000-4000-8000-000000000002",
    status: "cancelled",
    error: null,
    errorCode: "issue_reassigned",
    contextSnapshot: { issueId: "00000000-0000-4000-8000-000000000003", retryReason },
    livenessState: null,
    startedAt: new Date("2026-10-30T10:00:00Z"),
    createdAt: new Date("2026-10-30T10:00:00Z"),
    resultJson: { executionCancellation: { state: "acknowledged" }, reassignmentStopConfirmed: true, conversationContinuation: "continue_conversation_v1" },
    ...overrides,
  } as Parameters<typeof didAutomaticRecoveryFail>[0];
}

describe("S2 didAutomaticRecoveryFail: a confirmed self-handoff stop is not a failed recovery", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OWNERSHIP_WAKE_PARK;
  });

  for (const reason of REASONS) {
    it(`${reason}: cancelled issue_reassigned with reassignmentStopConfirmed true -> false`, () => {
      expect(didAutomaticRecoveryFail(run({}, reason), reason)).toBe(false);
    });

    it(`${reason}: a genuine failure of the recovery run -> true`, () => {
      expect(didAutomaticRecoveryFail(run({ status: "failed", errorCode: "adapter_failed", resultJson: null }, reason), reason)).toBe(true);
    });

    it(`${reason}: cancelled issue_reassigned WITHOUT a confirmed stop -> true (predicate is narrow)`, () => {
      expect(didAutomaticRecoveryFail(run({ resultJson: { executionCancellation: { state: "acknowledged" } } }, reason), reason)).toBe(true);
    });

    it(`${reason}: an operator stop (cancelled, errorCode cancelled, even with the flag) -> true`, () => {
      expect(didAutomaticRecoveryFail(run({ errorCode: "cancelled" }, reason), reason)).toBe(true);
    });
  }

  it("a confirmed handoff stop of a run that was not a recovery run -> false (unchanged)", () => {
    expect(didAutomaticRecoveryFail(run({ contextSnapshot: { issueId: "x" } }, "issue_continuation_needed"), "issue_continuation_needed")).toBe(false);
  });

  it("kill switch PAPERCLIP_OWNERSHIP_WAKE_PARK=0 restores today's answer (true) for the confirmed handoff stop", () => {
    process.env.PAPERCLIP_OWNERSHIP_WAKE_PARK = "0";
    expect(didAutomaticRecoveryFail(run({}, "execution_review_participant_recovery"), "execution_review_participant_recovery")).toBe(true);
  });
});
