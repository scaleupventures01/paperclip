import { describe, expect, it } from "vitest";
import { normalizeInteractionContinuationWakeContext } from "../services/heartbeat.js";

describe("pending interaction wake context", () => {
  it("preserves the server-issued interaction identity used by addressee authorization", () => {
    const context = {
      source: "issue.interaction.created",
      wakeReason: "interaction_pending",
      interactionId: "interaction-1",
      interactionKind: "request_confirmation",
    };

    normalizeInteractionContinuationWakeContext(context, { issueId: "issue-1" });

    expect(context).toMatchObject({
      interactionId: "interaction-1",
      interactionKind: "request_confirmation",
    });
  });

  it("removes forged pending-interaction identity from any other source", () => {
    const context: Record<string, unknown> = {
      source: "automation",
      wakeReason: "interaction_pending",
      interactionId: "interaction-1",
      interactionKind: "request_confirmation",
    };

    normalizeInteractionContinuationWakeContext(context, { issueId: "issue-1" });

    expect(context).not.toHaveProperty("interactionId");
    expect(context).not.toHaveProperty("interactionKind");
  });
});
