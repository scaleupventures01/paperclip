import { describe, expect, it } from "vitest";

import {
  authorizeSandboxCallbackBridgeRequestWithRoutes,
} from "./sandbox-callback-bridge.js";

describe("sandbox callback bridge issue comment route policy", () => {
  it("allows an authorized agent comment deletion to reach server policy", () => {
    expect(
      authorizeSandboxCallbackBridgeRequestWithRoutes({
        method: "DELETE",
        path: "/api/issues/11111111-1111-4111-8111-111111111111/comments/22222222-2222-4222-8222-222222222222",
      }),
    ).toBeNull();
  });

  it("keeps destructive routes outside the issue-comment scope denied", () => {
    const issueId = "11111111-1111-4111-8111-111111111111";
    const commentId = "22222222-2222-4222-8222-222222222222";

    expect(
      authorizeSandboxCallbackBridgeRequestWithRoutes({
        method: "DELETE",
        path: `/api/issues/${issueId}`,
      }),
    ).toBe(`Route not allowed: DELETE /api/issues/${issueId}`);
    expect(
      authorizeSandboxCallbackBridgeRequestWithRoutes({
        method: "PUT",
        path: `/api/issues/${issueId}/comments/${commentId}`,
      }),
    ).toBe(`Route not allowed: PUT /api/issues/${issueId}/comments/${commentId}`);
  });
});
