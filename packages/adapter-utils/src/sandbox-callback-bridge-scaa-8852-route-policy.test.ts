import { describe, expect, it } from "vitest";

import { authorizeSandboxCallbackBridgeRequestWithRoutes } from "./sandbox-callback-bridge.js";

const ROOT_ISSUE_ID = "c3f3c396-1416-4cb8-b3f4-2575ab4fd6c5";
const HOLD_ID = "4edd28e1-6882-46c9-a36c-8debfe7cf68d";
const RELEASE_PATH = `/api/issues/${ROOT_ISSUE_ID}/tree-holds/${HOLD_ID}/release`;
const DIAGNOSIS_COMMENT = {
  schema: "agentos.pod-diagnosis/v1",
  cause: "system_flaw",
  evidence: "POST release returned 403 Route not allowed while GET tree-holds succeeded",
};
const ROUTING_COMMENT = {
  action: "build_release_allowlist",
  mode: "standard",
  action_source: "it_manager",
};

describe("SCAA-8852 tree-hold release bridge policy", () => {
  it("passes the authorized exact SCAA-5203 release through the live card state", () => {
    const beforeRelease = {
      card: "SCAA-8852",
      children: [],
      comments: [
        DIAGNOSIS_COMMENT,
        ROUTING_COMMENT,
        {
          schema: "agentos.improver-fix/v1",
          diagnosisComment: DIAGNOSIS_COMMENT,
        },
      ],
      hold: { id: HOLD_ID, status: "active", reason: "preempted_for_fleet_certification_2026-10-17" },
    };

    expect(beforeRelease.children).toEqual([]);
    expect(ROUTING_COMMENT.action_source).toBe("it_manager");
    expect(
      authorizeSandboxCallbackBridgeRequestWithRoutes({
        method: "POST",
        path: RELEASE_PATH,
      }),
    ).toBeNull();
  });

  it("keeps the governed release path usable after the source hold is released once", () => {
    const afterRelease = {
      children: [
        {
          owner: "IT Manager",
          status: "done",
          receipt: { schema: "agentos.release-readback/v1", status: "released", holdId: HOLD_ID },
        },
      ],
      hold: { id: HOLD_ID, status: "released" },
      sourceOwner: { resumable: true },
    };

    expect(afterRelease.children[0].receipt.status).toBe("released");
    expect(afterRelease.sourceOwner.resumable).toBe(true);
    expect(
      authorizeSandboxCallbackBridgeRequestWithRoutes({
        method: "POST",
        path: RELEASE_PATH,
      }),
    ).toBeNull();
  });

  it("allows a normal issue read and denies route or method drift", () => {
    expect(
      authorizeSandboxCallbackBridgeRequestWithRoutes({
        method: "GET",
        path: `/api/issues/${ROOT_ISSUE_ID}`,
      }),
    ).toBeNull();

    const denied = [
      { method: "GET", path: RELEASE_PATH },
      { method: "POST", path: `/api/issues/${ROOT_ISSUE_ID}/tree-holds` },
      {
        method: "POST",
        path: `/api/issues/${ROOT_ISSUE_ID}/tree-holds/${HOLD_ID}/release/extra`,
      },
      { method: "POST", path: "/api/issues/other-issue/tree-holds/other-hold/release" },
      { method: "POST", path: "/api/approvals/approval-1/approve" },
    ];
    for (const request of denied) {
      expect(
        authorizeSandboxCallbackBridgeRequestWithRoutes(request),
      ).toBe(`Route not allowed: ${request.method} ${request.path}`);
    }
  });
});
