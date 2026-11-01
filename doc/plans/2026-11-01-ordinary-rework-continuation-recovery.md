# Ordinary rework continuation after disposition repair

Status: design, pending independent review. Documentation only; no code in this PR.

Tracks phenix3443/paperclip#359.

## 1. Problem

An executor whose task is in native `changes_requested` (the reviewer sent the
work back) could not get back to ordinary rework. The observed run chain on a
single task, in order:

1. A queued `issue_continuation_needed` run for the executor was cancelled
   before start with `errorCode = issue_continuation_waiting_on_review`,
   `timeoutSource = stale_queued_run_gate`.
2. Recovery classified that cancel as `deliberate_wait_without_target` and
   scheduled an owner disposition repair
   (`source = issue.deliberate_wait_disposition_repair`,
   `wakeReason = issue_disposition_repair`, with a `recoveryActionId`). The run
   succeeded.
3. After an explicit `resume: true` comment from the executor, the next run was
   again `issue_disposition_repair` (a new `recoveryActionId`). It was
   interrupted by a graceful server shutdown (`server_shutdown_interrupted`,
   `shutdownSettlement.state = settled`, signal `SIGTERM`).
4. A bounded `transient_failure_retry` (`retryReason = transient_failure`)
   succeeded, but inherited the previous run's `source`, `recoveryActionId` and
   `dispositionRepairInstruction`, and its prompt carried the recovery-only
   contract ("your job is to RECOVER this task, not to do the work").
5. Afterwards `GET /issues/:id/recovery-actions` returned
   `{ active: null, actions: [] }`.

None of these runs was an ordinary rework turn. A successful exit and an empty
recovery projection do not prove recovery. The only installed manual retry,
`POST /issues/:id/retry`, calls `assertBoard(req)` and is not an agent path.

Evidence source: a bounded, read-only diagnosis already performed against the
running instance (task, comments, wake and blocker diagnostics, recovery-action
projection and the four heartbeat runs above). This design reuses that record and
does not re-probe production.

## 2. Version traced

- Installed server: git install `870a6179a5ae`
  (`~/.paperclip/cli/installs/git/870a6179a5ae/node_modules/@paperclipai/server/dist`).
- Source: `phenix3443/paperclip` `develop` at
  `870a6179a5ae5a712468ad56fc00952cecfbf56e`.
- The installed `dist` was checked to contain the same logic quoted below
  (park predicate in `modules/run-dispatch/adapters/postgres.js`, the review-wait
  next action and the `return previousNextAction` carry-over in
  `services/issue-continuation-summary.js`, the `...contextSnapshot` spread in
  `services/heartbeat/retries.js`, and `recoveryStillActive` in
  `services/heartbeat/run-preparation.js`).

Paths below are relative to the repository root at that SHA.

## 3. Mechanism

Each step is marked **Proven (source)** when it follows directly from the code at
the traced SHA and matches the recorded run fields, or **UNKNOWN** when the record
does not let us tell. Nothing here has been reproduced yet; section 5 defines the
synthetic reproduction that must go red first.

### 3.1 A stale review-wait summary parks a rework continuation — Proven (source)

- `server/src/services/issue-continuation-summary.ts`, `inferNextAction`: while
  the issue is `in_review` the summary's Next Action is
  `"Wait for reviewer feedback or approval before continuing executor work."`.
  For any later run that succeeds while the issue is `in_progress`, the function
  returns `previousNextAction ?? ...`, so the review-wait line is **carried
  forward** indefinitely. Nothing refreshes it when the reviewer records
  `changes_requested` and the task returns to the executor.
- `server/src/modules/run-dispatch/adapters/postgres.ts`, `loadStalenessFacts`:
  `continuationParkApplies` is true for an `in_progress` issue, with no wake
  comment and no resolved interaction, when `wakeReason` or `retryReason` is
  `issue_continuation_needed`. It reads the summary and sets
  `continuationParksExecutor = continuationSummaryParksExecutor(body)`
  (regex `WAITING_FOR_REVIEW_OR_APPROVAL_RE` on Next Action).
- `server/src/modules/run-dispatch/domain/policy.ts`,
  `decideQueuedRunStaleness`: when both are true it cancels with
  `issue_continuation_waiting_on_review`, **before** ownership or execution-state
  checks.

Neither the park predicate nor the summary builder consults
`issues.executionState`. With `executionState.status = changes_requested` and the
assignee equal to the executor (`executionState.returnAssignee.agentId`), the authoritative native state
says the executor must work now, but the heuristic summary says wait. The heuristic
wins. This matches step 1.

### 3.2 Recovery turns that cancel into an owner disposition repair — Proven (source)

- `server/src/services/recovery/service.ts`, `classifyContinuationFailure`: the
  error code `issue_continuation_waiting_on_review` always maps to
  `deliberate_wait_without_target`.
- The `in_progress` sweep (the `isUnsuccessfulTerminalIssueRun` branch) first
  tries `resolveContinuationWaitingOnReview` (only succeeds with unresolved
  blockers or open children), otherwise `reconcileDispositionRepair`, which
  creates a `deliberate_wait_without_target` recovery action and
  `scheduleDispositionRepairAttempt` with
  `wakeReason = retryReason = issue_disposition_repair`,
  `source = issue.deliberate_wait_disposition_repair`,
  `bypassContinuationSummaryPark: true` and a `dispositionRepairInstruction`.

This path also ignores `executionState`. It treats a native rework hand-back as a
"deliberate wait without target". This matches step 2.

### 3.3 Repair turns carry a recovery-only prompt contract — Proven (source)

- `server/src/services/heartbeat/run-preparation.ts`: when the context names a
  `recoveryActionId` whose row is `active` or `escalated`, the wake payload gets
  `recovery = { cause, nextAction, ... }`.
- `packages/adapter-utils/src/server-utils.ts`: any non-null `recovery` makes the
  wake `recoveryScoped`, which renders
  `"Recovery contract: your job is to RECOVER this task, not to do the work. Do not produce the deliverable yourself."`
  and a fallback order that starts with "send back to <original assignee>".

For `deliberate_wait_without_target` the owner **is** the original assignee, and
the action's own instruction says "Continue productive work when appropriate". The
rendered contract forbids exactly that. An executor that obeys the contract does
not do the rework, and the summary keeps its carried-forward review-wait line
(3.1), so the source state does not change.

### 3.4 Transient retry inherits the repair context — Proven (source)

`server/src/services/heartbeat/retries.ts` builds the retry context as
`withRecoveryContext({ ...contextSnapshot, retryOfRunId, wakeReason, retryReason, ... }, ...)`.
`withRecoveryContext` only scrubs the status-only guard keys; it keeps
`source`, `recoveryActionId`, `dispositionRepairInstruction`,
`bypassContinuationSummaryPark` and the fingerprint. While the referenced action
is still `active`, 3.3 applies again. This matches step 4 (the retry after the
`SIGTERM`-settled interruption).

### 3.5 Open questions — UNKNOWN

- **What happened to the wake from the `resume: true` comment.** The recorded
  runs do not include a run for that comment, and the next run is a new repair
  attempt with a different action id (fingerprint reset after the source state
  changed). Coalescing into a queued repair run
  (`mergeCoalescedContextSnapshot` keeps `existing` keys the incoming wake does
  not overwrite), deferral behind the repair, or cancellation are all possible.
  Stays UNKNOWN; the regression in section 5 must pin the behavior for the
  synthetic case instead of assuming one.
- **Why the action projection is empty now.** Consistent with the action being
  resolved as covered or superseded after the last successful run, but the
  resolution row was not part of the record. UNKNOWN.

## 4. Proposed correction

All changes correct existing admission and context selection. No new route,
table, column, scheduling mechanism, flag or authority. Native
`executionState` is already the authoritative review state; the fix makes the
existing heuristics defer to it.

Define one predicate, owned by the run-dispatch domain and reused by recovery:

> **Native rework hand-back**: `issue.status = in_progress`,
> `executionState.status = changes_requested`, `executionState.returnAssignee`
> is an agent principal whose `agentId` is the run's agent, and the issue
> assignee is that agent.

### C1. Park admission (`run-dispatch`)

In `loadStalenessFacts`, `continuationParkApplies` is false when the native rework
hand-back predicate holds. The summary heuristic still parks continuations in all
other cases (pending review, approvals, legacy tasks without execution policy).
The pure policy in `policy.ts` is unchanged; only the fact it receives changes.

### C2. Summary next action (`issue-continuation-summary.ts`)

`inferNextAction` must not carry a review-wait Next Action forward once the issue
is no longer `in_review`: if `continuationSummaryParksExecutor(previous)` is true
and the issue is `in_progress`, fall back to the default
"Resume implementation from the acceptance criteria, latest comments, and this
summary." This removes the stale input for every later reader, including legacy
continuations not covered by C1.

### C3. Recovery classification (`recovery/service.ts`)

In the `in_progress` sweep, when the latest run was cancelled with
`issue_continuation_waiting_on_review` **and** the native rework hand-back
predicate holds now, do not create a disposition repair. Use the existing ordinary
continuation path already used by the same sweep
(`enqueueStrandedIssueRecovery` with
`reason = retryReason = issue_continuation_needed`), which C1 now admits. The
existing bounded attempt accounting and escalation still apply. Pending reviews
and non-hand-back states keep today's disposition-repair behavior.

### C4. Retry context selection (`heartbeat/retries.ts`, `run-preparation.ts`)

A retry is a retry of the admitted run, so it may keep the repair context only
while that context is still valid. When building a transient or shutdown retry
from a source run that references a `recoveryActionId`:

- if the action is no longer `active`/`escalated`, or the issue now satisfies the
  native rework hand-back predicate, drop the repair-only keys (`source` reverts
  to the retry's own source, and `recoveryActionId`,
  `dispositionRepairInstruction`, `dispositionRepair*`,
  `bypassContinuationSummaryPark` are removed) and use
  `issue_continuation_needed` admission;
- otherwise keep today's behavior.

`run-preparation.ts` already hides `recovery` for a settled or missing action
(`recoveryStillActive`); C4 makes the retry's admission and wake reason agree with
that.

### C5. Owner repair prompt (`run-preparation.ts`)

For an active `deliberate_wait_without_target` action whose owner is the run's
agent and also the return owner, do not populate `recovery` (which renders the
cross-agent "do not produce the deliverable" contract). Keep the existing
`dispositionRepair` block with the action's instruction. Cross-agent recovery
actions are unchanged.

C1 to C3 fix the reported chain. C4 and C5 stop the same contradiction from
recurring through retries and owner repairs. If independent review judges C5 to be
a behavior change rather than a correction, C5 is dropped from the implementation
scope and returned to the scope decision (section 9); C1 to C4 do not depend on it.

### Where the code goes

Per `rules/heartbeat-execution-boundaries.mdc`: the predicate and C1 live in the
run-dispatch module (`modules/run-dispatch/`), C3 in `services/recovery/`, C4 in
`services/heartbeat/retries.ts`, C5 in `services/heartbeat/run-preparation.ts`.
`heartbeat.ts` does not grow.

## 5. Synthetic regression

Deterministic, embedded test DB, no adapters or network. One synthetic company,
executor agent, reviewer agent, a responsible user, an issue with a review stage
(`maxReviewRounds` null).

Setup sequence (all through existing services, not by writing summary bodies by
hand except where noted):

1. Executor run succeeds while the issue is `in_review` -> summary Next Action is
   the review-wait line.
2. Reviewer records `changes_requested` -> issue `in_progress`, assignee executor,
   `changesRequestedCount = 1`.
3. Queue an `issue_continuation_needed` wake for the executor.

Assertions, red on `870a6179a5ae`, green after the fix:

- **R1 (3.1/C1):** the queued run is admitted, not cancelled with
  `issue_continuation_waiting_on_review`.
- **R2 (C2):** a successful `in_progress` run regenerates the summary without the
  review-wait Next Action.
- **R3 (3.2/C3):** seed a historical cancelled run with
  `issue_continuation_waiting_on_review` as the latest run; the sweep enqueues an
  ordinary `issue_continuation_needed` successor and creates no
  `deliberate_wait_without_target` action.
- **R4 (3.4/C4):** a repair run whose action has been resolved is interrupted with
  a settled `SIGTERM` (`server_shutdown_interrupted`), then a
  `transient_failure_retry` is scheduled; the retry context has no
  `recoveryActionId` or `dispositionRepairInstruction`, and its wake payload has
  `recovery = null`.
- **R5 (3.3/C5):** an owner `deliberate_wait_without_target` repair renders the
  `dispositionRepair` block and no "Recovery contract" line.
- **Invariants after every step:** assignee, stage id, participant id and
  reviewer agent, `executionState.status`, `changesRequestedCount = 1`,
  `lastDecisionId`, the complete decision list, responsible user and
  `executionWorkspace` branch are byte-identical to the snapshot after step 2.

Negative cases (must stay as today):

- **N1 pending review:** `executionState.status = pending` with the reviewer as
  current participant -> executor continuation is still parked/cancelled; no
  ordinary successor.
- **N2 unrelated recovery:** an active cross-agent recovery action (for example
  `successful_run_missing_state`) -> retries keep the recovery context and the
  recovery contract.
- **N3 duplicate and stale requests:** two concurrent sweeps over R3 enqueue at
  most one successor (existing idempotency key); a stale queued repair for an old
  fingerprint is suppressed with `issue_disposition_repair_superseded`.
- **N4 active lease:** when another run holds `executionRunId`/`checkoutRunId`,
  the ordinary successor is not dispatched over it (existing lock rules), and no
  lock is cleared.
- **N5 shutdown retry with live action:** R4 with the action still active and no
  hand-back (for example review pending) keeps the repair context.
- **N6 legacy task without execution policy:** a review-wait summary still parks
  `issue_continuation_needed` as before.

Test files: extend `server/src/modules/run-dispatch/domain/policy.test.ts` and
`adapters/postgres.test.ts`, `server/src/services/explicit-native-continuation.test.ts`
(it already models the park cancel), and a focused recovery test next to
`server/src/services/recovery/`. Run only those vitest files on the host; full
build and typecheck run in CI.

## 6. Ordinary successor evidence

An incident counts as recovered only with all of:

- an actual native entry and its receipt: the heartbeat run id created by the
  sweep or wake path, with `wakeReason`/`retryReason = issue_continuation_needed`
  (or a comment wake) for the executor;
- that run started after the current `changes_requested` decision
  (`lastDecisionId` unchanged) and is bound to the same issue and assignee;
- its context has no `recoveryActionId`, no `dispositionRepair*` keys, and its
  wake payload has `recovery = null` (no "Recovery contract" in the prompt);
- it was not cancelled with `issue_continuation_waiting_on_review`;
- the invariant snapshot from section 5 is unchanged.

A succeeded run, an empty recovery-action projection, or a closed dependency
alone is not evidence.

## 7. Rollout and rollback

1. Implementation PR into `develop`, cross-type independent review of the exact
   head SHA, CI green (build, typecheck, the vitest files above). Upstream PR with
   the same fix against `paperclipai/paperclip` `master` per the fork policy.
2. Source merge is not deployment. Deployment is a separate ops task that pins the
   merged `develop` SHA, records the previous install SHA (`870a6179a5ae` or
   whatever is installed at that time) for rollback, and deploys only that SHA.
3. Rollback: reinstall the recorded previous SHA. No data migration is involved,
   so rollback needs no data change; runs admitted under the new rule simply
   finish.
4. Acceptance: by a member who did not implement or review the fix, on a
   synthetic task on the deployed instance reproducing section 5 steps 1 to 3,
   with the section 6 evidence. The original incident task is not used as a test.
5. Incident recovery is a separate step owned by its original executor under its
   existing gates, after acceptance. It uses only the ordinary native path
   (the executor's comment wake or the sweep) and must produce section 6 evidence.
   No retry, resolve or resume probe, lock, session or summary edit, identity
   change or execution-policy reset is part of it.

## 8. Out of scope

- Any production mutation, deployment or restart from this design task.
- The incident task's own rework (stays with its original executor).
- Changing `POST /issues/:id/retry` authority.
- New recovery-action kinds, routes, tables, flags or scheduling.
- Rewriting the continuation summary format.

## 9. Scope boundary

If implementation shows that C1 to C4 cannot restore an ordinary successor
without a new capability (for example an agent-callable retry entry), it stops and
returns that gap for a scope decision instead of adding the capability in the
fork. The same applies to C5 if review classifies it as new behavior.
