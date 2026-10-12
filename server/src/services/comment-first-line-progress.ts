/**
 * agentos#515: a comment counts as issue progress only when it says something
 * new. An agent that posts the same status line every run ("waiting on X")
 * must not defeat the no-progress rewake throttle or the stranded-recovery
 * escalation exemption.
 *
 * The rule, shared by both places: a comment is progress only if its first
 * line, whitespace-normalised, differs from the first line of the same
 * agent's previous comment on the same issue. A comment with no previous
 * comment from that agent is new by definition.
 *
 * Kill switch: STRANDED_REPEATED_COMMENT_IS_PROGRESS="1" restores the old
 * behaviour (every comment counts). It is read per call so it can be flipped
 * without a restart of the module.
 */

export const REPEATED_COMMENT_IS_PROGRESS_ENV = "STRANDED_REPEATED_COMMENT_IS_PROGRESS";

/**
 * Upper bound on how many of one agent's comments on one issue are read to
 * find each comment's predecessor. Anything not resolvable within this bound
 * is treated as progress (fail toward waking, never toward silence).
 */
export const AGENT_ISSUE_COMMENT_HISTORY_LIMIT = 50;

/** True when the kill switch says every comment counts as progress again. */
export function repeatedCommentCountsAsProgress(): boolean {
  return process.env[REPEATED_COMMENT_IS_PROGRESS_ENV] === "1";
}

/** First line of the body, trimmed, with whitespace runs collapsed to one space. */
export function normalizeCommentFirstLine(body: string | null | undefined): string {
  const firstLine = (body ?? "").trim().split(/\r?\n/, 1)[0] ?? "";
  return firstLine.replace(/\s+/g, " ").trim();
}

/**
 * Whether `body` repeats the first line of `previousBody`. A missing previous
 * comment means the comment is new, so this returns false.
 */
export function commentRepeatsPreviousFirstLine(
  body: string | null | undefined,
  previousBody: string | null | undefined,
): boolean {
  if (previousBody === null || previousBody === undefined) return false;
  return normalizeCommentFirstLine(body) === normalizeCommentFirstLine(previousBody);
}

export interface AgentIssueCommentRow {
  id: string;
  body: string;
}

/**
 * Given one agent's comments on one issue ordered newest first (the history),
 * return the ids of comments that are progress: their first line differs from
 * the next older comment in the history, or that older comment is not in the
 * history (unknown predecessor counts as progress).
 */
export function progressCommentIds(historyNewestFirst: AgentIssueCommentRow[]): Set<string> {
  const ids = new Set<string>();
  historyNewestFirst.forEach((comment, index) => {
    const previous = historyNewestFirst[index + 1];
    if (!previous || !commentRepeatsPreviousFirstLine(comment.body, previous.body)) {
      ids.add(comment.id);
    }
  });
  return ids;
}
