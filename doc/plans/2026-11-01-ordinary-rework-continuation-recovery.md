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

- `server/src/services/heartbeat/run-preparation.ts` (wake payload build,
  around the `recoveryStillActive` computation): when the context names a
  `recoveryActionId` whose row is `active` or `escalated`, the wake payload gets
  `recovery = { cause, nextAction, ... }`. When the context has **no**
  `recoveryActionId` but still has a `recoveryCause`, `recoveryStillActive` is
  also true (`!recoveryActionId && Boolean(recoveryCause)`), so a leftover
  `recoveryCause` alone re-activates the contract.
- `packages/adapter-utils/src/server-utils.ts`: any non-null `recovery` makes the
  wake `recoveryScoped`, which renders
  `"Recovery contract: your job is to RECOVER this task, not to do the work. Do not produce the deliverable yourself."`
  and a fallback order that starts with "send back to <original assignee>".
- The same payload has a `dispositionRepair` block, but it is built only by
  `buildReviewPathRecoveryDisposition(context)` (review-path recovery runs) or
  when `context.legacyDispositionEpisode` is set. `scheduleDispositionRepairAttempt`
  writes `legacyDispositionEpisode` only for legacy episodes. For an ordinary
  (non-legacy) owner repair the block is `null`, so the action's own instruction
  ("... Continue productive work when appropriate.") is **not rendered**. The
  executor sees only the recovery contract.

For `deliberate_wait_without_target` the owner **is** the original assignee. The
rendered contract forbids the rework, and nothing in the prompt asks for it. An
executor that obeys the contract does not do the rework, and the summary keeps its
carried-forward review-wait line (3.1), so the source state does not change.

### 3.4 Transient retry inherits the repair context — Proven (source)

`server/src/services/heartbeat/retries.ts` builds the retry context as
`withRecoveryContext({ ...contextSnapshot, executionRetryAccounting, retryOfRunId, wakeReason, retryReason, ... }, ...)`.
`withRecoveryContext` (`services/recovery/status-only-context.ts`) only scrubs the
status-only guard keys. It keeps `source`, `recoveryActionId`, `recoveryCause`,
`dispositionRepairInstruction`, `dispositionRepairAttempt`,
`dispositionRepairMaxAttempts`, `dispositionRepairFingerprint`,
`dispositionRepairSourceRunId`, `legacyDispositionEpisode` and
`bypassContinuationSummaryPark`. While the referenced action is still `active`,
3.3 applies again. This matches step 4 (the retry after the `SIGTERM`-settled
interruption).

### 3.5 The existing owner-repair continuation entry — Proven (source) and UNKNOWN

The traced SHA already has a native ordinary successor for a completed owner
repair, in `services/recovery/service.ts` and
`services/recovery/owner-repair-continuation.ts` (all present in the installed
`dist`):

- Entry points: `settleCompletedOwnerRepairRun` (completion event of the repair
  run) and the action sweep `reconcileActiveRecoveryActions`, which calls
  `reconcileCompletedOwnerRepair` for every active action with
  `wakePolicy.type = bounded_owner_disposition_repair`.
- Admission (`isCompletedScheduledOwnerRepair`): the action is `active`, owner
  type agent, `ownerAgentId = returnOwnerAgentId = run.agentId`, and the run is
  **exactly** `wakePolicy.scheduledRunId`, has `recoveryActionId = action.id`,
  `retryReason = issue_disposition_repair`, and `status = succeeded`.
- Settlement gates (`reconcileCompletedOwnerRepair`): a durable terminal
  settlement event for the run, execution released for the issue, and no
  unknown-effect recovery action for that run. Otherwise `pending_settlement`.
- Reservation (`reserveOwnerRepairContinuation`, under the issue and action row
  locks): `fallback` when `collectDispositionRepairSourceState` finds a durable
  waiting path or an active execution path (any active run or any queued or
  deferred ordinary wake for the issue); `waiting` for a pause hold, a
  non-invokable owner, wake-on-demand off, or invocation budget; `stale` when
  `statusVersion`, assignee, issue binding, fingerprint, owner or scheduled run
  changed. A `changes_requested` hand-back is **not** a durable waiting path
  (only `executionState.status = pending` is), so it does not block this entry.
- Delivery (`deliverOwnerRepairContinuation`): one `enqueueWakeup` with
  `reason = wakeReason = owner_repair_continuation`,
  `source = recovery.owner_repair_continuation`, idempotency key
  `settlement.continuationKey`, a durable request receipt, and no
  `recoveryActionId`. Its receipt is the `agent_wakeup_requests` row with that
  key; the action is resolved `restored` with note
  `owner_repair_continuation_admitted`, or cancelled with
  `owner_repair_continuation_denied`.

This successor is an ordinary turn: its wake reason is not
`issue_continuation_needed`, so the park in 3.1 does not apply, and its context
has no `recoveryActionId` or `recoveryCause`, so `recovery = null`.

What the record proves for the incident:

- **Action of step 3/4 — Proven (source).** The scheduled repair run of that
  action was the step-3 run, which ended `interrupted`. The successful step-4 run
  is a different run id with `retryReason = transient_failure`. Both admission
  conditions (`scheduledRunId = run.id` and
  `retryReason = issue_disposition_repair`) fail, so this entry can never fire
  for that action. The transient retry breaks the only existing ordinary
  successor of an owner repair. C4 addresses this.
- **Action of step 2 — UNKNOWN.** Its scheduled run succeeded, so the entry was
  eligible in principle. The record has no `owner_repair_continuation` run and
  no settlement evidence. Any of these gates could explain it: no durable
  settlement event yet; execution not released; `fallback` because the
  `resume: true` comment wake was queued (active execution path, then the
  ordinary reconciliation resolves the action as covered); or `stale` after a
  status change. The action row and its `ownerRepairSettlement` evidence were
  not part of the record, so this stays UNKNOWN. Section 5 (R6, R7) pins the
  entry's behavior in the synthetic case instead.

### 3.6 Open questions — UNKNOWN

- **What happened to the wake from the `resume: true` comment.** The recorded
  runs do not include a run for that comment, and the next run is a new repair
  attempt with a different action id (fingerprint reset after the source state
  changed). Coalescing into a queued repair run
  (`mergeCoalescedContextSnapshot` keeps `existing` keys the incoming wake does
  not overwrite), deferral behind the repair, or cancellation are all possible.
  It is linked to the step-2 UNKNOWN in 3.5. Stays UNKNOWN; section 5 pins the
  synthetic behavior instead of assuming one.
- **Why the action projection is empty now.** Consistent with the action being
  resolved as covered or superseded after the last successful run, but the
  resolution row was not part of the record. UNKNOWN.

## 4. Proposed correction

All changes correct existing admission and context selection. No new route,
table, column, scheduling mechanism, flag or authority. Native
`executionState` is already the authoritative review state; the fix makes the
existing heuristics defer to it.

Define one predicate, owned by the run-dispatch domain and reused by recovery and
retries:

> **Native rework hand-back**: `issue.status = in_progress`,
> `executionState.status = changes_requested`, `executionState.returnAssignee`
> is an agent principal whose `agentId` is the run's agent, the issue
> assignee is that agent, and `issue.assigneeUserId` is null.

### C1. Park admission (`run-dispatch`)

In `loadStalenessFacts`, `continuationParkApplies` is false when the native rework
hand-back predicate holds. The summary heuristic still parks continuations in all
other cases (pending review, approvals, legacy tasks without execution policy).
The pure policy in `policy.ts` is unchanged; only the fact it receives changes.
Because the facts are loaded at dispatch time, this is also the final re-check
for C3: if review state changed after enqueue, the run is parked as today.

### C2. Summary next action (`issue-continuation-summary.ts`)

`inferNextAction` must not carry a review-wait Next Action forward once the issue
is no longer `in_review`: if `continuationSummaryParksExecutor(previous)` is true
and the issue is `in_progress`, fall back to the default
"Resume implementation from the acceptance criteria, latest comments, and this
summary." This removes the stale input for every later reader, including legacy
continuations not covered by C1.

### C3. Recovery classification (`recovery/service.ts`)

Where: the `isUnsuccessfulTerminalIssueRun(latestRun)` branch of the
`in_progress` sweep, inside the existing
`classification.errorCode === CONTINUATION_WAITING_ON_REVIEW_ERROR_CODE` block,
**after** `resolveContinuationWaitingOnReview` (blockers and open children keep
their path) and **before** `reconcileDispositionRepair`. It applies only when the
hand-back predicate holds on the swept issue row. All other states keep today's
disposition repair.

Call contract (one ordinary successor, no disposition repair action):

| Field | Value |
|---|---|
| entry | `enqueueStrandedIssueRecovery` |
| `reason`, `retryReason` | `issue_continuation_needed` |
| `source` | `issue.rework_handback_continuation_recovery` (a new value of the existing `source` string, not a new mechanism) |
| `retryOfRunId` | the cancelled park run (`latestRun.id`), kept for lineage |
| `issueStateGuard` | `{ statuses: ["in_progress"], assigneeAgentId, statusVersion: issue.statusVersion }` |
| `idempotencyKey` | `issue_rework_handback_continuation:<issueId>:<lastStatusDecisionId>:<statusVersion>:<latestRun.id>` |
| `allowRunCoalescing` | `false` (the successor is its own run, never folded into another turn) |

Branch inside `enqueueStrandedIssueRecovery`: today a cancelled predecessor with
`retryOfRunId` enters the failure-retry lane and never reaches the ordinary
enqueue. In order, that lane (`recovery/service.ts:2048-2088`) returns `null` for
a `native` predecessor, terminalizes a legacy execution that needs
reconciliation, and otherwise calls `scheduleRecoveryRetry`. A park cancel is not
a failure: the run never started. C3 adds one exclusion, placed **after** the
`native` early return and the legacy reconciliation check and **before**
`scheduleRecoveryRetry`: when `source = issue.rework_handback_continuation_recovery`,
the predecessor is `cancelled`, its `errorCode = issue_continuation_waiting_on_review`,
and `startedAt` is null, skip `scheduleRecoveryRetry` and go to the ordinary
enqueue. A `native` predecessor therefore still returns `null`; a predecessor that
started, or any other source, keeps today's lane (N7).
`enqueueStrandedIssueRecovery` gains three optional inputs (`issueStateGuard`,
`idempotencyKey`, `allowRunCoalescing`) that it passes through to the existing
`enqueueWakeup` options; today it sets the guard only for
`issue.productive_terminal_continuation_recovery` and passes no key.

Locking and re-checks: every issue-scoped admission in `enqueueWakeup` takes the
issue row lock (`select ... from issues ... for update`, `heartbeat/queue.ts:3026`)
in the same transaction that later inserts the wake row (`queue.ts:4596-4628`).
`issueStateGuard` is evaluated under that lock. `statusVersion` changes on status
and assignee changes, so a resubmission or reassignment after the sweep read
denies the enqueue. A `executionState` change that does not bump `statusVersion`
is caught by C1 at dispatch. An active execution (N4) is handled by the queue's
existing issue execution lock: the wake is deferred (`deferred_issue_execution`),
not run over the lease, and no lock is cleared.

Deduplication. Storing a key does not deduplicate on this path: the generic
enqueue inserts a row (`queue.ts:4596-4628`, and the Postgres wake-queue adapter
inserts one when coalescing), and no partial unique index in
`agent_wakeup_requests` covers this prefix. C3 does not add an index, table or
scheduler. It reuses the pattern the queue already applies to
`execution-reconciliation:` keys (`queue.ts:3578-3617`): an existing-key lookup
inside the issue-locked transaction. Because all admissions for one issue
serialize on that row lock, the lookup and the insert are atomic per issue.

For a wake whose key starts with `issue_rework_handback_continuation:`, the queue,
inside the issue-locked transaction and **before** the state guard:

1. Validates the request shape: `source = automation`, `triggerDetail = system`,
   `reason = issue_continuation_needed`, `requestedByActorType = system`,
   `payload.issueId` and `contextSnapshot.issueId` equal the locked issue,
   `contextSnapshot.retryOfRunId` equals the run id in the key, and
   `allowRunCoalescing = false`. Otherwise the wake is skipped without a row.
2. Looks up rows with `ordinaryWakeRequestPredicate()`, the same `companyId`,
   `agentId` and `idempotencyKey`, any status, oldest first.
3. If a row exists, it never inserts another:
   - **bound row** (`runId` set): it loads that run and checks company, agent,
     `contextSnapshot.issueId`, `retryOfRunId` and `wakeReason`. A match returns
     `replayed` with that run, whatever the run's status now (queued, running,
     succeeded or cancelled). A mismatch returns `skipped`.
   - **deferred row** (`deferred_issue_execution`, no run): returns `deferred`.
     The existing release path (`resumeQueuedRuns`) promotes that receipt; no
     second receipt is created.
   - **terminal row without a run** (for example the `issue_state_guard_mismatch`
     `skipped` row, or `failed`/`cancelled`): returns `skipped`. The key is spent.
4. Only with no row does it continue to the state guard and the normal insert.
   A guard mismatch then writes the existing `skipped` receipt with this key,
   which spends the key.

Retry semantics. The key contains `statusVersion`, so a key spent by a guard
denial can only be followed by a new key after a real status or assignee change,
which a sweep cannot cause. If the issue later satisfies the hand-back predicate
again for the same decision, the new `statusVersion` gives a new key, and each
resulting run is still counted by the ledger below. A replay after a lost response
(first commit succeeded, caller saw an error or timeout) returns the same run and
writes nothing, so it does not count against the ledger or the transient budget.
A key that is spent with no run must lead to escalation, not to waiting; the
result contract below is how the sweep tells that apart from a valid deferral.

Result contract (queue -> recovery helper -> sweep). The `replayed`, `deferred`
and `skipped` kinds above are internal to `enqueueWakeup`. At its public boundary
`deferred` and `skipped` both become `null` (`heartbeat/queue.ts:4847-4848`), and
`RecoveryWakeup` returns `HeartbeatRun | null` (`recovery/service.ts:258-261`).
C3 does not change either signature, so no existing caller changes. Instead it
reuses the out-parameter that `enqueueStrandedIssueRecovery` already has for this
purpose (`outcome?: { retryExhausted?: boolean }`, `recovery/service.ts:2040-2046`,
consumed today by the review lane at `5786-5821`) and adds one optional field:

```ts
outcome?: {
  retryExhausted?: boolean;
  continuationReceipt?: "bound" | "waiting" | "spent" | "absent";
};
```

The helper sets `continuationReceipt` only for
`source = issue.rework_handback_continuation_recovery`, only when
`deps.enqueueWakeup` returned `null`, and only by reading the receipt for the
exact key it sent: rows with `ordinaryWakeRequestPredicate()`, the same
`companyId`, `agentId` and `idempotencyKey`. Every other source leaves the field
unset, and callers that do not pass `outcome`, or ignore the new field, behave as
today.

| Receipt rows for the key (read after `null`) | `continuationReceipt` | Sweep action |
|---|---|---|
| a row with `runId` set (a deferral promoted between the return and the read) | `bound` | count as requeued; no escalation, no new attempt |
| a row without `runId` in `deferred_issue_execution` (active lease, N4), or an execution-reconciliation wait that carries the key | `waiting` | skip; the existing release path (`resumeQueuedRuns`) or recovery action owns it; no escalation |
| only rows without `runId` in a terminal status (`skipped`, including `issue_state_guard_mismatch`, `failed`, `cancelled`) | `spent` | re-read `hasActiveExecutionPath(companyId, issueId, null)`; if no live path, escalate with `escalateStrandedAssignedIssue` (same call and notice as the ledger exhaustion below); otherwise skip |
| no row | `absent` | skip without escalation; nothing was written (a shape rejection, or an admission rolled back on lock contention, `55P03`, which `enqueueWakeup` maps to `deferred` at `queue.ts:4830-4833`), so the key is not spent and the next sweep retries it |

A non-null return needs no read: it is either a new run or a replay of the run
bound to the key, and the sweep counts it as requeued. A replay is not a new
attempt: it adds no row and no run, so the ledger, which counts runs, does not
move.

Why the read is safe after the transaction: under the issue lock a key gets at
most one row (step 3), and that row only moves forward: `deferred` to bound or to
terminal, never back. The read therefore sees the outcome's state or a later one,
and either is correct to act on. The `spent` case is the only one that writes,
and it repeats the live-path read the review lane already does before escalating.
`allowRunCoalescing = false` matters here too: with it the wake queue never merges
the request into another deferred row
(`modules/wake-queue/application/use-cases.ts:943-958`), so an active-lease
deferral always inserts its own row carrying the key (`insertNewDeferredWake`,
`adapters/postgres.ts:1211-1225`), and `waiting` is never misread as `absent`.

The helper builds the request itself, so a shape rejection is a programming
error; R3c asserts the helper's own request passes step 1, and `absent` is
otherwise only the transient rollback case.

Coalescing. `allowRunCoalescing = false` (the same setting owner-repair
continuations and case handoffs use) means the wake never merges into another
queued or running turn. Its receipt is always bound to its own run or to its own
deferred row, so the receipt proves an independent ordinary successor (section 6).

Bounded attempts: the ledger is the one this sweep already uses for the same
error code in the accepted-interaction branch:
`summarizeRecentContinuationRetries(companyId, issueId, agentId, CONTINUATION_WAITING_ON_REVIEW_ERROR_CODE)`
counts consecutive `issue_continuation_needed` runs cancelled with this code. When
`consecutive >= INTERACTION_CONTINUATION_REQUEUE_MAX_ATTEMPTS` (3), C3 does not
enqueue; it escalates with the existing `escalateStrandedAssignedIssue`. Ordinary
successors carry `retryReason = issue_continuation_needed`, so a successor that is
parked again counts against the same ledger. The transient retry budget
(`executionRetryAccounting`) is not touched, because the failure lane is not used.

### C4. Retry context selection (`heartbeat/retries.ts`)

A retry is a retry of the admitted run, so it keeps the repair context only while
that context is still valid. The change is limited to the owner disposition
repair of this fault. When `scheduleBoundedRetryForRun` builds a retry from a
source run whose context has a `recoveryActionId`, it loads that action and
checks **all** of:

- `action.companyId` and `action.sourceIssueId` equal the run's company and
  issue;
- `action.cause = deliberate_wait_without_target` and
  `wakePolicy.type = bounded_owner_disposition_repair`;
- `action.ownerAgentId = action.returnOwnerAgentId = run.agentId`;
- and either the action is no longer `active`/`escalated`, or the issue now
  satisfies the native rework hand-back predicate.

Only then the retry context drops the repair-only keys: `recoveryActionId`,
`recoveryCause`, `dispositionRepairInstruction`, `dispositionRepairAttempt`,
`dispositionRepairMaxAttempts`, `dispositionRepairFingerprint`,
`dispositionRepairSourceRunId`, `legacyDispositionEpisode`,
`bypassContinuationSummaryPark`. `source` becomes
`issue.rework_handback_continuation_recovery`. `wakeReason` and `retryReason`
stay the retry's own (`transient_failure_retry` / `transient_failure`).
`executionRetryAccounting`, `retryOfRunId`, `scheduledRetry*`, the issue and
workspace binding stay as today, so the retry budget and the original execution
authority are unchanged.

Any other referenced action keeps today's behavior. That includes a
cross-agent action, an action of another cause or issue, and a still-active
owner repair without a hand-back.

No `recoveryActionId`. A retry whose context has a `recoveryCause` but no
`recoveryActionId` re-activates recovery through the fallback in 3.3. Provenance
(`dispositionRepairFingerprint` with `source = issue.deliberate_wait_disposition_repair`)
only shows the context came from an owner repair; it does not show the repair is
no longer valid. Without an action id there is no exact action whose state could
prove that, so C4 does not try to infer invalidity from other recovery rows.
The fallback drops the same key list only when **all** of these hold:

- the context has `recoveryCause = deliberate_wait_without_target`,
  `source = issue.deliberate_wait_disposition_repair` and a
  `dispositionRepairFingerprint`;
- the context has no `legacyDispositionEpisode` (a legacy repair keeps its context);
- the source run's company, issue and agent equal the retry's, and the agent is
  the issue assignee;
- the issue row that `scheduleBoundedRetryForRun` already loads
  (`heartbeat/retries.ts:452-457`, extended to also select `executionState` and
  `assigneeUserId`) satisfies the native rework hand-back predicate now, which
  excludes a pending review.

If any of these fails, the retry keeps today's context. C1 re-reads the same
facts at dispatch, so a hand-back that ends between scheduling and dispatch parks
the retry as today.

C4 does not resolve the action. A still-active action is left to the existing
action sweep, which sees the retry as an active execution path and resolves it as
covered. Proof is the final wake payload (`recovery = null`, no
`dispositionRepair` block) and the run context, not the action projection.

### Not in scope: owner repair prompt (former C5)

3.3 shows that a non-legacy owner repair renders only the recovery contract and
not its own instruction. Fixing that would change the `dispositionRepair`
generation condition in `run-preparation.ts` for all non-legacy owner repairs.
That is new prompt behavior for cases outside this fault. With C3 a rework
hand-back no longer creates an owner repair, and with C4 its retries no longer
carry one, so C1 to C4 do not need it. It is removed from this design and
returned for a scope decision (section 9).

### Where the code goes

Per `rules/heartbeat-execution-boundaries.mdc`: the predicate and C1 live in the
run-dispatch module (`modules/run-dispatch/`), C2 in
`services/issue-continuation-summary.ts`, C3 in `services/recovery/service.ts`,
C4 in `services/heartbeat/retries.ts`, and the C3 key lookup in
`services/heartbeat/queue.ts` next to the existing `execution-reconciliation:`
lookup. The `continuationReceipt` read and its type stay in
`services/recovery/service.ts`; `enqueueWakeup` and `RecoveryWakeup` keep their
signatures. `heartbeat.ts` does not grow.

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
- **R3 (3.2/C3):** seed a never-started run cancelled with
  `issue_continuation_waiting_on_review` as the latest run. The sweep creates no
  `deliberate_wait_without_target` action and queues exactly one wake with the
  C3 contract: `reason = retryReason = issue_continuation_needed`,
  `source = issue.rework_handback_continuation_recovery`, `retryOfRunId` = the
  cancelled run, the C3 idempotency key. The run's `executionRetryAccounting` is
  unchanged and `scheduleRecoveryRetry` is not called.
- **R3b (C3 ledger):** with three consecutive park cancels in the ledger, the
  sweep escalates and queues nothing.
- **R3c (C3 dedup, real queue and DB):** against the embedded DB and the real
  `enqueueWakeup` and wake-queue adapter (no mocked queue):
  - two concurrent sweeps (`Promise.all`) over the R3 state leave exactly one
    `agent_wakeup_requests` row with the C3 key and one `heartbeat_runs` row with
    that `retryOfRunId`; both calls return that run;
  - lost response: after the first call commits, a second call with the same
    inputs returns the same run and adds no row. Repeat after the run has
    succeeded and after it has been cancelled: still the same run, no new row;
  - with another queued executor run for the issue, the C3 run is a separate run
    (`allowRunCoalescing = false`) and its receipt's `runId` is that run;
  - with an active execution lease, the first call writes one
    `deferred_issue_execution` row; a second call returns `deferred` and adds
    nothing; after release the existing promotion binds that same row to one run;
  - a guard denial writes one `skipped` row; a second call with the same key adds
    nothing and the sweep escalates; after a real assignee round-trip
    (`statusVersion` changed) the new key admits one run;
  - in every case the ledger count, `executionRetryAccounting` and the transient
    budget are the same as after a single successful call.

  The kind returned inside the queue does not cross the public interface, so the
  following cases drive the whole chain: the real recovery sweep (the C3 branch),
  `enqueueStrandedIssueRecovery`, the real `enqueueWakeup` and the embedded DB.
  Assertions are on the sweep result, the issue row and the DB rows, not on the
  queue's internal kind:
  - **deferred does not escalate:** with an active execution lease, two sweeps in
    a row leave `continuationReceipt = waiting`, one `deferred_issue_execution`
    row, the issue still `in_progress` with no escalation notice and no
    `escalated` count; after the lease is released the existing promotion gives
    exactly one successor run bound to that row, and a third sweep sees `bound`
    (or the run) and adds nothing;
  - **spent escalates:** a guard denial spends the key; with no other live path
    the next sweep sees `spent` and escalates once through
    `escalateStrandedAssignedIssue`; with another live run for the issue it sees
    `spent`, re-reads the live path and does not escalate;
  - **replay is not a new attempt:** after a first sweep queues the run, a second
    sweep with the same key gets the same run back (non-null), the ledger count
    from `summarizeRecentContinuationRetries` is unchanged and the sweep does not
    count a second requeue toward R3b's limit;
  - **absent:** an admission rolled back on lock contention (`55P03`; if the
    embedded DB cannot reproduce it deterministically, the wake-queue adapter
    throws that code once) leaves no row, `continuationReceipt = absent`, no
    escalation, and the next sweep admits one run with the same key;
  - **compatibility:** an existing lane that passes `outcome` (the review lane)
    still sees only `retryExhausted`, with `continuationReceipt` unset.
- **R4 (3.4/C4):** a repair run whose action has been resolved is interrupted with
  a settled `SIGTERM` (`server_shutdown_interrupted`), then a
  `transient_failure_retry` is scheduled. The retry context has none of the C4
  key list, keeps `executionRetryAccounting` and `retryOfRunId`, and its prepared
  wake payload has `recovery = null`, `dispositionRepair = null`, and no
  "Recovery contract" line in the rendered prompt.
- **R4b (C4 hand-back, action still active):** same as R4 with the owner repair
  action still `active` and the hand-back predicate true. Same assertions; the
  action is then resolved by the existing action sweep as covered, not by C4.
- **R5 (3.3, pin only):** an ordinary non-legacy owner repair renders a non-null
  `recovery` and `dispositionRepair = null`; a legacy owner repair renders the
  `dispositionRepair` block. Unchanged by this design; the test records the
  behavior that former C5 would change.
- **R6 (3.5, pin):** a completed scheduled owner repair with no hand-back and no
  other path delivers one `owner_repair_continuation` wake with its continuation
  key, and the action is resolved `owner_repair_continuation_admitted`. Unchanged.
- **R4c (C4 fallback positive):** the retry's source context has no
  `recoveryActionId`, has `recoveryCause = deliberate_wait_without_target`, the
  repair source and fingerprint, no `legacyDispositionEpisode`, and the issue
  satisfies the hand-back predicate. The retry context has none of the C4 key
  list, the prepared wake payload has `recovery = null` and
  `dispositionRepair = null`, and the rendered prompt has no "Recovery contract"
  line. Asserting the deleted keys alone does not pass this case.
- **R7 (3.5 + C4):** an owner repair whose scheduled run is interrupted and whose
  transient retry succeeds produces no `owner_repair_continuation` (unchanged
  admission). After C4 under a hand-back the retry itself is the ordinary turn
  (R4b assertions).
- **Invariants after every step:** assignee, stage id, participant id and
  reviewer agent, `executionState.status`, `changesRequestedCount = 1`,
  `lastDecisionId`, the complete decision list, responsible user and
  `executionWorkspace` branch are byte-identical to the snapshot after step 2.

Negative cases (must stay as today):

- **N1 pending review:** `executionState.status = pending` with the reviewer as
  current participant -> executor continuation is still parked/cancelled; C3
  falls through to disposition repair as today; no ordinary successor.
- **N2 unrelated recovery:** an active cross-agent recovery action (for example
  `successful_run_missing_state`) -> retries keep the recovery context and the
  recovery contract.
- **N2b hand-back plus unrelated active action:** the hand-back predicate holds
  and the retry's `recoveryActionId` names an active action of another cause or
  owner -> C4 keeps all keys and `recovery` stays non-null.
- **N3 duplicate and stale requests:** duplicates are covered by R3c (one row,
  one run, via the issue-locked lookup); a sweep after the reviewer resubmits
  (`statusVersion` changed) is denied by the guard and no hand-back sweep follows
  because the predicate no longer holds; a stale queued repair for an old
  fingerprint is still suppressed with `issue_disposition_repair_superseded`.
- **N4 active lease:** when another run holds `executionRunId`/`checkoutRunId`,
  the C3 wake is deferred by the existing issue execution lock, not dispatched
  over it, and no lock is cleared.
- **N5 shutdown retry with live action:** R4 with the action still active and no
  hand-back (for example review pending) keeps the repair context.
- **N6 legacy task without execution policy:** a review-wait summary still parks
  `issue_continuation_needed` as before.
- **N5b fallback without hand-back:** the retry's source context has no
  `recoveryActionId` but has `recoveryCause`, the repair source and fingerprint,
  and either (a) `executionState.status = pending` with the reviewer as current
  participant, or (b) a `legacyDispositionEpisode`, or (c) a task without
  execution policy. In each case the retry context keeps all keys, the prepared
  wake payload has a non-null `recovery` (and, for (b), the `dispositionRepair`
  block), and the prompt still renders the recovery contract.
- **N7 started predecessor:** a cancelled predecessor with `startedAt` set, or a
  `native` predecessor, with the C3 source still takes today's failure lane.

Test files: extend `server/src/modules/run-dispatch/domain/policy.test.ts` and
`adapters/postgres.test.ts`, `server/src/services/explicit-native-continuation.test.ts`
(it already models the park cancel), `server/src/services/heartbeat/retries.test.ts` for C4,
a focused recovery test next to `server/src/services/recovery/` for C3 and
R5 to R7, and a queue test next to `server/src/services/heartbeat/queue.ts` on the
embedded DB for R3c. Run only those vitest files on the host; full build and typecheck run
in CI.

## 6. Ordinary successor evidence

An incident counts as recovered only with all of:

- an actual native entry and its receipt, for the executor, of one of these
  kinds:
  - the C3 sweep wake (`source = issue.rework_handback_continuation_recovery`,
    receipt = the `agent_wakeup_requests` row with the C3 key and its run id);
  - an `owner_repair_continuation` wake from 3.5 (receipt = the row with the
    settlement `continuationKey` and the action's
    `owner_repair_continuation_admitted` resolution);
  - a comment wake from the executor or reviewer, or an
    `issue_continuation_needed` wake, admitted and started;
- that run started after the current `changes_requested` decision
  (`lastDecisionId` unchanged) and is bound to the same issue and assignee;
- its context has no `recoveryActionId`, `recoveryCause` or `dispositionRepair*`
  keys, and its wake payload has `recovery = null` (no "Recovery contract" in the
  prompt);
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
fork.

Returned for a scope decision now (not implemented by this design):

- **Owner repair prompt.** A non-legacy owner disposition repair renders the
  cross-agent recovery contract and not its own instruction (3.3). Changing the
  `dispositionRepair` generation condition or hiding `recovery` for owner repairs
  changes prompts for cases outside this fault. It needs its own decision and its
  own review.
- **Step-2 owner-repair continuation.** Why the existing entry in 3.5 did not
  deliver for the first repair stays UNKNOWN. If the action row or its settlement
  evidence becomes available, a separate bounded read can close it. This design
  does not depend on it.
