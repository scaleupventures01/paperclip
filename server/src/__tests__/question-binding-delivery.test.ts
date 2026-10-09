import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AskUserQuestionsInteraction } from "@paperclipai/shared";
import { buildQuestionResponseDeliveryEnvelope } from "../services/question-response-delivery.js";

describe("question response delivery bindings", () => {
  it("preserves option bindings in the delivered question set", () => {
    const binding = {
      schema: "agentos.disk-gate-action/v1",
      action: "delete" as const,
      path: "/tmp/rebuildable-packages",
      size_gb: 2.54,
      fingerprint: createHash("sha256")
        .update(JSON.stringify({
          action: "delete",
          path: "/tmp/rebuildable-packages",
          schema: "agentos.disk-gate-action/v1",
          size_gb: 2.54,
        }))
        .digest("hex"),
    };
    const interaction = {
      id: "interaction",
      companyId: "company",
      issueId: "issue",
      sourceRunId: "run",
      status: "answered",
      payload: {
        version: 1,
        questions: [{
          id: "disk-action",
          prompt: "Delete rebuildable packages?",
          selectionMode: "single",
          required: true,
          options: [{ id: "delete-packages", label: "Delete packages", binding }],
        }],
      },
      result: {
        version: 1,
        answers: [{ questionId: "disk-action", optionIds: ["delete-packages"] }],
      },
    } as unknown as AskUserQuestionsInteraction;

    expect(buildQuestionResponseDeliveryEnvelope(interaction)).toEqual({
      schema: "paperclip.question_response_delivery.v1",
      interactionId: "interaction",
      sourceRunId: "run",
      questionSet: {
        schema: "paperclip.question_set.v1",
        questions: [{
          id: "disk-action",
          prompt: "Delete rebuildable packages?",
          required: true,
          answerMode: "single_select",
          options: [{ id: "delete-packages", label: "Delete packages", binding }],
        }],
      },
      response: {
        schema: "paperclip.question_response.v1",
        answers: {
          "disk-action": { selectedOptionIds: ["delete-packages"] },
        },
      },
    });
  });
});
