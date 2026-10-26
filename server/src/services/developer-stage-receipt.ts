export function developerCompletionReceiptError(
  requestedStatus: unknown,
  commentBody: unknown,
): string | null {
  if (requestedStatus !== "done" || typeof commentBody !== "string") return null;
  let receipt: unknown;
  try {
    receipt = JSON.parse(commentBody);
  } catch {
    return null;
  }
  if (
    !receipt ||
    typeof receipt !== "object" ||
    (receipt as Record<string, unknown>).schema !== "agentos.build-candidate-receipt/v2"
  ) {
    return null;
  }
  const record = receipt as Record<string, unknown>;
  if (record.built !== true) {
    return "A built:false Developer receipt cannot complete the Developer stage; leave the attempt blocked and route its typed blocker";
  }
  if (typeof record.commit_sha !== "string" || !/^[0-9a-f]{40}$/i.test(record.commit_sha)) {
    return "A completed Developer stage requires a built:true receipt with an exact 40-character commit_sha";
  }
  if (
    typeof record.pr_url !== "string" ||
    !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*$/.test(record.pr_url)
  ) {
    return "A completed Developer stage requires a built:true receipt with a GitHub pull-request URL";
  }
  return null;
}
