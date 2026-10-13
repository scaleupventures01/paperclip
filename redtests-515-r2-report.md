STATUS: IN PROGRESS
# redtests-515-r2 report

## Akili
Queried "paperclip heartbeat rewake throttle recovery tests embedded postgres 515" (infra,global). Best L2 0.946, all off-topic. Akili had nothing relevant; nothing pulled.

## Start state
HEAD 2ee4cf4c (git log). df at start (TZ ET ~15:5x): /dev/disk3s5 228Gi 197Gi 616Mi 100% (under the 1.5 GiB gate).

## Tests written (commits)
- c6140353 server/src/__tests__/heartbeat-issue-rewake-throttle-515.test.ts: nested describe "515-r2" in the 515 describe: throttle-activity-after-finish, throttle-genuine-new-input (control), throttle-missing-comment-row (control), throttle-json.
- 05d19310 server/src/__tests__/heartbeat-process-recovery.test.ts: nested describe "515-r2" in the 515 describe: sweep-bound, sweep-json-differs, sweep-json-identical (control).

## Disk gate
Waited per brief: 15:45 571724 KiB, 15:47 536104, 15:49 791900, 15:51 776628, 15:53 747012, 15:55 711836, 15:57 696632, 15:59 3778488 KiB -> OK (df -k avail, ET). One shared embedded PG (scratchpad/hold-epg.mts, log scratchpad/hold-epg-r2.log, pid 53948, port 52348).

## AC1 + AC2: results at HEAD 2ee4cf4c source (tests at 05d19310)
(a) `cd server && PAPERCLIP_TEST_DATABASE_URL=... pnpm exec vitest run --reporter=verbose src/__tests__/heartbeat-issue-rewake-throttle-515.test.ts src/__tests__/issue-rewake-throttle.test.ts` (log scratchpad/r2-a.log)
- 515-A, 515-A-control, 515-C x2, 515-D: PASS (round 1 intact); pure file 14/14 PASS
- 515-r2 throttle-activity-after-finish: FAIL (RED as intended)
  AssertionError: expected 'issue_continuation_needed' to be 'issue_rewake_throttled' at heartbeat-issue-rewake-throttle-515.test.ts:530:32 (`expect(latest?.reason).toBe("issue_rewake_throttled");`)
- 515-r2 throttle-genuine-new-input (control): PASS
- 515-r2 throttle-missing-comment-row (control): PASS
- 515-r2 throttle-json: FAIL (observed RED: today's first-line rule sees "{" repeat, so throttled)
  AssertionError: expected null not to be null at :590:26 (`expect(wake).not.toBeNull();`)
```
 Test Files  1 failed | 1 passed (2)
      Tests  2 failed | 21 passed (23)
exit=1
```
(b) pgreset-user.mts ("deleted user rows 0", "companies left 0"), then `pnpm exec vitest run --reporter=verbose src/__tests__/heartbeat-process-recovery.test.ts -t "GGU-809|515"` (log scratchpad/r2-b.log)
- both GGU-809, 515-B, 515-B-control, 515-B-attachment, 515-D (sweep): PASS
- 515-r2 sweep-bound: FAIL (RED) AssertionError: expected 1 to be +0 at heartbeat-process-recovery.test.ts:15228:47 (`expect(result.recentProgressExempted).toBe(0);`)
- 515-r2 sweep-json-differs: FAIL (RED) AssertionError: expected 1 to be +0 at :15245:34 (`expect(result.escalated).toBe(0);`)
- 515-r2 sweep-json-identical (control): PASS
```
 Test Files  1 failed (1)
      Tests  2 failed | 7 passed | 292 skipped (301)
exit=1
```
292 skipped = the -t filter. All RED cases fail on the throttle/escalation assertion, not setup.

## AC3: fail-open mutation proof (log scratchpad/r2-mut.log)
heartbeat.ts:27907 `if (!runsWithFoundComment.has(runId)) {` -> `if (false && !runsWithFoundComment.has(runId)) {` (restore via trap + explicit cp).
```
sha256 before: 95b3f975db0ce237868d6b94de72fcc323f212102c37023f8e87ba7e283fd7f1
 × 515-r2 throttle-missing-comment-row (control) ...
AssertionError: expected null not to be null at heartbeat-issue-rewake-throttle-515.test.ts:571:26
      Tests  1 failed | 8 skipped (9)
exit=1
sha256 after:  95b3f975db0ce237868d6b94de72fcc323f212102c37023f8e87ba7e283fd7f1
git diff -- server/src/services/heartbeat.ts | wc -l : 0
```
Closes verify-515 P2-1 (MUT1 previously stayed green).

## AC4: git, disk, Postgres
```
$ git log --oneline 2ee4cf4c..HEAD
05d19310 test(515): round 2 RED cases for the stranded sweep (history bound, JSON bodies)
c6140353 test(515): round 2 RED cases for the rewake throttle (activity after finish, JSON bodies, fail-open control)
$ git status --porcelain   (identical to the start; all pre-existing, none mine)
?? .build-provisioned ?? BUILD-STATE.md ?? after-515a.log ?? after-515b.log ?? baseline3a-515.log ?? baseline3b-515.log ?? build-state.json ?? fix-515-report.md ?? package-lock.json ?? redtests-515-report.md ?? verify-515-report.md
df start: 616Mi avail (100%); df end 16:00 ET: /dev/disk3s5 228Gi 194Gi 3.6Gi 99%
PG: hold-epg-r2.log ends "STOPPED"; `ps -p 53948` empty ("pid 53948 gone"); `lsof -iTCP:52348 -sTCP:LISTEN` empty.
```
Dash scan (U+2014/U+2013 by codepoint): commit messages 0, diff 2ee4cf4c..HEAD 0 (control string 1). No push, no PR, no ssh. No non-test source edited (heartbeat.ts mutated only transiently, sha-identical after).

## Notes for the fix agent
- P0-2 fix trap: if the new-input query excludes the sampled runs with `run_id NOT IN (...)`, Postgres evaluates NULL run_id as unknown and drops it, so a user comment with run_id NULL would stop counting. throttle-genuine-new-input (runId null, actorType user) guards exactly this; use `run_id IS NULL OR run_id NOT IN (...)`.
- throttle-activity-after-finish keeps each comment row 1 s before finish and only moves the activity row after finish (0.6 s, 1.8 s, 2.9 s), matching the verify-515 live measurement.
- sweep-bound inserts 63 rows in one insert: 3 identical at 120 to 122 min ago, 60 in-window at 10 s + 25 s steps (oldest 1485 s, inside 1800 s). After a LIMIT+1 fetch, row 51 is in-window and identical, so nothing is progress.

## Unverified
- Full heartbeat-process-recovery.test.ts suite not run (known base hang); only GGU-809 + 515 subset.
- Original heartbeat-issue-rewake-throttle.test.ts (8 cases) not re-run this round (unchanged file; not in this brief's acceptance).
- No typecheck run on the test files (vitest transpiles without type checking). `typeof issueComments.$inferInsert` is used in sweep-bound; it ran, but tsc was not run.

## Proposed memory (orchestrator decides)
- When a fix excludes "own" rows with a NOT IN on a nullable column, pair it with a control row whose column is NULL, because SQL NOT IN drops NULLs and silently removes genuine input (agentos#515 r2, activity_log.run_id). namespace infra, type lesson.

STATUS: COMPLETE
