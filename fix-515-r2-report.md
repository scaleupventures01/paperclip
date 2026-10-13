STATUS: IN PROGRESS

# fix-515-r2 report

## Akili
Queried "paperclip issue rewake throttle comment first line progress heartbeat 515" (infra,global). Best L2 0.894, all off-topic (agent error status, adapter repair, PRD queue). Akili had nothing relevant; nothing pulled.

## Start
HEAD 05d193108da479d4cc599a1ab79d684dc47a51a1. df start: /dev/disk3s5 228Gi 194Gi 3.6Gi 99% (above 1.5 GiB gate).

## Commits
- e540b22c helper: AGENT_ISSUE_COMMENT_HISTORY_FETCH_LIMIT = LIMIT+1, judgedCommentHistory, progressCommentIds judges newest LIMIT only; commentProgressKey (JSON whole body), commentRepeatsPreviousFirstLine renamed commentRepeatsPrevious (no other importers, grep over server/ packages/).
- eac9b52a heartbeat.ts: fetch FETCH_LIMIT, iterate judged slice for runsWithFoundComment; new-input query adds or(isNull(runId), notInArray(runId, sampleRunIds)).
- b291784c recovery/service.ts: fetch FETCH_LIMIT; comment updated.
Shared PG: hold-epg-r2fix.log, pid 39163, port 53872.

## AC1: throttle-515 + pure (log r2fix-a2.log; first attempt r2fix-a.log)
First attempt (ran concurrently with tsc, load ~15): 22 passed, 1 failed = 515-C status change with `Error: Hook timed out in 30000ms.` at the afterEach hook (:84), not an assertion. Re-run alone, r2fix-a2.log:
- PASS 515-A, 515-A-control, 515-C status change, 515-C child created, 515-D (throttle)
- PASS 515-r2 throttle-activity-after-finish, throttle-genuine-new-input (control), throttle-missing-comment-row (control), throttle-json
- PASS all 14 pure issue-rewake-throttle cases
```
 Test Files  2 passed (2)
      Tests  23 passed (23)
exit=0
```
## AC2: recovery -t "GGU-809|515" (log r2fix-b.log, pgreset first: deleted 0, companies 0)
PASS: both GGU-809, 515-B, 515-B-control, 515-B-attachment, 515-D (sweep), 515-r2 sweep-bound, sweep-json-differs, sweep-json-identical (control).
```
 Test Files  1 passed (1)
      Tests  9 passed | 292 skipped (301)
exit=0
```
## AC3: original heartbeat-issue-rewake-throttle.test.ts (r2fix-orig1.log), first run
```
 Test Files  1 passed (1)
      Tests  8 passed (8)
exit=0
```
## AC4: mutation controls (log r2fix-mut.log, script r2fix-mut.sh, restore by cp + trap)
- (a) FETCH_LIMIT = LIMIT (no +1): sweep-bound RED, `expected 1 to be +0` at heartbeat-process-recovery.test.ts:15228:47. sha256 68ad698a... before = after, git diff 0 lines.
- (b) or(isNull, notInArray) -> undefined: throttle-activity-after-finish RED, `expected 'issue_continuation_needed' to be 'issue_rewake_throttled'` at :530:32. sha 6b88cde1... same, diff 0.
- (c) plain notInArray: throttle-genuine-new-input RED, `expected null not to be null` at :552:26. sha same, diff 0.
- (d) JSON branch disabled (`if (false && ...)`): sweep-json-differs RED `expected 1 to be +0` at :15245:34; throttle-json RED `expected null not to be null` at :590:26. sha same, diff 0.
## AC5: typecheck
`pnpm exec tsc --noEmit` in server/ (r2fix-tsc.log): no output, exit=0.
## AC6: git, disk, PG
```
$ git log --oneline 05d19310..HEAD
b291784c fix(515): stranded sweep fetches N+1 comment rows so the oldest judged row has its predecessor
eac9b52a fix(515): throttle fetches N+1 comment rows and ignores sampled runs' own activity
e540b22c fix(515): judge newest N of N+1 comment rows and compare JSON bodies whole
show --stat: service.ts 5+/4-; heartbeat.ts 13+/3-; comment-first-line-progress.ts 55+/17-
git status --porcelain: unchanged from start (11 pre-existing untracked files, none mine)
df start 3.6Gi avail; df end (16:09 ET) 2.5Gi avail, 99%
PG: hold-epg-r2fix.log ends "STOPPED"; ps -p 39163 empty; lsof port 53872 no listener.
dash scan (U+2014/U+2013 by codepoint) over commit messages + diff 05d19310..HEAD: 0 (control 1)
```
No test file edited; no push, no PR, no ssh.

## Design notes
- In the throttle, runsWithFoundComment iterates only the judged slice: a sampled run whose comment sits only in the extra predecessor row was not judged and keeps counting as progress (fail open, same as a missing row).
- Kill switch, thresholds, windows, ladder, ISSUE_PROGRESS_ACTIVITY_ACTIONS, ISSUE_NEW_INPUT_ACTIVITY_ACTIONS unchanged; agent-comment-wake actor filter kept; no schema change.

## Unverified
- Full heartbeat-process-recovery.test.ts not run (known base hang); only GGU-809|515.
- Not replayed against production SCAA-2117 data (verify-515 replay script not re-run).
- Deleted comments still not filtered (verify P2-2), out of scope.

## Proposed memory
None new beyond the r1/r2 proposals already in verify-515 and redtests-515-r2 reports.

STATUS: COMPLETE
