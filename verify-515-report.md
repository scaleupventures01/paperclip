STATUS: IN PROGRESS

# verify-515 report

## Akili
Queried "paperclip rewake throttle repeated comment progress stranded sweep verification" (infra,global). Best L2 0.938, all weak. Pulled 9688bc5a (lesson: test a recovery rule against the FULL stored records the sweep reads, not a projection) because it applied; it directly motivated the real-data replay that found P0-1 below. Nothing else relevant.

## Under test
Worktree /Users/niaopenclaw/Domains/paperclip/.worktrees/wt-515, HEAD 2ee4cf4c100d487fd20ec1f61d4dec6b815868b2 (git rev-parse HEAD), base 2b2af9e6. `git status --porcelain` shows only the pre-existing untracked files listed in the fix report.

## Leg 1: focused suites (my own run, shared embedded PG pid 40097 from scratchpad/hold-epg-verify.log, URL scratchpad/epg-url-verify.txt)
(a) scratchpad/v515-leg1a.log, three files together:
```
 Test Files  1 failed | 2 passed (3)
      Tests  19 passed | 8 skipped (27)
exit=1
```
The failed file is the ORIGINAL heartbeat-issue-rewake-throttle.test.ts: `Error: Hook timed out in 20000ms.` (own embedded PG, host load ~29). Re-run alone (scratchpad/v515-leg1c.log): `Tests  8 passed (8)`, exit=0. All 14 pure cases passed. 515 cases in (a), all passed:
- 515-A throttles issue_continuation_needed when every recent run only repeated the same comment first line
- 515-A-control does not throttle when each run's comment has a different first line
- 515-C still counts a real status change in a repeated-comment run as progress
- 515-C still counts a child issue created in a repeated-comment run as progress
- 515-D kill switch STRANDED_REPEATED_COMMENT_IS_PROGRESS=1 restores comment-as-progress in the throttle
(b) scratchpad/v515-leg1b.log, after deleting responsible-user (0 rows existed, fresh DB), `-t "GGU-809|515"`:
```
 Test Files  1 passed (1)
      Tests  6 passed | 292 skipped (298)
exit=0
```
Passed: both GGU-809 cases, 515-B, 515-B-control, 515-B-attachment, 515-D (sweep).

## Leg 4: real-data replay (read-only SELECT/EXPLAIN on scaleup-svr agentos; SQL authored locally, scp'd to /tmp, run, deleted; `ls /tmp/v515-*` on host returns "No such file")
Raw pulls: scratchpad/v515-2117.json, scratchpad/v515-3911.json (SQL scratchpad/v515-replay.sql). Replay script scratchpad/v515-replay/replay.mts imports progressCommentIds, AGENT_ISSUE_COMMENT_HISTORY_LIMIT, evaluateIssueRewakeThrottle, ISSUE_PROGRESS_ACTIVITY_ACTIONS, ISSUE_NEW_INPUT_ACTIVITY_ACTIONS from the wt-515 worktree and repeats the heartbeat.ts comment-only classification line for line. Output scratchpad/v515-replay.out (exit=0).

### 4a. SCAA-2117 as of 2026-10-12T13:12:59Z (assignee ebf2147c, 50 history rows, 8 sampled runs, all succeeded, every run's only progress action is issue.comment_added)
- Runs counting as progress: fix 0 of 8; pre-fix 8 of 8.
- evaluateIssueRewakeThrottle with hasNewIssueInputSinceLastRun=false: blocked=true, noProgressStreak=8, cooldownMs=1800000, nextAllowedAt 13:42:37.892Z. Pre-fix: blocked=false, streak 0.
- BUT with the production new-input value: blocked=false, streak 0. The last run 11644c9b finished 13:12:37.892Z and its own issue.comment_added activity row is 13:12:38.068Z, i.e. AFTER finished_at. The throttle's new-input query (heartbeat.ts:27913-27933, `gt(activityLog.createdAt, lastRunFinishedAt)`, action in ISSUE_NEW_INPUT_ACTIVITY_ACTIONS which includes issue.comment_added, actor filter only for agent comment wakes) therefore finds the agent's own comment as "new input". The wake that followed (13:12:48Z, reason issue_continuation_needed, requested_by system, no comment id; scratchpad/v515-wakes.out) is not a comment wake, so no actor filter applies. All 8 sampled runs show the same ordering (activity 0.1 to 2.9 s after finished_at). Fleet-wide last 24 h: 640 of 1338 succeeded runs with a comment activity have it after finished_at (scratchpad/v515-src.out).
- Stranded sweep (hasRecentAssigneeCommentProgress, 30 min default window): exempted_fix = TRUE (pre-fix also true). Cause: 58 assignee comments in the window (scratchpad/v515-win.out), all with the identical first line "waiting on SCAA-3598: its status is blocked after re-reading it before escalation" (418 comments up to as-of, 6 distinct first lines ever). The 50-row history ends at row 50 (12:46:52Z, inside the window); its predecessor row 51 (12:46:23Z, same first line) is outside the bound, so progressCommentIds marks row 50 as progress ("unknown predecessor counts as progress") and the sweep exempts the card.
- All 8 wakes in the sample came from the sweep (context source issue.productive_terminal_continuation_recovery, retryReason issue_continuation_needed), so the sweep exemption is the gate that decides 2117, and it still exempts.
- Expected per brief: throttled. Observed: NOT throttled and NOT escalated on production-shaped data. See P0-1 and P0-2.

### Control SCAA-3911 as of 2026-10-12T13:10:30Z
3 history rows, 3 runs, first lines all different ("CREATED SCAA-3912 ...", "The Marketing Analyst child card ...", "`WAITING SCAA-3912 status=in_progress proof=no; nothing changed`"); run 970e46d2 also has issue.updated. Fix: 3 of 3 runs progress, streak 0, not blocked (also not blocked with no new input). Sweep exempted. Matches expectation (not throttled).

### 4b. EXPLAIN of the history query shape (scratchpad/v515-explain.out)
```
 Limit  (cost=4.96..5.01 rows=2 width=222)
   ->  Incremental Sort  (cost=4.96..5.01 rows=2 width=222)
         Sort Key: created_at DESC, id DESC
         Presorted Key: created_at
         ->  Index Scan Backward using issue_comments_company_issue_created_at_idx on issue_comments  (cost=0.42..4.95 rows=1 width=222)
               Index Cond: ((company_id = '...'::uuid) AND (issue_id = '...'::uuid))
               Filter: (author_agent_id = '...'::uuid)
```
Served by issue_comments_company_issue_created_at_idx (company_id, issue_id, created_at), backward scan, author as a filter, stops at 50. The planner estimates rows=1 against 1669 real comments on the issue (stale stats); worst case it reads every comment on the issue by other authors before reaching 50 of this agent's, still bounded by the issue's comment count. Acceptable.

### Extra live measurement: how the first-line rule classifies real comments (last 7 days, scratchpad/v515-fleet.out, v515-json.out, v515-json2.out, v515-json3.out)
- 8608 agent comments; 6821 have a same-agent predecessor; 4735 repeat its first line; 3801 of those have a different body; 167 issues affected.
- 3748 of the 3801 are JSON bodies whose first line is just "{" (schemas agentos.delivery-manager-decision/v1 1755, rule-decision/v1 1172, jev-decision/v1 1147, build-candidate-receipt/v2 59, qa-receipt/v2 56, ...). 3764 consecutive "{" pairs, all bodies differ, 122 even change schema. Every structured receipt after the first per agent per issue is "not progress" under the fix.
- Throttle impact: 3756 of 3758 runs that authored such a comment also had a non-comment progress action, so the throttle still counts them. Sweep impact: the sweep only looks at comments and attachments, so a stranded productive card whose assignee communicates in JSON receipts loses the GGU-809 exemption and is escalated to blocked. See P1-1.

## Leg 2: independent mutations (script scratchpad/v515-mut2.sh, restore by trap via git checkout; run log scratchpad/v515-mutrun.log)
sha256 before: heartbeat.ts 95b3f975db0ce237868d6b94de72fcc323f212102c37023f8e87ba7e283fd7f1, recovery/service.ts 06a4edb11a3a4b90d744f06b25d11583c860abb7ee0e1d0b156e668510711807. After each restore and at the end: identical, `git diff | wc -l` = 0.
- MUT1, heartbeat.ts:27907 fail-open branch disabled (`if (false && !runsWithFoundComment.has(runId))`), i.e. a comment-only run whose comment row is not in the 50-row history no longer counts as progress. Result (v515-mutA.log): `Tests  5 passed (5)`, exit=0. NO case goes red. Finding P2-1: the fail-toward-waking branch is untested.
- MUT2, heartbeat.ts:27862 classification wrong (`if (true /* MUT2 */)`, every progress row treated as comment-only). Result (v515-mutB.log): 515-C status change and 515-C child created go RED (`expected null not to be null` at heartbeat-issue-rewake-throttle-515.test.ts:407:24 and :430:24); 3 others pass. `Tests  2 failed | 3 passed (5)`, exit=1. Guard works.
- MUT3, recovery/service.ts:1983 in-window check dropped (`true /* MUT3 */ &&`). Result (v515-mutC.log): GGU-809 "still escalates ... older than the exemption window" RED (`expected +0 to be 1` at heartbeat-process-recovery.test.ts:15022:30) and 515-B RED (`expected 1 to be +0` at :15110:45). `Tests  2 failed | 4 passed | 292 skipped (298)`, exit=1. Guard works.
Incident during the first attempt: the Data volume hit ENOSPC (119 MiB free) mid MUT1, the trailing cp restore failed and left MUT1 in heartbeat.ts (`git status` " M"). I caught it on re-read, restored with `git checkout`, sha back to 95b3f975, diff empty, then re-ran with a trap-based restore. Stopping my shared PG freed about 2.1 GiB. Disk at report time: 667 MiB free of 228 GiB (other consumers); this host is at risk for every agent.

## Leg 3: code review at HEAD 2ee4cf4c
OK items:
- Company scoping: heartbeat.ts:27886 (`eq(issueComments.companyId, agent.companyId)`, plus issueId, authorAgentId); recovery/service.ts:1954 (kill-switch path) and :1973 (history path) scope by companyId, issueId, assigneeAgentId.
- Bounded rows: `.limit(AGENT_ISSUE_COMMENT_HISTORY_LIMIT)` heartbeat.ts:27895, service.ts:1979; constant 50 at comment-first-line-progress.ts:24. Index-served (4b).
- Kill switch per call: comment-first-line-progress.ts:28 reads process.env on each call; called at heartbeat.ts:27872 and service.ts:1948 per evaluation. Proven by 515-D in both suites (env set only around the call, after import).
- Fail toward waking when no comment row is found: heartbeat.ts:27906-27910 (present but untested, P2-1).
- No change to thresholds, windows, ladder, ISSUE_PROGRESS_ACTIVITY_ACTIONS: `git diff --stat 2b2af9e6..HEAD -- packages server/src/services/issue-rewake-throttle.ts` is empty; STRANDED_RECENT_PROGRESS_EXEMPTION_MS (service.ts:180-183) untouched. No schema or migration change (only 5 files changed: 2 tests, 1 new helper, heartbeat.ts, service.ts).

Findings:
- P0-1 (sweep, core outcome fails on the motivating card): the "unknown predecessor counts as progress" rule (comment-first-line-progress.ts:64, used at service.ts:1980-1985) combined with the 50-row bound means any assignee that posts more than 50 comments inside the 30 min window (one every 36 s or faster) is always exempted: the oldest in-window row in the bound has no predecessor in the history and counts as new. SCAA-2117 posts every ~30 s (58 in-window comments at 13:12:59Z) and the replay shows exempted=TRUE with the fix. Suggested remedy for the fix agent: fetch LIMIT+1 rows and judge only the first LIMIT (the extra row is the predecessor), in both call sites; add a test with more than 50 identical in-window comments.
- P0-2 (throttle, core outcome fails on production-shaped data): the throttle half only blocks when hasNewIssueInputSinceLastRun is false, but in production the run's own issue.comment_added activity row is written after heartbeat_runs.finished_at in 640 of 1338 runs (24 h) and in all 8 sampled 2117 runs, and the new-input query (heartbeat.ts:27913-27933) has no actor filter for non-comment wakes, so the agent's own repeated comment counts as "new input". Replay: blocked only if new input is forced false; with real ordering, not blocked. The RED fixture deliberately sets the activity 1 s BEFORE finish ("so it is not new input", redtests report), which hides this. This is pre-existing new-input semantics, but it means the throttle half of #515 does not stop the 2117 loop. Remedy options for the orchestrator: exclude activity rows whose runId is one of the sampled runs from the new-input query, or exclude agent-authored comment_added by the same agent; needs a test with activity after finished_at.
- P1-1 (spec-level, sweep): the first-line rule treats JSON-bodied comments (first line "{") as repeats. 3748 such comments in 7 days (delivery-manager-decision, rule-decision, jev-decision, build-candidate-receipt, qa-receipt, ...); 3764 consecutive pairs, all bodies differ, 122 change schema. Throttle unaffected (3756 of 3758 authoring runs have another progress action). The sweep looks only at comments and attachments, so a stranded productive card whose assignee speaks in JSON receipts loses the GGU-809 exemption and is escalated to blocked. Suggest normalising to the first line that is not just a brace/bracket, or comparing a body hash, after a decision.
- P2-1: fail-open branch untested (MUT1 stays green).
- P2-2: deleted comments (deleted_at) are not filtered in either history query, matching the old GGU-809 query; a deleted predecessor can make a new comment look like a repeat.
- P2-3: the original heartbeat-issue-rewake-throttle.test.ts still flakes on its 20 s beforeAll on this host (Hook timed out in leg 1a; 8/8 when run alone).

## Leg 5: verdict per AC
- AC1 (unit: repeated first line is not progress in throttle and sweep): PASS at unit level (515-A, 515-B green; mutation by the fix agent and my MUT2/MUT3 bite). FAIL on production-shaped replay of SCAA-2117 (P0-1, P0-2): the card would be neither throttled nor escalated.
- AC2 (other progress still counts): PASS (515-C status change, 515-C child created, 515-B-attachment green; MUT2 turns both 515-C red).
- AC4 (kill switch, per call): PASS (515-D throttle and 515-D sweep green; env read per call at comment-first-line-progress.ts:28).
- AC3: live, not mine. Prediction from the replay: AC3 will FAIL for SCAA-2117 as written.
Overall: NOT READY TO SHIP (2 P0).

## Unverified
- The full heartbeat-process-recovery.test.ts suite was not run (known base hang per RED report); only GGU-809 + 515.
- No typecheck run by me (fix report claims tsc exit 0).
- Replay uses first lines only (split_part on newline) and the 30 min default window; I did not read the live service env for a STRANDED_RECENT_PROGRESS_EXEMPTION_MS override (systemd unit grep returned nothing visible to calvin).
- I did not check whether the live stranded sweep cadence lets the throttle see a different lastRun than my as-of sample.

## Proposed memory (orchestrator decides)
- When a fix judges "is this row new" over a bounded newest-N history, fetch N+1 and judge only N, because with "unknown predecessor = new" the oldest row in the bound always counts as new and a fast enough loop defeats the rule (agentos#515: 58 in-window comments vs 50-row bound). namespace infra, type lesson.
- When a test fixture places an activity row relative to run finished_at, read the live ordering first, because 48% of real runs write their comment activity after finished_at and the fixture hid that the throttle sees it as new input. namespace infra, type lesson.

STATUS: COMPLETE
