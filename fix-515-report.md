STATUS: IN PROGRESS

# fix-515 report (build-515)

## Akili
Queried "paperclip heartbeat issue rewake throttle repeated comment progress stranded recovery test embedded postgres" (infra,global). Best hit d37ce481 (L2 0.919) is the same shared-embedded-PG lesson already in the RED report; nothing new pulled. Akili had nothing else relevant.

## Mechanism
No skill invoked; fix written directly per brief. HEAD at start 55ae6d5f (matches brief).

## Change (worktree /Users/niaopenclaw/Domains/paperclip/.worktrees/wt-515, branch feat/515-repeated-comment-progress)
- NEW server/src/services/comment-first-line-progress.ts: normalizeCommentFirstLine (first line of the trimmed body, whitespace runs collapsed, trimmed), commentRepeatsPreviousFirstLine (no predecessor = not a repeat), progressCommentIds (newest-first history; a comment is progress if its predecessor in the history differs or is absent), repeatedCommentCountsAsProgress() reading STRANDED_REPEATED_COMMENT_IS_PROGRESS === "1" per call, AGENT_ISSUE_COMMENT_HISTORY_LIMIT = 50 (row bound).
- server/src/services/heartbeat.ts (throttle block): progressRows now also selects action. Runs with any non-comment progress action count as before. Runs whose only progress action is issue.comment_added: kill switch on -> count; else one company+issue+author-scoped query of the agent's last 50 comments on the issue (createdAt desc, id desc); the run counts if any of its comments (createdByRunId = run) is progress; a run with no comment row found in that history counts (fail toward waking).
- server/src/services/recovery/service.ts: new hasRecentAssigneeCommentProgress used by hasRecentVisibleProgress. Kill switch on -> the old any-comment-in-window query, unchanged. Else same bounded 50-row history; true if any in-window comment is progress per the shared helper (predecessor may be older than the window). Attachment query unchanged.
- Untouched: ISSUE_PROGRESS_ACTIVITY_ACTIONS, thresholds, windows, cooldown ladder, STRANDED_RECENT_PROGRESS_EXEMPTION_MS, all test files. No schema/migration.

## Environment
Fresh shared embedded PG via scratchpad/hold-epg.mts (URL in scratchpad/epg-url-fix.txt, pid 46783 from its own log, stopped with SIGTERM at the end: log shows STOPPED). Responsible-user reset (pgreset-user.mts) before every recovery-file run.

## AC1: throttle-515 file (log scratchpad/fix515-a.log, run together with the pure file)
```
 ✓ ... 515-A throttles issue_continuation_needed when every recent run only repeated the same comment first line 1093ms
 ✓ ... 515-A-control does not throttle when each run's comment has a different first line 3574ms
 ✓ ... 515-C still counts a real status change in a repeated-comment run as progress 2713ms
 ✓ ... 515-C still counts a child issue created in a repeated-comment run as progress 3010ms
 ✓ ... 515-D kill switch STRANDED_REPEATED_COMMENT_IS_PROGRESS=1 restores comment-as-progress in the throttle 2831ms
 Test Files  2 passed (2)
      Tests  19 passed (19)
exit=0
```

## AC2: heartbeat-process-recovery.test.ts -t "GGU-809|515" (log scratchpad/fix515-b.log)
```
 ✓ ... exempts stranded-recovery escalation when assignee posted a recent comment (GGU-809) 20540ms
 ✓ ... still escalates stranded-recovery work when the recent comment is older than the exemption window (GGU-809) 18916ms
 ✓ ... 515-B escalates to blocked when the assignee's in-window comments all repeat one first line 2447ms
 ✓ ... 515-B-control still exempts and re-queues when the in-window comments have differing first lines 3555ms
 ✓ ... 515-B-attachment still exempts when identical comments come with an attachment in the window 1554ms
 ✓ ... 515-D kill switch STRANDED_REPEATED_COMMENT_IS_PROGRESS=1 restores the comment exemption in the stranded sweep 3631ms
 Test Files  1 passed (1)
      Tests  6 passed | 292 skipped (298)
exit=0
```
292 skipped = the -t filter. The log also prints "Cannot retain policy for an inactive execution" HttpError noise (8 occurrences); the RED-wave log after-515b.log has 6 of the same, so it predates this fix.

## AC3: pure + original throttle files
- issue-rewake-throttle.test.ts (pure): 14/14 inside AC1's 19 passed (fix515-a.log).
- heartbeat-issue-rewake-throttle.test.ts (original, own embedded PG, no shared URL needed this time; log scratchpad/fix515-orig1.log):
```
 Test Files  1 passed (1)
      Tests  8 passed (8)
exit=0
```
Did not hit the 20 s hook timeout on this run, so no second run was needed.

## AC4: mutation control (log scratchpad/fix515-mut.log, fix515-mutA.log, fix515-mutB.log)
Mutation: in commentRepeatsPreviousFirstLine, `return normalizeCommentFirstLine(body) === normalizeCommentFirstLine(previousBody);` -> `return false; // MUTATION: always differs` (one line; drives both guards).
```
sha256 before:  e788d243c3ad789872cd3b7793416e20ba2e2bb091190459d38cdf3b5c0c4324
515-A: × ... AssertionError: expected 'issue_continuation_needed' to be 'issue_rewake_throttled' at heartbeat-issue-rewake-throttle-515.test.ts:346:30  Tests 1 failed | 4 skipped (5) exit=1
515-B: × ... AssertionError: expected 1 to be +0 at heartbeat-process-recovery.test.ts:15110:45  Tests 1 failed | 297 skipped (298) exit=1
sha256 after restore: e788d243c3ad789872cd3b7793416e20ba2e2bb091190459d38cdf3b5c0c4324
git diff after restore: []
```
Both go RED with the exact pre-fix assertion, restored byte-identical.

## AC5: kill switch
515-D (throttle) passed in AC1 and 515-D (sweep) passed in AC2, after the fix. The switch is read per call (repeatedCommentCountsAsProgress), not at import.

## AC6: typecheck
`pnpm --filter @paperclipai/server typecheck` (server package.json:44: prepare:runner-vendor, plugin-sdk ensure-build-deps, tsc --noEmit). Raw tail (scratchpad/fix515-typecheck.log):
```
    Finished `release` profile [optimized] target(s) in 17m 42s
Replay golden snapshots and parity summaries are current.
> @paperclipai/plugin-sdk@1.0.0 ensure-build-deps ...
[paperclip] Building @paperclipai/shared...
[paperclip] Building @paperclipai/plugin-sdk...
exit=0
```
Because that run overlapped the mutation window, I re-ran `pnpm exec tsc --noEmit` in server/ on the restored bytes: `exit=0`, no output (scratchpad/fix515-tsc2.log).

## AC7: git
```
$ git log --oneline 2b2af9e6..HEAD
2ee4cf4c fix(515): stranded sweep exemption ignores repeated identical comments
f3378086 fix(515): repeated identical comment no longer resets the rewake throttle
1c9d5443 feat(515): shared first-line helper for repeated-comment progress
55ae6d5f test(515): RED cases for repeated identical comment in the stranded sweep exemption
3a55f3ff test(515): RED cases for repeated identical comment in the rewake throttle
$ git show --stat HEAD~2..HEAD
2ee4cf4c  server/src/services/recovery/service.ts | 60 (54+, 6-)
f3378086  server/src/services/heartbeat.ts        | 72 (66+, 6-)
1c9d5443  server/src/services/comment-first-line-progress.ts (new, 69 lines, wc -l)
$ git status --porcelain
?? .build-provisioned
?? BUILD-STATE.md
?? after-515a.log
?? after-515b.log
?? baseline3a-515.log
?? baseline3b-515.log
build-state.json, package-lock.json, redtests-515-report.md (all ??, pre-existing, not mine, not committed)
```
Dash scan (U+2014/U+2013) over commit messages and the 55ae6d5f..HEAD diff: 0 and 0 (control string: 1). Not pushed, no PR, no ssh.

## Unverified / judgment calls
- Full heartbeat-process-recovery.test.ts suite not run (RED report finding 4: base-suite hang on this host); only GGU-809 + 515 subset proven.
- Design choice: the 50-row history bound means an agent with more than 50 newer comments on the issue than a sampled run's comment has that run counted as progress (fail toward waking). Same bound in the sweep: an in-window comment whose predecessor falls outside the 50 rows counts as progress.
- Design choice: deleted comments (deletedAt) are not filtered, matching the existing GGU-809 query which also does not filter them.
- No new unit test for the pure helper was added (brief forbade editing tests; a new test file was not requested).

## Proposed memory (orchestrator decides)
None new beyond d37ce481 (shared embedded PG); one candidate: when timing a mutation control against a long `pnpm typecheck` running in parallel, re-run plain `tsc --noEmit` after restore, because the wrapper spends ~18 min on a Rust vendor build first and its tsc may read mutated bytes. (namespace infra, type lesson)

STATUS: COMPLETE
