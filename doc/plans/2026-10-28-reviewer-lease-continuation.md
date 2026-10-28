# Reviewer assignment continuation after execution cleanup

Date: 2026-10-28 UTC. Design for [#124](https://github.com/phenix3443/paperclip/issues/124).
Status: proposed. Exact-head independent approval, passing CI, plan merge and
issue closure precede separately assigned implementation. No deployment or live
recovery is authorized by this document.

## Problem Statement

A native review handoff can arrive after author cancellation but before its
execution lease is released. Admission correctly refuses overlapping execution,
but records the automatic assignment as a terminal diagnostic. Cleanup does not
resume that diagnostic. The reviewer remains selected and its review remains
pending, with no run. This is a delivery loss, distinct from review-state loss.

## Versions and evidence

| Reference | Exact revision and observation |
| --- | --- |
| Incident installation | `fdbafff72d8fd6ae7f12eb5827631efc67d208f3`, server package 0.3.1, recorded by the existing incident report; no new live DB inspection |
| Isolated diagnostic base / develop | `99481ae2e0f5869d85c95a8cb3961930dc23b489` |
| Upstream master | `cff331f6ca0a652b5e41641c68dfa5fa584c22ae`, host `git ls-remote upstream refs/heads/master` |
| Related approved design | [#116](https://github.com/phenix3443/paperclip/pull/116), merged at the diagnostic base |

Source inspection at all three commits finds the automatic assignment branch
calling `recordExecutionWait`. This writes `status=skipped`, `runId=null` and a
finished timestamp. It explicitly documents that such receipts are diagnostics,
not authority to suppress or dispatch future work. The deployed incident has
five receipts with precisely that status/reason and the lease-release refusal.
Their complete payloads and object identifiers stay in the private incident
report. No live tasks were replayed and no historical receipts were changed.

The diagnostic in the companion `.diagnostic.md` uses the real heartbeat service,
real queue admission and a disposable embedded PostgreSQL database. It creates
two agents, a pending original reviewer with policy and review count 2, an
acknowledged cancelled author run, and an active local lease. A separate busy
reviewer run prevents provider execution. It does not call a model or use any
business task. All connections and the database are closed by fixture teardown.

Actual command (180-second overall limit):

```sh
timeout 180 pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/reviewer-lease-diagnostic.test.ts
```

The first attempt failed to import an unbuilt plugin SDK (zero tests); offline
installation and `pnpm --filter @paperclipai/plugin-sdk ensure-build-deps` resolved
that environment problem. Two subsequent runs reproduced the target assertion:
`expected [] to have a length of 1 but got +0`. The final run had one expected
failure and one passing positive control (31.99 seconds total; 1.852 seconds in
the two tests). Admission produced `skipped / execution_reconciliation_required /
runId=null`. After controlled release the execution blocker was null; concurrent
`resumeQueuedRuns()` calls still yielded zero successors. Policy, full state and
responsible user remained equal. The positive control releases the synthetic
lease before first admission and queues one reviewer run. It is not a fix-green
result or a supported operational recovery request.

These results distinguish the ranked explanations: loss of a durable obligation
is reproduced; existing recovery also selects deferred saved comments or
interactions rather than this no-input assignment; a surviving lease blocker is
excluded in the fixture. They do not prove every deployed configuration shares
all remaining admission conditions.

## Solution and User Stories

1. As the assigned reviewer, I receive the original pending review once cleanup
   has actually completed, without another comment or completion submission.
2. As the author, I retain the same reviewer, return assignment and review history.
3. As an operator, I can distinguish future automatic delivery from historical
   incidents for which my current credentials have no recovery capability.
4. As a company owner, I retain pause, budget, membership and responsible-user gates.

Correct the existing assignment delivery lifecycle. Keep a newly refused
reviewer assignment as unfinished work in the existing wake-request storage;
return it through ordinary admission when the existing cleanup lifecycle settles.
Do not reinterpret old `skipped` diagnostics as executable instructions.

## Implementation Decisions (future, separately authorized)

### Module ownership and interface

Queue admission owns receipt creation/adoption and successor uniqueness. Run
control owns invoking that admission after proven execution release. The heartbeat
facade wires these owners; it must not accumulate a parallel recovery engine.
The existing queue-release/startup-resume interface is the test seam. Extend its
internal handling of a native assignment, rather than exposing a recovery route.
Provider cleanup stays in the environment owner. Review policy alone owns decisions.

The eligible receipt must retain company, issue, original target reviewer,
original source/reason, requesting actor, interrupted source run and server-created
stage context. Preserve the complete context required by normal admission. Give
new unfinished assignments a stable receipt identity using existing wake fields.
Store a canonical snapshot digest of policy, full executionState, assignee and
responsibleUserId in that receipt's existing JSON payload. Compare it to the
current canonical values under the lock; never trust caller-supplied snapshots.
Persist before notifying; retain original receipts as audit records. A terminal
`skipped` row remains diagnostic and cannot become a recovery authority.

### Exact continuation contract

Under the company-scoped issue row lock, re-read the receipt, current issue,
policy, state, source execution release evidence and current authority. Require:

- Receipt target equals current assignee and pending review currentParticipant;
  stage ID/type and the current review submission match the saved intent.
- Full review generation remains the same: policy, participant, returnAssignee,
  reviewRequest, lastDecisionId/outcome and completed stages are unchanged.
  A changed generation retires the old intent; never silently retarget it.
- Source company/issue/run association is exact. Terminal run status alone is
  insufficient: existing process/controller, lease, workspace and recovery checks
  must prove release. Uncertainty remains held.
- No applicable queued/running/scheduled-retry successor or competing execution
  exists. An existing matching successor satisfies delivery, without a new run.
  Another turn causes re-evaluation; it is not permission to cancel that turn.
- Company/agent readiness, current responsible-user authorization, project access,
  budget, pause/Stop, dependencies, interactions and recovery holds all pass
  ordinary admission and final dispatch validation. Never borrow the cleanup
  actor's authority or rewrite responsibleUserId from the requesting agent.

Adopt the receipt and create/coalesce its successor atomically using the existing
queue transaction. Use `review-assignment-continuation:<receipt UUID>` as the successor
idempotency key. The issue lock also coalesces equivalent duplicate receipts
for the same current submission; distinct receipt keys alone do not prevent
duplicate delivery. A duplicate
release or competing service instance observes the same result. This is delivery,
not a review transition: policy, full executionState, decisions, round count and
responsibleUserId remain byte-for-byte equivalent as persisted JSON/values. Missing
or null maxReviewRounds continues to mean three. No extra decision is inserted.

Use the existing proven execution-release event for immediate continuation, scoped
to the issue across author/reviewer agent identities. A same-author-only lookup
cannot find the reviewer. Existing startup queue recovery must reconstruct the
unfinished assignment after restart and close the release/receipt-commit race.
Do not add a new scheduler, delivery topic, timer, flag, table or recovery authority.
Failure after commit must retain the existing unfinished obligation. Implementation
must demonstrate retry and gate-release liveness using existing lifecycle hooks;
if that requires any new scheduling mechanism, stop and return the concrete gap
for separate ownership before extending the fork.

### Existing authorization and historical recovery

`POST /api/agents/:id/wakeup` requires an agent caller to target itself. A board
caller needs company access and `agent:wake`. Normal admission still checks the
current task, workspace, identity and execution gates. The service-level fixture
call is not public caller authority and is not an exact historical-assignment
recovery protocol. A generic authorized wake does not prove adoption of the
original assignment or provide its generation-bound idempotency contract.

Exact failed-run retry requires Board context and an actual eligible failed run.
These incidents have no failed reviewer run. The cancelled author's run is not
that run. Pending-review recovery resolution additionally requires a matching
reconciliation action and verified pre-start cancelled reviewer evidence; neither
is present here. #82 requires its own admitted reconciliation delivery and cannot
be inferred from a skipped receipt. The deployed operator whitelist has no
matching action. **There is no demonstrated applicable existing exact native
recovery entry point under the assigned ops/agent authority for the five historical
skipped assignments.** No request should be issued under a substitute contract.

Preserve the five business reviews and the original incident's independent ops
acceptance. CTO must assign any historical recovery capability outside this fork
scope to ai-team, or identify and separately authorize a proven existing entry.
This plan does not design that new capability or ask Board for an internal choice.

## Testing Decisions and acceptance

Use real service/database tests, controlled cleanup promises and two service
instances; mock only provider execution. Do not use sleeps to create the race.

| Case | Observable required result |
| --- | --- |
| Assignment arrives with lease held | Original unfinished intent exists; no provider or successor starts |
| Proven cleanup settles | Exactly one original-reviewer successor; all policy/state/decision/user snapshots equal |
| Duplicate/concurrent release; restart before/after commit | One delivery, durable receipt association; no extra decision |
| Already queued/running successor | No second run; preserve its execution and evidence |
| Cleanup delayed, failed, uncertain process/workspace | No delivery until existing proof becomes valid |
| Policy, participant, submission or decision changes; task cancelled | Old intent never dispatches into the new generation |
| Blocker, unanswered interaction, pause or budget hold | No forced delivery; retain applicable intent and resume only through existing legal lifecycle |
| Foreign company, revoked user/project access, stale actor | No unauthorized successor; no foreign data mutation |
| Missing/null review limit, count 2; preserved decision rows | Limit remains three; no reset or fourth automatic review |
| Cleanup event precedes receipt commit; notification fails | Commit/startup recovery still produces one eligible successor |
| Historical skipped receipt | Remains untouched; no automatic promotion of diagnostic history |

The committed diagnostic is the red oracle. Future implementation must make its
original symptom assertion green without submitting another assignment. Add the
assembled executor cleanup test and matrix above; a test that merely invokes a
new resume helper is insufficient. Retain the positive control separately.
Bound each command to at most 600 seconds. Run focused queue, run-control,
continuation and process-recovery suites first. Full typecheck/test/build belongs
to the later implementation PR and CI; this documentation PR does not claim those
runtime checks have passed.

## Upstream reuse, rollout and rollback

Upstream duplicate search read current PR bodies/diffs on 2026-10-28:

- [#16966](https://github.com/paperclipai/paperclip/pull/16966), OPEN at
  `3803bcb898e1ea73f0a2358f92a1dc1cd6011dae`: closest new-assignment contract and
  fixture prior art. It adds a delivery topic/deadline duty and excludes old skipped
  rows. Do not import wholesale under the no-new-scheduler scope.
- [#17288](https://github.com/paperclipai/paperclip/pull/17288), OPEN at
  `2a972e8287c4e695e9e6924186ed7211fa1889d3`: confirmed reassignment with saved
  comments, not the reproduced no-input review assignment.
- [#15019](https://github.com/paperclipai/paperclip/pull/15019), OPEN at
  `84defd0b25c9b411e8e9c0667b04c41952b01353`: scans historical skipped handoffs
  on scheduler ticks; outside this plan's historical-receipt and timer constraints.

No equivalent merged fix was established. Recheck these exact contracts before
implementation; prefer an equivalent accepted upstream correction when available.
Otherwise contribute the minimal existing-lifecycle fix and regression upstream,
with a separate upstream-master branch and focused fork develop PR. Coordinate
with the existing PR rather than submit its broad machinery as a duplicate.

#113 retains only review-state protection from #116. #89/#90 remain stopped new
capabilities. No expansion of either scope is implied.

After separately reviewed implementation and CI, ops deploys an approved exact
SHA under its own authorization. Synthetic acceptance precedes any separately
approved incident recovery. Capture source-to-successor IDs, real queued/running
and provider output, plus complete before/after review snapshots. Original
business reviewers decide their own work; the existing incident reviewer verifies
recovery independently. Rolling back software must leave unfinished receipts and
review history intact; it does not retract an already admitted successor. Pause
further recovery and assess existing runs rather than replaying or editing receipts.
