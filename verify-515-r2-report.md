STATUS: IN PROGRESS

# verify-515-r2 report

## Akili
Queried "paperclip heartbeat rewake throttle repeated comment progress stranded sweep verification" (infra,global). Best L2 0.857 (HEARTBEAT_SCHEDULER_ENABLED lesson), all off-topic for this verification. Nothing pulled. Akili had nothing relevant.

## Under test
Worktree /Users/niaopenclaw/Domains/paperclip/.worktrees/wt-515, HEAD b291784cc8112ba54c4d42148bbb5194906929ac (git rev-parse HEAD), base 2b2af9e6. `git log --oneline 2b2af9e6..HEAD` = 10 commits as listed in the brief. `git status --porcelain` before and after: the same 11 pre-existing untracked files, no tracked change.
Disk before start: 2.5 GiB then 2.7 GiB avail (df -h), above the 1.5 GiB gate; 4.2 GiB at end.

## Leg 1: focused suites (my run; script scratchpad/v515r2-run.sh, one shared embedded PG pid 38873, log scratchpad/v515r2-hold-epg.log ends "STOPPED", `ps -p 38873` printed nothing: gone)
(a) heartbeat-issue-rewake-throttle-515.test.ts + issue-rewake-throttle.test.ts (scratchpad/v515r2-leg1a.log):
```
 Test Files  2 passed (2)
      Tests  23 passed (23)
exit=0
```
515 cases, all PASS: 515-A; 515-A-control; 515-C status change; 515-C child created; 515-D (throttle kill switch); 515-r2 throttle-activity-after-finish; 515-r2 throttle-genuine-new-input (control); 515-r2 throttle-missing-comment-row (control); 515-r2 throttle-json. Plus all 14 pure cases.
(b) original heartbeat-issue-rewake-throttle.test.ts alone (scratchpad/v515r2-leg1b.log): `Tests  8 passed (8)`, exit=0 (no hook timeout this time, load avg ~6).
(c) pgreset ("deleted user rows 0") then heartbeat-process-recovery.test.ts -t "GGU-809|515" (scratchpad/v515r2-leg1c.log):
```
 Test Files  1 passed (1)
      Tests  9 passed | 292 skipped (301)
exit=0
```
PASS: both GGU-809 cases; 515-B; 515-B-control; 515-B-attachment; 515-D (sweep); 515-r2 sweep-bound; 515-r2 sweep-json-differs; 515-r2 sweep-json-identical (control). 292 skipped = the -t filter.

## Leg 2: independent mutations (different from the fix agent's a to d and the round-1 MUT1 to MUT3)
Restore by cp from scratchpad/v515r2-*.bak after each; sha256 before (scratchpad/v515r2-sha-before.txt): heartbeat.ts 6b88cde1..., comment-first-line-progress.ts 68ad698a..., service.ts 0f89e201...; after every restore and at exit: "restore sha OK", `git diff | wc -l` = 0 (scratchpad/v515r2-run.log). Each mutation's grep marker count confirmed it applied.
- M1, heartbeat.ts:27901: iterate the full 51-row history instead of judgedCommentHistory (a run whose comment sits only in the predecessor row becomes "found, not new" instead of fail-open). Result scratchpad/v515r2-m1.log: `Tests  9 passed (9)`, exit=0. NO case goes red. Finding P2-A below.
- M2, heartbeat.ts:27936: new-input exclusion `isNull(runId)` -> `isNotNull(runId)` (NULL-run input dropped, sampled runs' own activity counted again). Result scratchpad/v515r2-m2.log: 515-r2 throttle-activity-after-finish RED (`expected 'issue_continuation_needed' to be 'issue_rewake_throttled'` at heartbeat-issue-rewake-throttle-515.test.ts:530:32); `Tests  1 failed | 8 passed (9)`, exit=1. Caught. Note: throttle-genuine-new-input stayed green under M2 because its fixture also carries the agent's own after-finish activity, so under M2 it passes for the wrong reason; the NULL branch alone is covered by the fix agent's mutation (c). P2-B.
- M3, comment-first-line-progress.ts:48-51: normalisation removed (no trim, no whitespace collapse). Throttle (scratchpad/v515r2-m3a.log): 515-A RED (`expected 'issue_continuation_needed' to be 'issue_rewake_throttled'` at :346:30), exit=1. Sweep (scratchpad/v515r2-m3b.log): 515-B RED (`expected 1 to be +0` at heartbeat-process-recovery.test.ts:15110:45), `Tests  1 failed | 8 passed | 292 skipped (301)`, exit=1. Caught.
- M4, comment-first-line-progress.ts:43-45: kill switch read once at import (module constant) instead of per call. Throttle (scratchpad/v515r2-m4a.log): 515-D RED (`expected null not to be null` at :440:24), exit=1. Sweep (scratchpad/v515r2-m4b.log): 515-D RED (at heartbeat-process-recovery.test.ts:15177:32), exit=1. Per-call read is proven.

## Leg 3: code review at HEAD b291784c
OK:
- Company scoping: throttle history heartbeat.ts:27886-27890 (companyId, issueId, authorAgentId); new-input query :27924-27926; sweep history service.ts:1973-1977; kill-switch path :1954-1958.
- Bounded rows: `.limit(AGENT_ISSUE_COMMENT_HISTORY_FETCH_LIMIT)` heartbeat.ts:27896 and service.ts:1980; constants comment-first-line-progress.ts:34 (50) and :40 (51). Only the newest 50 are judged (judgedCommentHistory :88, used in progressCommentIds :98 and in heartbeat.ts:27901). Round-1 P0-1 closed (replay below).
- Kill switch per call: comment-first-line-progress.ts:44 reads process.env inside the function; called at heartbeat.ts:27873 and service.ts:1949. M4 proves the tests depend on it.
- Fail toward waking: run whose comment row is not in the judged slice counts (heartbeat.ts:27909-27913); predecessor genuinely absent counts as new (:98-106 of helper). Covered by 515-r2 throttle-missing-comment-row (fix agent's r2-mut proved it red when disabled).
- New-input fix (round-1 P0-2): heartbeat.ts:27935-27938 `or(isNull(runId), notInArray(runId, sampleRunIds))`; sampleRunIds is non-empty there (inside `recentTerminalRuns.length > 0`, :27836). NULL-safe.
- No change to thresholds, windows, ladder, ISSUE_PROGRESS_ACTIVITY_ACTIONS, ISSUE_NEW_INPUT_ACTIVITY_ACTIONS: `git diff --stat 2b2af9e6..HEAD -- packages server/src/services/issue-rewake-throttle.ts` empty; STRANDED_RECENT_PROGRESS_EXEMPTION_MS lines not in the service.ts diff (count 0). No schema or migration: changed files are exactly 2 tests, the new helper, heartbeat.ts, service.ts.
- Renamed helper commentRepeatsPreviousFirstLine: 0 references left (grep over server/src and packages); the helper module is imported only by heartbeat.ts and service.ts.

Findings (no P0, no P1):
- P2-A: the "comment only in the predecessor row stays fail-open" branch (heartbeat.ts:27901 iterating judgedCommentHistory) is untested; M1 stays green. Real-world reach is small (needs a sampled run's comment to be the 51st newest agent comment, i.e. 50 newer comments inside 8 runs), and a regression there fails closed only for that one older run.
- P2-B: throttle-genuine-new-input is not an isolated control for the NULL-run_id branch (its fixture also has the agent's own after-finish activity); M2 passes it. Mutation (c) of the fix agent covers the branch, so coverage exists in combination.
- P2-C: the kill switch does not cover the new-input exclusion (heartbeat.ts:27935-27938 is unconditional). With STRANDED_REPEATED_COMMENT_IS_PROGRESS=1 a sampled run's own after-finish activity still is not "new input", unlike base. For comment and other progress actions this is moot (the run then counts as progress anyway), so the difference is limited to the four NEW_INPUT-only actions (thread_interaction_accepted/answered/item_verdicts_submitted, blockers_resolved_wake_emitted) when attributed to a sampled run and written after its finish. Live frequency NOT MEASURED (production read was denied, see Leg 4). Spec says the switch "restores old behaviour"; strictly it restores the comment rule only.
- P2-D (carried from round 1 P2-2): deleted comments (deleted_at) are not filtered in either history query.
- P2-E (spec-level, informational): the rule compares with the immediate predecessor only, so an agent alternating two status lines, or posting JSON receipts whose body changes every time (timestamps, ids), is always "progress". Round-1 live aggregate (scratchpad/v515-json2.out): 3764 consecutive "{" pairs in 7 days, all bodies differ, so JSON-speaking loops are never caught by this rule. That is the intended fail-toward-waking trade-off for round-1 P1-1, which is closed.

## Leg 4: real-data replay
PRODUCTION READ DENIED THIS ROUND. The scp of three SELECT/EXPLAIN-only SQL files to scaleup-svr /tmp succeeded; the ssh psql run was refused by the session permission classifier ("[Production Reads]"). I did not work around it. I removed my three files from the host (`ls /tmp/v515r2-*` on host: "No such file or directory"). Files: scratchpad/v515r2-replay.sql, v515r2-json-find.sql, v515r2-explain.sql (ready to run if the orchestrator gets the read approved).

Fallback used, labelled: replay over the production rows round 1 already captured read-only (scratchpad/v515-2117.json, v515-3911.json at 15:28 ET, and v515-win.out for rows 49 to 53). Round-1 capture lacks run_id on the after-last-run activity rows, so I recovered it by exact (action, created_at to the microsecond) match against the per-run activity; both cases matched one row each. Row 51 for 2117 comes from v515-win.out (12:46:23.456996Z, identical first line). Script scratchpad/v515r2-replay/replay.mts imports progressCommentIds, judgedCommentHistory, AGENT_ISSUE_COMMENT_HISTORY_FETCH_LIMIT, evaluateIssueRewakeThrottle and the action lists from wt-515, and re-implements heartbeat.ts:27859-27945 (classification, judged-slice found set, round-2 new-input rule) and service.ts:1965-1986 (51-row sweep). Output scratchpad/v515r2-replay.out, exit=0.

### 4a. SCAA-2117 as of 2026-10-12T13:12:59Z
- 51 rows fetched, 50 judged, progressCommentIds = 0.
- Sampled runs counting as progress: 0 of 8 (all succeeded, comment-only).
- After-last-run activity: 1 row, issue.comment_added at 13:12:38.068945Z, run 11644c9b (a sampled run). Round-2 new-input rule: 0 rows; round-1 rule would have had 1.
- Throttle: blocked=true, noProgressStreak=8, cooldownMs=1800000, nextAllowedAt 13:42:37.892Z. (With the round-1 new-input rule on the same rows: not blocked, which is the P0-2 that is now closed.)
- Sweep: 51 in-window fetched, exempted=false, so the sweep escalates to blocked. Negative control in the same run: same rows without row 51 (the round-1 50-row shape) gives exempted=true, so the replay can tell the two apart.
- Expected (brief): throttle blocked AND sweep not exempted. Observed: matches.

### Control SCAA-3911 as of 2026-10-12T13:10:30Z
3 rows, 3 runs, all 3 count as progress (differing first lines; run 970e46d2 also issue.updated). Throttle: not blocked, streak 0. Sweep: exempted. Matches expectation (not throttled).

### JSON replay (live card, last 24 h): NOT DONE
Needs a fresh production read (the finder query is scratchpad/v515r2-json-find.sql). Not reachable from here this round. Supporting, not equivalent: unit cases 515-r2 throttle-json and sweep-json-differs pass, and the round-1 live aggregate shows every consecutive "{" pair in 7 days has a differing body, which under commentProgressKey (whole body, whitespace collapsed) makes the newer one progress unless the bodies differ only in whitespace (not measured).

### 4b. EXPLAIN of the LIMIT 51 history query: NOT RUN this round (same denial)
Round 1 (scratchpad/v515-explain.out, LIMIT 50) showed Index Scan Backward on issue_comments_company_issue_created_at_idx (company_id, issue_id, created_at) with author_agent_id as a filter; LIMIT 51 should take the same plan, but that is an inference, not a measurement.

## Leg 5: verdict per AC
- AC1 (repeated first line is not progress, throttle and sweep): PASS at unit level (515-A, 515-B, 515-r2 activity-after-finish and sweep-bound green; M3 bites both). PASS on the production-shaped replay of SCAA-2117 from round-1 captured rows (throttle blocked, sweep not exempted), with the stated caveat that the rows are round-1 captures, not a fresh read.
- AC2 (other progress still counts): PASS (515-C x2, 515-B-attachment, 515-B-control, 515-r2 json-differs and throttle-json green; SCAA-3911 control not throttled).
- AC4 (kill switch, per call): PASS for the comment rule (515-D both suites green; M4 turns both red). Caveat P2-C: the new-input exclusion is not behind the switch.
- AC3: live, not mine.
Overall: round-1 P0-1, P0-2 and P1-1 are closed on the evidence available. No P0/P1 found. Ship-readiness is gated only on the unrun live legs (fresh 4a pull, JSON live replay, 4b EXPLAIN), which need the production read approved.

## Unverified
- Fresh production pull for 4a, the JSON live-card replay, and the 4b EXPLAIN (permission denied; see Leg 4).
- Live frequency of P2-C.
- Full heartbeat-process-recovery.test.ts suite (only the GGU-809|515 subset; known base hang).
- No typecheck run by me (fix report claims tsc exit 0).
- Live STRANDED_RECENT_PROGRESS_EXEMPTION_MS override not read; replay uses the 30 min default.

## Proposed memory (orchestrator decides)
- When a verifier's production read is denied, replay over an earlier verifier's captured rows only after recovering any missing join keys by exact-match and adding a control that flips on the changed rule, because otherwise a stale capture can silently pass the new rule (agentos#515 r2: run_id recovered by (action, created_at) match; row-51 removal flipped the sweep). namespace infra, type lesson.

STATUS: COMPLETE
