# Isolated dispatch admission and reviewer continuation evidence

Scope: [#228](https://github.com/phenix3443/paperclip/issues/228), following the
[approved plan](https://github.com/phenix3443/ai-team/blob/2cdceef33027ad94bf64fd53009f55b9eb390a9e/docs/paperclip/dispatch-continuation-plan.md).
This change contains tests and this report. It changes no production behavior.

## Versions and isolation

| Item | Identity |
| --- | --- |
| Pinned deployment source | `e8677ce7186364432059edf6a6c4965c27319a38` |
| Execution branch production source | `bb0f9212cab9077bbcb0ac3aa869a4364f6b6304` |
| Existing deferred-owner correction in branch source | `a3e51336ea1f99bede1cccdbe3546df7ac6c495e`, merged [PR #219](https://github.com/phenix3443/paperclip/pull/219) |
| Lockfile SHA-256, both sources | `c7f23021335b60da0cff1dd4c75cf8b948333ef3165d7d1703eb79a589edb798` |
| Tools | Node `v26.12.1`, pnpm `9.15.4`, Vitest `5.0.3` |
| Persistence | Disposable embedded PostgreSQL from the repository test helper; no production database |

The pinned tree was extracted with `git archive` into
`.paperclip/test/pinned-source`. Each tree used its own offline frozen dependency
installation. Only `pnpm --filter @paperclipai/plugin-sdk ensure-build-deps` was
used for dependency artifacts. No full build or typecheck ran on the host.

When `DISPATCH_EVIDENCE_SOURCE_SHA` is set, the test helper compares every blob
in that Git tree with the corresponding file on disk before opening the test
database. Added test files are outside the original tree. The PR head identifies
their reviewed version. An unset source SHA permits ordinary CI tests but makes
no pinned-source evidence claim.

Each JSONL record includes the source SHA, test working directory, isolated
PostgreSQL version/database/port, synthetic company and issue IDs, complete wake
rows and payloads, run rows, and scenario-specific receipts and results. Reviewer
records also include policy, state, decisions, responsible user, and recovery
actions. Evidence archives are attached to the execution task. These fixtures do
not inspect or alter any historical business task or deferred intent.

Synthetic board actors are injected only into an in-process Express test app.
They are not Board credentials. Process positive controls run a local Node
program; the actual-running control uses a file barrier and releases it in
`finally`. Queued, running-row timestamps, a process marker, and terminal success
are separate observations.

## Reproduce

Install the frozen dependencies in each source tree, then prepare the permitted
SDK dependency artifacts. Copy the three evidence test files, `helpers/dispatch-evidence-source.ts`,
`helpers/dispatch-release-process.test.ts` and
`helpers/dispatch-admission-process.test.ts` into the pinned tree at the same paths.
Run from the pinned tree:

```sh
DISPATCH_EVIDENCE_SOURCE_SHA=e8677ce7186364432059edf6a6c4965c27319a38 \
DISPATCH_EVIDENCE_EXPECT_DEFERRED_OWNER=stalled \
DISPATCH_EVIDENCE_FILE="$TMPDIR/pinned.jsonl" \
timeout 600 pnpm exec vitest run \
  server/src/__tests__/dispatch-admission-evidence.test.ts \
  server/src/__tests__/reviewer-continuation-evidence.test.ts \
  server/src/__tests__/dispatch-release-evidence.test.ts
```

Run the same files from the execution branch with its production source SHA and
without `DISPATCH_EVIDENCE_EXPECT_DEFERRED_OWNER=stalled`. That source already
contains #219; its green result cannot establish the deployed source behavior.

Two explicit oracles preserve assumptions that fail on the pinned source:

```sh
DISPATCH_EVIDENCE_SOURCE_SHA=e8677ce7186364432059edf6a6c4965c27319a38 \
DISPATCH_EVIDENCE_ORACLE=unique-key \
timeout 600 pnpm exec vitest run \
  server/src/__tests__/dispatch-admission-evidence.test.ts \
  -t 'terminal receipt redelivery'

DISPATCH_EVIDENCE_SOURCE_SHA=e8677ce7186364432059edf6a6c4965c27319a38 \
DISPATCH_EVIDENCE_EXPECT_DEFERRED_OWNER=stalled \
DISPATCH_EVIDENCE_ORACLE=queued-owner \
timeout 600 pnpm exec vitest run \
  server/src/__tests__/dispatch-release-evidence.test.ts \
  -t 'old owner is queued'
```

Expected oracle exit code: **1**. Passing characterization is not a passing
exactly-once or eventual-execution oracle. The `stalled` expectation is for the
pinned source only; it does not implement a recovery path.

## Native dispatch findings

| Case | Observable boundary and assertion | Classification |
| --- | --- | --- |
| D1 | HTTP assignment behind an old queued execution produces a complete persisted deferred payload. Normal native release of an accepted assignment binds one queued target run. The running-owner HTTP control cancels the old owner and starts the target. | Existing normal-release guarantee holds; queued acceptance alone is not start evidence. |
| D2 | HTTP reassign, then `resumeQueuedRuns`: the stale old queued run is cancelled by `issue_assignee_changed`. On the pin, the target receipt remains deferred with no run. | Existing release/admission owner defect on the pin; separately compare #219 in branch source. |
| D3 | Ordinary user comment and native HTTP confirmation accept both retain their continuation context through real release. Eligible reviewer intent binds the original reviewer. A Node process marker proves the separate running control. | Positive controls; queued controls do not establish provider execution. |
| D4 | Cancelled task, manual agent pause, unresolved dependency, subtree pause, and active execution recovery action admit no task run. A paused target's accepted payload survives release. | Legitimate gates; synthetic explicit source release after eligibility restoration is separate from automatic notification. |
| D5 | Failure after native transactional work but before commit rolls back promotion. Lost committed response, reconstructed adapters and simultaneous duplicate release bind one successor. | Persistence/transaction control. An independent worker exits before release commit; a fresh worker promotes the same retained intent against the same isolated database. |
| D6 | Two eligible issues for one company and one target agent drain under `maxConcurrentRuns=1`. Each original receipt binds a started successful run. | Bounded two-issue fairness control; no sustained-load claim. |

The D2 owner is `heartbeat/queue.ts` stale dispatch cancellation, together with
the native execution release/admission owner. A restricted stranded-comment
selector alone is not the diagnosis. The receipt was created by HTTP, the old
run was cancelled by the native gate, and the target receipt remained reachable
but unpromoted. The smallest candidate is admission of that accepted current
owner receipt at the existing end event. #219 already changes that owner in the
branch baseline. This PR neither recreates nor modifies its correction.
Upstream applicability of that fork-specific path is not established here; no
new upstream feature or runtime PR is justified by this evidence-only task.

## SDK findings

The tests call `buildHostServices().issues.requestWakeup`, real heartbeat
admission, and real PostgreSQL. They do not use the SDK in-memory test harness.

| Input | Evidence and limit |
| --- | --- |
| Repeated or simultaneous queued request | Same run association while the eligible task remains queued. This is coalescing, not a generic durable key fence. |
| Actual running process | A file marker proves provider startup before the repeated host call. The record preserves both responses. |
| Scheduled retry | A matching synthetic persisted retry row is recognized. Delivery of the timer itself is outside this assertion. |
| Deferred | `queued:false/runId:null` is recorded separately from the persisted deferred request. The response alone does not prove retention. |
| Terminal key redelivery | Two receipts with the same ordinary plugin key bind different admitted runs. Their terminal transition is synthetic; two provider executions are not claimed. The unique-key oracle fails. |
| Response loss | Host reconstruction and a separate accepting-worker exit/restart scenario inspect the existing queued receipt. This tests native queued coalescing after process loss; it does not add a generic durable-key fence. |
| Owner/submission race | A real owner and description update occurs between SDK preflight and the first native transaction. The obsolete agent can still receive a queued run. No expected-owner/submission argument exists in this SDK request. |

Generic key uniqueness and expected-state SDK admission would be additional
capabilities. This report does not classify their absence as an upstream bug.
A second barrier updates the real pending reviewRequest between SDK preflight
and native transaction admission. Its reviewer-assignment generation changes,
yet the ordinary SDK wake queues without binding the prior generation. This is
missing expected-submission admission, separate from the protected native
reviewer-assignment intent. It is not a concurrent edit to a GitHub submission.
Do not resend a wake based only on an unchanged ordinary key or a preflight read.

## Reviewer findings

Started quota failure and pre-start `agent_paused` failure are distinct synthetic
rows. Both pass through real native no-replay settlement. The resulting resolved
action retains `reviewHoldBlock`; making the reviewer idle does not authorize
another turn. Intent creation refuses the blocked task, and the effective
execution blocker remains. Policies, pending state, two historical decisions,
count, original reviewer and return owner, and responsible user remain unchanged.

A paused assignment without a matching durable intent does not gain an outbox
when the reviewer becomes idle. A matching intent remains held during manual or
unknown pause. Stale submission, return owner, participant, responsible user or
decision retires the old intent without rewriting the changed turn or history.
The eligible original-reviewer control binds one queued successor across two
service instances. A separate matching-intent control pauses for quota, records
the held receipt, explicitly restores eligibility in the fixture and advances
the retry deadline clock. Reconciliation then binds that same receipt to one
original-reviewer queued successor, preserving policy and history. This does not
certify an automatic quota-release notification. An eligible legacy cancelled/issue_reassigned decided-review
projection also continues through its existing native owner. Its retained receipt
remains intact. A nine-case matrix exercises that owner with stale statusVersion,
stage, decision, receipt source, action source, participant, return owner, assignee
and unrelated resolved action. Each asserts its exact native refusal, no new run
and unchanged task/history/actions. The verified pre-start-cancelled route
positive control is run separately at the same pin.

The missing resolved-hold continuation entry remains **missing capability**.
`createReviewerAssignmentIntent` requires `in_review` and a matching executor
source; it cannot consume a resolved no-replay hold. `settleUnrecoverableExecutions`
settles disposition, while `getExecutionBlocker` preserves replay refusal.
No action, hold receipt, count, policy or pause was cleared on a real task.
Extending eligibility or recovery authority requires a separate decision.

## Verification ledger

Final commands, exit codes, evidence hashes and inspection results are recorded
in the PR and the attached archive manifest. The initial queue command failed
with exit 254 because dependencies were absent. After offline installation it
failed at import because SDK artifacts were absent. After the permitted
dependency preparation, the existing queue suite passed 33 tests at both source
versions. These setup failures are not dispatch-oracle failures. The earlier nine-test
positive-control selection also logged `CONNECTION_ENDED` during queued work
after database teardown. Its exit-zero suite result is not evidence of clean
shutdown. That log is retained; this test-only PR does not claim to fix it. The
new evidence suites drain active executions before closing their database.

Early fixture failures are retained in the evidence ledger: a stub event bus
lacked `clear`; the first process control lacked its synthetic auth user; paused
reviewer admission threw a 409 rather than returning null; an initial running
comparison used a synthetic row without live process evidence; and the first
deferred SDK fixture incorrectly used the same agent as lock holder. The final
running control uses a real process barrier, and the deferred control uses a
separate execution owner. These failures are not accepted as production bugs.

The first worker-restart fixtures used `process.exit(73)`. Author self-review
found that Vitest 5.0.3 intercepts that call and throws; those green checks
proved exception rollback and host reconstruction, not an OS process crash.
Their logs remain in the archive and their crash claim is withdrawn. The final
fixtures synchronously write a fault marker, kill their own worker with
`SIGKILL`, and check that its `finally` marker never ran before a fresh worker
reuses the same isolated database. Supervisor errors are retained in each
JSONL fault record. A failed initial copy command used the pinned directory as
its own source root; the paths were corrected before final reproduction.

No natural incident was replayed. No provider quota reset, live reviewer
recovery, automatic gate-release notification, or
exact SDK review-revision CAS is certified. Full typecheck/build and required
broader checks belong to PR CI. Independent review must target the exact pushed
test/report head before any merge; this evidence does not authorize deployment.
