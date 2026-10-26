import { describe, expect, it } from "vitest";
import { developerCompletionReceiptError } from "./developer-stage-receipt.js";

describe("Developer stage receipt policy", () => {
  it("rejects built:false completion", () => {
    expect(
      developerCompletionReceiptError(
        "done",
        JSON.stringify({
          schema: "agentos.build-candidate-receipt/v2",
          built: false,
          blocked_by: "tests",
        }),
      ),
    ).toContain("cannot complete");
  });

  it("rejects built:true without commit and pull-request evidence", () => {
    const schema = "agentos.build-candidate-receipt/v2";
    expect(developerCompletionReceiptError("done", JSON.stringify({ schema, built: true }))).toContain(
      "commit_sha",
    );
    expect(
      developerCompletionReceiptError(
        "done",
        JSON.stringify({ schema, built: true, commit_sha: "a".repeat(40) }),
      ),
    ).toContain("pull-request URL");
  });

  it("accepts built:true with exact commit and pull-request evidence", () => {
    expect(
      developerCompletionReceiptError(
        "done",
        JSON.stringify({
          schema: "agentos.build-candidate-receipt/v2",
          built: true,
          commit_sha: "a".repeat(40),
          pr_url: "https://github.com/scaleupventures01/sourcedox-phase0/pull/487",
        }),
      ),
    ).toBeNull();
  });

  it("does not interfere with blocked attempts or unrelated receipts", () => {
    expect(
      developerCompletionReceiptError(
        "blocked",
        JSON.stringify({ schema: "agentos.build-candidate-receipt/v2", built: false }),
      ),
    ).toBeNull();
    expect(
      developerCompletionReceiptError(
        "done",
        JSON.stringify({ schema: "agentos.qa-receipt/v2", verdict: "PASS" }),
      ),
    ).toBeNull();
  });
});
