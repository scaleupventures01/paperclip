/**
 * agentos#515: a comment counts as issue progress only when it says something
 * new. An agent that posts the same status line every run ("waiting on X")
 * must not defeat the no-progress rewake throttle or the stranded-recovery
 * escalation exemption.
 *
 * The rule, shared by both places: a comment is progress only if its
 * comparison key differs from the key of the same agent's previous comment on
 * the same issue. The key is (see commentProgressKey):
 *   - plain text: the first line, whitespace-normalised;
 *   - structured body (trimmed body starts with "{" or "["): the whole body
 *     with whitespace runs collapsed, because a JSON receipt's first line is
 *     just a brace and says nothing about its content.
 * A comment with no previous comment from that agent is new by definition.
 *
 * Bounded history: callers read AGENT_ISSUE_COMMENT_HISTORY_FETCH_LIMIT rows
 * (one more than the judged count) and only the newest
 * AGENT_ISSUE_COMMENT_HISTORY_LIMIT are judged, so the oldest judged row is
 * compared against its real predecessor instead of counting as new because
 * the bound cut its predecessor off.
 *
 * Kill switch: STRANDED_REPEATED_COMMENT_IS_PROGRESS="1" restores the old
 * behaviour (every comment counts). It is read per call so it can be flipped
 * without a restart of the module.
 */

export const REPEATED_COMMENT_IS_PROGRESS_ENV = "STRANDED_REPEATED_COMMENT_IS_PROGRESS";

/**
 * How many of one agent's newest comments on one issue are judged. A judged
 * comment whose predecessor is genuinely absent (the agent's first comment on
 * the issue) counts as progress (fail toward waking, never toward silence).
 */
export const AGENT_ISSUE_COMMENT_HISTORY_LIMIT = 50;

/**
 * How many rows callers fetch: the judged rows plus one extra row that only
 * serves as the predecessor of the oldest judged row and is never judged.
 */
export const AGENT_ISSUE_COMMENT_HISTORY_FETCH_LIMIT = AGENT_ISSUE_COMMENT_HISTORY_LIMIT + 1;

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
 * The key two comments are compared on. A structured body (trimmed body starts
 * with "{" or "[") is compared on its whole body with whitespace runs
 * collapsed; any other body on its normalised first line.
 */
export function commentProgressKey(body: string | null | undefined): string {
  const trimmed = (body ?? "").trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return trimmed.replace(/\s+/g, " ");
  }
  return normalizeCommentFirstLine(body);
}

/**
 * Whether `body` repeats `previousBody` under commentProgressKey. A missing
 * previous comment means the comment is new, so this returns false.
 */
export function commentRepeatsPrevious(
  body: string | null | undefined,
  previousBody: string | null | undefined,
): boolean {
  if (previousBody === null || previousBody === undefined) return false;
  return commentProgressKey(body) === commentProgressKey(previousBody);
}

export interface AgentIssueCommentRow {
  id: string;
  body: string;
}

/**
 * The rows of a fetched history that are judged: the newest
 * AGENT_ISSUE_COMMENT_HISTORY_LIMIT. The extra fetched row, if any, is only a
 * predecessor.
 */
export function judgedCommentHistory<T>(historyNewestFirst: T[]): T[] {
  return historyNewestFirst.slice(0, AGENT_ISSUE_COMMENT_HISTORY_LIMIT);
}

/**
 * Given one agent's comments on one issue ordered newest first, as fetched
 * with AGENT_ISSUE_COMMENT_HISTORY_FETCH_LIMIT, return the ids of judged
 * comments that are progress: their key differs from the next older comment,
 * or there is no older comment (the agent's first comment on the issue).
 */
export function progressCommentIds(historyNewestFirst: AgentIssueCommentRow[]): Set<string> {
  const ids = new Set<string>();
  judgedCommentHistory(historyNewestFirst).forEach((comment, index) => {
    const previous = historyNewestFirst[index + 1];
    if (!previous || !commentRepeatsPrevious(comment.body, previous.body)) {
      ids.add(comment.id);
    }
  });
  return ids;
}
