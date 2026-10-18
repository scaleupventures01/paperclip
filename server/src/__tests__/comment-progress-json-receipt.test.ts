import { describe, expect, it } from "vitest";
import {
  commentProgressKey,
  commentRepeatsPrevious,
  progressCommentIds,
} from "../services/comment-first-line-progress.ts";

// P5, live 2026-10-16 00:23Z to 01:46Z (SCAA-5267, Platform Release Manager):
// 26 continuation runs about every 2 min, each posting a release receipt with
// released:false. The receipts differ only in their prose fields, so the whole
// body key counted every one as new progress, which defeated both the stranded
// sweep's repeated-continuation escalation and the no-progress rewake
// throttle. Two consecutive receipts, verbatim from the live card:
const LIVE_RECEIPT_EARLIER = "{\"schema\":\"agentos.platform-release-receipt/v1\",\"card_id\":\"31aad0e2-1697-45ca-b084-508eab610435\",\"merged_commit\":\"322ae5e5dc476e799737d6059a671c75ce71c847\",\"prs\":[712],\"snapshot_receipt\":\"/var/backups/agentos/agentos-full-20261016T010624Z.tar.gz.receipt.json\",\"change_control\":\"agentos-snapshot change reused the existing full snapshot receipt created_at=2026-10-16T01:06:24Z at server time 2026-10-16T01:43:25Z; fresh change snapshot requirement failed. No checkout, install, or verification was run.\",\"restart\":{\"units\":[],\"quiet_window\":\"not applicable: restart_services is empty\",\"results\":{}},\"verify\":\"not run: fresh snapshot requirement failed before apply\",\"negative_control\":\"not run: fresh snapshot requirement failed before apply\",\"machine_release_receipt\":null,\"released\":false,\"reason\":\"Checked Akili: no record clears the live fresh-snapshot refusal; prior Akili decision b243a5f7792742a280db8ee77c7c10b5 concerns only a reversible checkout to an advertised commit. Deployment blocked before install because the required fresh change snapshot was not produced; agentos-snapshot change reused a stale full snapshot receipt. Unblock owner: IT Manager; next action: repair the root snapshot/change-control freshness path, then rerun this release from a newly produced change receipt. No checkout, install, or verification ran.\"}";
const LIVE_RECEIPT_LATER = "{\"schema\":\"agentos.platform-release-receipt/v1\",\"card_id\":\"31aad0e2-1697-45ca-b084-508eab610435\",\"merged_commit\":\"322ae5e5dc476e799737d6059a671c75ce71c847\",\"prs\":[712],\"snapshot_receipt\":\"/var/backups/agentos/agentos-full-20261016T010624Z.tar.gz.receipt.json\",\"change_control\":\"release-root refused: AgentOS changes must use agentos-change-control run with a pushed source commit and fresh backup receipt. Nothing was run.\",\"restart\":{\"units\":[],\"quiet_window\":\"not applicable: restart_services is empty\",\"results\":{}},\"verify\":\"not run: fresh change snapshot requirement failed before apply\",\"negative_control\":\"not run: fresh change snapshot requirement failed before apply\",\"machine_release_receipt\":null,\"released\":false,\"reason\":\"Deployment blocked before install because agentos-snapshot change returned the existing kind: full receipt created_at 2026-10-16T01:06:24Z; the governed root gate rejected it as not a fresh change receipt. No checkout, install, or verification ran.\"}";

describe("commentProgressKey: JSON receipts", () => {
  it("treats two receipts that differ only in long prose fields as a repeat", () => {
    expect(LIVE_RECEIPT_EARLIER).not.toBe(LIVE_RECEIPT_LATER);
    expect(commentRepeatsPrevious(LIVE_RECEIPT_LATER, LIVE_RECEIPT_EARLIER)).toBe(true);
  });

  it("ignores key order and whitespace in a JSON body", () => {
    expect(commentProgressKey('{"b": 1, "a": "x"}')).toBe(commentProgressKey('{\n  "a": "x",\n  "b": 1\n}'));
  });

  it("progressCommentIds marks only the first of a run of prose-only receipt changes as progress", () => {
    const ids = progressCommentIds([
      { id: "later", body: LIVE_RECEIPT_LATER },
      { id: "earlier", body: LIVE_RECEIPT_EARLIER },
    ]);
    expect([...ids]).toEqual(["earlier"]);
  });

  it("control: a changed identifier, number or boolean is still progress", () => {
    const base = JSON.parse(LIVE_RECEIPT_LATER) as Record<string, unknown>;
    for (const change of [
      { merged_commit: "0000000000000000000000000000000000000000" },
      { snapshot_receipt: "/var/backups/agentos/agentos-change-20261016T020000Z.tar.gz.receipt.json" },
      { prs: [712, 713] },
      { released: true },
    ]) {
      const next = JSON.stringify({ ...base, ...change });
      expect(commentRepeatsPrevious(next, LIVE_RECEIPT_LATER)).toBe(false);
    }
  });

  it("control: short prose values (under 40 characters) still count", () => {
    expect(
      commentRepeatsPrevious('{"decision": "route to QA"}', '{"decision": "request rebuild"}'),
    ).toBe(false);
  });

  it("control: malformed JSON falls back to whole-body comparison", () => {
    expect(commentRepeatsPrevious("{ not json, step 2 of 5", "{ not json, step 1 of 5")).toBe(false);
    expect(commentRepeatsPrevious("{ not json  ", "{ not json")).toBe(true);
  });

  it("control: plain text still compares on the first line", () => {
    expect(commentRepeatsPrevious("waiting on X\nmore", "waiting on X\nother")).toBe(true);
    expect(commentRepeatsPrevious("frame 02/08 generated", "frame 01/08 generated")).toBe(false);
  });
});
