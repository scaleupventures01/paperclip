STATUS: IN PROGRESS

# redtests-515 report

## Akili
Queried "paperclip engine rewake throttle stranded sweep repeated comment progress tests embedded postgres" (namespace infra,global). Best L2 0.965, all hits off-topic (HEARTBEAT_SCHEDULER_ENABLED, review escalation, concurrency). Akili had nothing relevant; nothing pulled.

## Mechanism used
The testcases skill was NOT run; tests were written directly (the brief allows this; I did not invoke the Skill tool).

## Environment findings (before any test was written)
1. Brief premise "Dependencies are installed" was FALSE. First baseline (npx vitest) failed all 3 suites at setup: `Error: Cannot find module 'supertest/lib/test.js'` from server/src/__tests__/setup-supertest.ts:25; 0 tests ran. Root had an npm-style install (untracked package-lock.json, node_modules/.package-lock.json), server/node_modules had no supertest. Fixed locally with `pnpm install --frozen-lockfile` (exit 0, 2m55s). The untracked root package-lock.json predates me (not mine; left in place).
2. Second baseline (pnpm exec vitest, embedded PG per suite) still ran ZERO DB tests. Not a host-unsupported skip: the support probe passed, but both suites' beforeAll timed out:
   - heartbeat-issue-rewake-throttle.test.ts: `Error: Hook timed out in 20000ms.` at :65 -> 8 tests | 8 skipped
   - heartbeat-process-recovery.test.ts: `Error: Hook timed out in 20000ms.` at :458 -> 294 tests | 294 skipped
   - issue-rewake-throttle.test.ts (pure): 14 passed
   Totals: `Tests  14 passed | 302 skipped (316)`, exit=1. Log: scratchpad/baseline-515.log
   Cause, measured: startEmbeddedPostgresTestDatabase (initdb + start + migrations) took 59449 ms (scratchpad/time-epg.log) with load average 39.48 on 10 CPUs (uptime at 13:43 ET). The suite hook budget is 20 s.
3. Remedy: one long-lived migrated embedded Postgres (scratchpad/hold-epg.mts, connection string in scratchpad/epg-url.txt) passed as PAPERCLIP_TEST_DATABASE_URL. heartbeat-process-recovery.test.ts already honours that env (:253). heartbeat-issue-rewake-throttle.test.ts does NOT (hard 20_000 beforeAll at :65-69), so the throttle 515 cases live in a NEW file, heartbeat-issue-rewake-throttle-515.test.ts, a copy of that file's harness plus PAPERCLIP_TEST_DATABASE_URL support and the exported EMBEDDED_POSTGRES_TEST_TIMEOUT_MS (90 s) hook budget. The original throttle file is unchanged.
4. A full base-commit run of heartbeat-process-recovery.test.ts against the shared DB HUNG (scratchpad/baseline2-515.log, stopped at 14:42 ET): worker at 0% CPU, log silent 14+ min; pg_stat_activity showed one connection `idle in transaction` (ClientRead, 17m47s) and 9 backends blocked on `delete from "chat_conversations"` (Lock/tuple), 9 ungranted locks. This is a pre-existing base-suite cleanup deadlock under load (load avg 90 to 132 at the time), unrelated to 515. Baseline for that file was therefore narrowed with `-t "GGU-809"` (the existing coverage of the exemption the 515 cases sit beside).
5. heartbeat-process-recovery.test.ts external-DB mode is single-use per database: beforeAll inserts user id `responsible-user` (:470) and nothing removes it; a second run against the same DB fails the whole suite with 23505 duplicate key on user_pkey (298 skipped). Worked around with a pre-run delete of that one row (scratchpad/pgreset-user.mts).

## Acceptance 1: baseline on base commit 2b2af9e6 (base bytes via `git show 2b2af9e6:<file>` into temporary zz-baseline515-*.test.ts copies, deleted afterwards)
Shared DB: scratchpad/hold-epg.mts (one migrated embedded PG, URL in PAPERCLIP_TEST_DATABASE_URL).
Command (a): `cd server && PAPERCLIP_TEST_DATABASE_URL=... pnpm exec vitest run src/__tests__/zz-baseline515-throttle.test.ts src/__tests__/issue-rewake-throttle.test.ts`  (log scratchpad/baseline3a-515.log)
```
 Test Files  2 passed (2)
      Tests  22 passed (22)
exit=0
```
Command (b): `pnpm exec vitest run src/__tests__/zz-baseline515-recovery.test.ts -t "GGU-809"`  (log scratchpad/baseline3b-515.log)
```
 Test Files  1 passed (1)
      Tests  2 passed | 292 skipped (294)
exit=0
```
Pre-existing failures by case name: none in the scoped set. The 292 skipped in (b) are the -t filter, not host skips. The original throttle file (8 tests) passed here; in two other runs on this host it failed its 20 s beforeAll (`Hook timed out in 20000ms.` at heartbeat-issue-rewake-throttle.test.ts:65), i.e. it is load-flaky on this machine, unrelated to 515.
Earlier unscoped attempts (for the record): baseline-515.log run 2 = `Tests  14 passed | 302 skipped (316)`, exit=1, both DB suites hook-timeout; baseline2-515.log = hung (finding 4).

## Tests written (commits on feat/515-repeated-comment-progress)
- NEW server/src/__tests__/heartbeat-issue-rewake-throttle-515.test.ts (harness copied from heartbeat-issue-rewake-throttle.test.ts, plus PAPERCLIP_TEST_DATABASE_URL and the 90 s EMBEDDED_POSTGRES_TEST_TIMEOUT_MS hook budget). Fixture: one earlier agent comment (no run) plus three succeeded runs, each with one `issue.comment_added` activity row (runId set, createdAt 1 s before the run finished so it is not "new input") and one issue_comments row (createdByRunId = run, authorAgentId = agent). Identical first line "waiting on SCAA-3598: its status is blocked after re-reading it before acting", later lines vary, one copy has extra leading/trailing and internal whitespace (proves trim + collapse). Wake: `heartbeat.wakeup(agentId, {source:"automation", reason:"issue_continuation_needed", payload:{issueId}, ...})`.
  - 515-A: expects latest agent_wakeup_requests reason "issue_rewake_throttled", status "skipped", wakeup returns null.
  - 515-A-control: three differing first lines; expects not throttled.
  - 515-C (status change): repeated comments, newest run also has `issue.updated` with details {status:"in_progress", _previous:{status:"todo"}}; expects not throttled.
  - 515-C (child created): same with `issue.child_created`; expects not throttled.
  - 515-D (throttle): repeated comments with process.env.STRANDED_REPEATED_COMMENT_IS_PROGRESS="1" set only around the wake call (restored in finally); expects not throttled.
- server/src/__tests__/heartbeat-process-recovery.test.ts: added imports `assets`, `issueAttachments`, and a nested describe after the GGU-809 cases using seedStrandedIssueFixture({status:"in_progress", runStatus:"succeeded", retryReason:"issue_continuation_needed", runSource:"issue.productive_terminal_continuation_recovery", livenessState:"advanced"}) and heartbeat.reconcileStrandedAssignedIssues(). Comments: one identical comment 120 min ago (outside the 30 min window) plus two identical-first-line comments at 20 and 5 min, so every in-window comment repeats its predecessor.
  - 515-B: expects recentProgressExempted 0, escalated 1, continuationRequeued 0, issue status "blocked".
  - 515-B-control: differing first lines; expects exempted 1, requeued 1, still in_progress.
  - 515-B-attachment: identical comments plus an issue_attachments row in the window; expects exempted 1, requeued 1. Asset and attachment are deleted in finally because the file's afterEach does not clear assets.
  - 515-D (sweep): identical comments with the kill switch "1" around the sweep; expects exempted 1, requeued 1.
No existing test or expectation was edited. No non-test source file was touched.

Note for the fix agent (AC4): STRANDED_RECENT_PROGRESS_EXEMPTION_MS is read from env at import time (server/src/services/recovery/service.ts:176-179). The 515-D cases set STRANDED_REPEATED_COMMENT_IS_PROGRESS only around the call, after import, so the kill switch must be read per call (not as a module constant) or 515-D will go red after the fix.

## Acceptance 2: after adding tests
Command (a): `cd server && PAPERCLIP_TEST_DATABASE_URL=... pnpm exec vitest run --reporter=verbose src/__tests__/heartbeat-issue-rewake-throttle-515.test.ts src/__tests__/heartbeat-issue-rewake-throttle.test.ts src/__tests__/issue-rewake-throttle.test.ts`  (log scratchpad/after-515a.log)
```
 × ... > 515-A throttles issue_continuation_needed when every recent run only repeated the same comment first line
 ✓ ... > 515-A-control does not throttle when each run's comment has a different first line 709ms
 ✓ ... > 515-C still counts a real status change in a repeated-comment run as progress 1186ms
 ✓ ... > 515-C still counts a child issue created in a repeated-comment run as progress 1659ms
 ✓ ... > 515-D kill switch STRANDED_REPEATED_COMMENT_IS_PROGRESS=1 restores comment-as-progress in the throttle
 Test Files  2 failed | 1 passed (3)
      Tests  1 failed | 18 passed | 8 skipped (27)
exit=1
```
515-A failure (assertion, not setup):
```
AssertionError: expected 'issue_continuation_needed' to be 'issue_rewake_throttled' // Object.is equality
Expected: "issue_rewake_throttled"
Received: "issue_continuation_needed"
 ❯ src/__tests__/heartbeat-issue-rewake-throttle-515.test.ts:346:30
    346|       expect(latest?.reason).toBe("issue_rewake_throttled");
```
The second failed file and the 8 skipped are the UNCHANGED original heartbeat-issue-rewake-throttle.test.ts hitting `Hook timed out in 20000ms.` at :65 on this loaded host (it passed 8/8 in baseline3a); not a 515 effect.

Command (b): pre-run delete of the leftover `responsible-user` row, then `pnpm exec vitest run --reporter=verbose src/__tests__/heartbeat-process-recovery.test.ts -t "GGU-809|515"`  (log scratchpad/after-515b.log)
```
 ✓ ... > exempts stranded-recovery escalation when assignee posted a recent comment (GGU-809) 2471ms
 ✓ ... > still escalates stranded-recovery work when the recent comment is older than the exemption window (GGU-809) 646ms
 × ... > 515-B escalates to blocked when the assignee's in-window comments all repeat one first line
 ✓ ... > 515-B-control still exempts and re-queues when the in-window comments have differing first lines
 ✓ ... > 515-B-attachment still exempts when identical comments come with an attachment in the window
 ✓ ... > 515-D kill switch STRANDED_REPEATED_COMMENT_IS_PROGRESS=1 restores the comment exemption in the stranded sweep
 Test Files  1 failed (1)
      Tests  1 failed | 5 passed | 292 skipped (298)
exit=1
```
515-B failure (assertion, not setup):
```
AssertionError: expected 1 to be +0 // Object.is equality
- 0
+ 1
 ❯ src/__tests__/heartbeat-process-recovery.test.ts:15110:45
    15110|       expect(result.recentProgressExempted).toBe(0);
```
Verdict: A and B RED on the throttle/escalation assertion; A-control, B-control, B-attachment, both C, both D GREEN. Expected pattern met. None of the 515 cases skipped.

## Acceptance 3: git
```
$ git log --oneline 2b2af9e6..HEAD
55ae6d5f test(515): RED cases for repeated identical comment in the stranded sweep exemption
3a55f3ff test(515): RED cases for repeated identical comment in the rewake throttle
$ git status --porcelain
?? .build-provisioned
?? BUILD-STATE.md
?? build-state.json
?? package-lock.json
```
package-lock.json (root, untracked) predates this agent (npm-style install found at start); not created or removed by me. node_modules from `pnpm install --frozen-lockfile` is gitignored. Dash scan of commit messages and added lines: 0 (control string with U+2014: 1). Not pushed, no PR, no ssh.

## How the orchestrator / fix agent can re-run these on this host
1. `pnpm exec tsx <scratchpad>/hold-epg.mts <scratchpad>/epg-url.txt &` (one migrated embedded PG; SIGTERM its pid to stop cleanly).
2. `cd server && export PAPERCLIP_TEST_DATABASE_URL=$(cat <scratchpad>/epg-url.txt)`
3. `pnpm exec vitest run src/__tests__/heartbeat-issue-rewake-throttle-515.test.ts`
4. `pnpm exec tsx <scratchpad>/pgreset-user.mts "$PAPERCLIP_TEST_DATABASE_URL"` then `pnpm exec vitest run src/__tests__/heartbeat-process-recovery.test.ts -t "GGU-809|515"` (repeat the reset before every recovery-file run on the same DB).
Without PAPERCLIP_TEST_DATABASE_URL the suites start their own cluster; that took 59449 ms here at load ~40, past the 20 s/30 s hook budgets.

## Unverified
- The full heartbeat-process-recovery.test.ts suite (294 base cases) was not completed on this host (hang, finding 4); only the GGU-809 + 515 subset is proven.
- The original throttle file's 8 tests pass at base (baseline3a) but not deterministically on this host (20 s hook).

## Proposed memory (orchestrator decides)
- When running paperclip server DB tests on the loaded Mac mini, start one migrated embedded PG and pass PAPERCLIP_TEST_DATABASE_URL (deleting user 'responsible-user' before each heartbeat-process-recovery run), because a per-suite cluster took 59 s against a 20 to 30 s hook budget and every DB case silently became "skipped". (namespace infra, type lesson)

STATUS: COMPLETE
