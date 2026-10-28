# Reviewer assignment continuation after execution cleanup

Date: 2026-10-28 UTC. Design for [#124](https://github.com/phenix3443/paperclip/issues/124).
Status: lifecycle amendment proposed for [#135](https://github.com/phenix3443/paperclip/issues/135).
The original design was approved in PR #125 and merged at
`8968b062051e3a5de1f78da88ab06d14560ab578`; that approval does not cover
this amendment. Exact-head independent approval, passing CI, plan merge and
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

### Persistent duty within executionContinuation (amendment)

This section replaces the original assumption that startup/cleanup already own
these receipts. It is a proposed extension, not a verified runtime capability.
The fixed source base is `8968b062051e3a5de1f78da88ab06d14560ab578`.
The separate diagnostic PR [#134](https://github.com/phenix3443/paperclip/pull/134)
at `de1a4c2ffaab1e5cae2e08fb551d7292d96adb0e` changes only
`server/src/__tests__/heartbeat-reviewer-assignment-continuation.test.ts`.
Its recorded result is **1 failed / 2 passed**, not implementation acceptance.
Keep that draft and its failing assertion unchanged as the implementation oracle.

Inspected source contracts on the fixed base:

- `heartbeat/queue.ts`: automatic no-input assignment refusals call
  `recordExecutionWait`; `execution-wait.ts` writes terminal diagnostics.
  `resumeQueuedRuns` reconstructs saved comments/interactions, not this duty.
- `heartbeat.ts`: executor cleanup computes `executionReleased` only after
  resource/process checks, then records release. Its later pending lookup filters
  on the outgoing agent, so it cannot discover an incoming different reviewer.
- `index.ts`: the existing `executionContinuation` registration calls
  `deliverReconciledExecutions` and `continueDecidedReviewReassignments`.
- `execution-control-work.ts`: `registerExecutionControlWork` provides startup
  execution, coalescing and a 15-second earliest-run floor. Its continuation
  deadline currently selects recovery actions, not reviewer receipts.
- `delivery-work-notifications.ts`, `packages/db/src/work-signals.ts` and
  `delivery-work-coordinator.ts`: transaction intent, outer settlement,
  uncertainty probes, retained dirty work, retries and shutdown already exist.

The queue module owns a deep module for this receipt's eligibility, retirement,
coalescing, admission and next due time. Its interface returns delivery outcomes
and the earliest unfinished obligation deadline. The facade wires it into the
existing continuation consumer alongside the two existing consumers. Run control
provides proven release evidence; it does not acquire recovery authority or
maintain another receipt collection. The existing coordinator/scheduler alone
owns wake scheduling. Do not create another topic, worker registration, timer,
scheduler, table, route, flag, or configurable recovery mechanism.

#### Producer and durable receipt

Only a future server-created native reviewer assignment that matches the pending
stage and current assignee may create this intent. Validate at the internal
review handoff seam; public wake payloads cannot self-declare server provenance.
Retain the receipt in `agent_wakeup_requests` with existing status
`deferred_issue_execution`, `runId=null`, `finishedAt=null`. Use a versioned
internal payload namespace for the immutable generation/source context and the
mutable delivery bookkeeping (`attempt`, `nextAttemptAt`, last hold/error).
These are proposed fields in existing JSON, not new columns or review state.
They must be written only by the owning module, not accepted as caller authority.

In the same company-scoped issue-lock transaction, await
`notifyDeliveryWork(tx, DELIVERY_QUEUES.executionContinuation, issueId)` **before**
inserting or updating the unfinished receipt. The immutable snapshot uses
canonical serialization with stable object-key order, ordered arrays and explicit
null handling. Include the full executionPolicy and executionState, selected
reviewer and real responsibleUserId; distinguish semantic generation changes from
unrelated issue timestamps. Same-submission duplicate signals share one pending
intent under the issue lock and cannot reset its backoff. Retain original actor,
reason, context and interrupted run; do not invent a comment as saved input.

Intent registration failure aborts the receipt write. Nested savepoint release
is not commit. The existing work-signal protocol retains uncertain writes until
outer settlement / transaction-status resolution. Commit exposes durable truth;
settlement wakes the existing consumer. Do not require an independent ad hoc
post-commit callback to preserve delivery. An optional immediate cleanup call is
only a latency optimization. The durable receipt is the duty.

A cleanup event before receipt commit cannot lose work: the producer settlement
requests another pass even if the earlier cleanup pass found nothing. Notification
arrival during a sweep leaves a dirty generation for the next pass. A rejected
transaction creates no receipt. An ambiguous commit stays fenced by work signals;
never infer rollback from an empty scan. After process exit startup reconstructs
committed receipts, including commits whose notification was lost with the process.
This contract uses the same instrumented root client for all supported producers.
It makes no cross-process notification or independent SQL writer guarantee.

#### Isolation from existing deferred-wake readers and writers

The status alone does not identify this duty. On the fixed base,
`modules/wake-queue/adapters/postgres.ts:223` selects the oldest deferred wake
by company/issue, with no agent restriction except for queue interrupts. Its
application use case can promote that row during any outgoing run's release.
`execution-reconciliation-admission.ts:35,89-103,163-165` counts deferred wakes
as active work and rejects reconciliation when any remains. Reusing the status
without changing these readers would bypass this consumer or deadlock recovery.
Neither behavior is permitted by this amendment.

Reserve payload key `_paperclipReviewerAssignmentContinuation`, with internal
`version: 1`, for this duty. Its **presence**, including null, malformed values
and unknown versions, excludes a row from all generic deferred promotion,
adoption, merging, replay and active-execution predicates. A valid v1 record is
eligible only through the owning module. Unknown/malformed records remain
non-executable and visible for diagnosis; the owner may retire proven invalid
records with a reason, but must never reinterpret them as ordinary deferred work.
Use one queue-owned classification contract with equivalent SQL and in-memory
predicates. For example, the ordinary-row SQL predicate is
`NOT COALESCE(payload ? '_paperclipReviewerAssignmentContinuation', false)`.
Apply it in SQL **before ordering/limit**, and in compare-and-set mutation
predicates as well as selection. A post-limit filter can starve ordinary wakes.
The contract exposes classification, not digest parsing or eligibility policy,
to other modules. Public producers reject the reserved key; its presence is an
exclusion fence, never proof of server authority. The consumer separately proves
internal provenance and the complete immutable contract.

The following is the required call-site disposition on the fixed base. Paths
are under `server/src/`; each row describes proposed implementation work, not
behavior already present. `Ignore` means the shared ordinary-row predicate at
selection and mutation; `delegate` means call the queue owner under the existing
transaction/locks, never call its private eligibility logic from another module.
Rows without the namespace retain their existing behavior and idempotency keys.

| Existing reader/writer | Required disposition for namespaced unfinished intent |
| --- | --- |
| `modules/wake-queue/adapters/postgres.ts` (`findNextDeferredWake`, interrupt lookup, promotion/adoption writes); `application/use-cases.ts`, `domain/policy.ts`, `application/ports.ts` | Ignore in generic candidates and conditional writes. Carry classification through the adapter seam so alternate adapters cannot promote it. Releasing author or any other run may drain ordinary work but cannot claim this receipt or its issue execution lock. Notify the continuation owner instead. |
| `services/execution-reconciliation-admission.ts` (`ACTIVE_WAKE_STATUSES`, `lockAdmissionRows`) | Ignore unfinished namespaced rows in pending-wake admission. Keep queued/claimed ordinary successors and real active runs as blockers. The parked duty is not competing execution. No recovery authority or other reconciliation gate is relaxed. |
| `services/execution-blocker.ts` | Ignore in saved-message enumeration and continuation evidence. Keep every actual recovery/process/workspace blocker; a receipt cannot clear its own hold. |
| `services/explicit-native-continuation.ts` | Ignore in task-retry, queued-comment and interrupt lookups, including exact receipt-ID requests. It cannot be used as user continuation authority. |
| `services/cross-task-continuation.ts` | Ignore in promotable dispatch scans, trusted-receipt reads and reuse writes; retain its separate actor/key proof for its own rows. |
| `services/dot-assignment-follow-up.ts` | Ignore in follow-up lookup and coalescing/retirement writes. No conversion into a dot follow-up even if malformed payload contains its key. |
| `services/muse-assignment-follow-up.ts` | Ignore in follow-up receipt handling; preserve its own identity contract. |
| `services/decided-review-reassignment.ts` | Ignore in parked recovery-wake lookup and adoption. This consumer continues its own decided reassignment duty; it cannot consume an undecided reviewer intent. |
| `services/chat-completion-delivery.ts` | Ignore in wake-key lookup before run selection and pending-wake suppression. Preserve the disjoint `chat-completion:` key; a reviewer row cannot satisfy or suppress completion delivery. |
| `services/companies.ts` (`applyArchiveCascadeInTx`) | Retire, rather than exclude from archive. Delegate namespaced rows to owner retirement in the archive transaction, retaining identity/payload and recording `cancelled`, `finishedAt` and archive reason. Generic archive cancellation handles other rows. No unarchive resurrection. |
| `routes/issues.ts` (wake diagnostics) | Read-only visibility may include it under existing authorization/redaction. Deferred does not mean running or delivered; never expose internal provenance/digest as authority. |
| `routes/issues.ts` (queued-comment selection, exact-ID mutation, interrupt, comment deletion/cancellation) | Ignore at lookup and guarded write. A no-input reviewer receipt is never a queued user message and cannot be edited, merged or cancelled by a comment action. Task Stop/cancellation delegates explicit invalidation to the owner. |
| `services/heartbeat/queue.ts` (startup resume, execution-wait reuse, follow-up merge, dispatch receipt promotion, bulk deferred coalescing) | Ignore in all generic paths, including direct-ID options and `runId` association writes. Only the continuation owner's locked adoption may consume this class, using its generation/idempotency contract. Ordinary wakes that deliver the same generation are later adopted by the owner; generic bulk coalescing cannot claim that equivalence. |
| `services/heartbeat/run-control.ts` (saved comments, interrupts, task retry and execution-wait resume) | Ignore. Cleanup notifies by company/issue across agents; no legacy resume path promotes the receipt. |
| `services/heartbeat/run-control.ts` (budget/project/company/agent pause cancellation and pending-wake bulk cancellation) | Temporary pause/budget holds ignore this class and retain its retry duty. Explicit Stop, task cancellation or permanent target removal delegates auditable invalidation to the owner. Classify the cancellation reason at the existing caller; a generic cancellation reason cannot silently retire a temporary hold. |
| `services/heartbeat/run-lifecycle.ts` (pending-wake suppression, `hasDeferredIssueCommentWake`); `services/heartbeat.ts` (outgoing-agent pending lookup) | Ignore as saved input or competing execution. Preserve real successor/run checks; lifecycle wiring only notifies the owner on proven release. |
| `services/fresh-workspace-continuation.ts`, `services/task-retry.ts`, `services/preserved-result-finalization.ts`, `services/queued-interaction-response.ts` | Ignore in exact-ID receipt validation, adoption and pending-input evidence. Retain their own retry/interaction/workspace authority. |
| `services/issue-tree-control.ts` | Temporary tree pause preserves the unfinished receipt. Explicit subtree Stop delegates retirement for affected company-scoped issues; retain historical rows. |
| `services/issue-dependency-wakeups.ts`, `services/question-response-delivery.ts`, `services/task-watchdogs.ts`, `services/native-runtime/native-child-completion-delivery.ts` | Ignore in their pending/idempotency predicates; reviewer intents cannot suppress a gate-releasing wake. Preserve distinct keys and existing delivery rules. |
| `services/recovery/service.ts`, `services/recovery/disposition-repair.ts`, `services/recovery/successful-run-handoff.ts`, `services/recovery/run-liveness-continuations.ts`, `services/successful-run-handoff-state.ts` | Ignore as recovery input, delivery proof, active-wake suppression or bulk mutation target. Recovery resolution keeps its own authority; afterward the reviewer owner retries actual admission. |
| `services/workspace-recovery.ts`, `services/workspace-recovery-backfill.ts` | Ignore as saved user input or repair authority and in receipt updates. Workspace repair retains its actual proof requirements. |
| `services/issues.ts` (blocker attention/inbox pending wakes and wake updates) | Ignore in active-execution or pending-input suppression and generic writes; read-only diagnostics may retain visibility. Terminal issue/Stop invalidation delegates to owner. |
| `services/task-interruption-presentation.ts`, `services/slack-conversation-state.ts`, `services/slack-conversation-lifecycle.ts` | Ignore as user message, pending turn or conversation liveness proof. Retain actual queued/running successor visibility. |
| `services/chat-inbound-wakeup-publications.ts`, `services/chat-channels.ts`, `services/chat-channels/inbound/wakeup-notices.ts`, `services/chat-channels/failed-run-retry.ts`, `services/chat-channels/slack/session-stop.ts` | Ignore in inbound publication association, retry receipt adoption, deferred-owner joins and session message cancellation. Their source-specific receipts retain normal behavior; a channel/session Stop cannot confer reviewer recovery authority. Explicit task Stop uses the owner invalidation path. |
| `services/native-runtime/status-decision-committer.ts` | Ignore in unrelated dispatch/coalescing writes. At the authorized reviewer-handoff seam delegate creation to the owner; a task terminal/Stop transition delegates invalidation. Preserve decisions, review generation and responsibility. |

Receipt creation, archive retirement and consumer adoption must serialize with
company archive. Extend the receipt transactions to take a shared company-row
lock and re-read active status before the issue lock; archive's company update
holds the conflicting row lock before its cascade. Restructure the internal
handoff caller to acquire that lock before an issue lock, rather than adding it
inside an already issue-locked callback. This is proposed transaction work to
prove on the fixed base, not a claim that current admission already does it.
An archive winning first prevents new receipt/successor creation;
an adoption winning first leaves its associated run to the existing archive run
cancellation lifecycle. Both outcomes retain auditable receipt/run links. Never
hold an issue lock and then acquire a company lock in reverse order. Temporary
holds are not bulk retirement. Retirement removes the receipt deadline; archive
settlement notifies the same existing topic to recompute it.

Before enabling the producer in a future implementation, review all accesses to
`agentWakeupRequests` (including raw SQL, aliases, exact-ID and status-independent
writes), not only literal status matches. Update this inventory for intervening
base changes. Tests must cover both SQL and in-memory classification and all
mutating consumers above. If any existing path cannot honor the fence under the
allowed JSON/status/transaction interfaces, record that exact primitive gap and
failing case in #135 / the parent task and stop. Adding a status or another
scheduler is not an authorized workaround.

#### Consumer transaction and retirement

For a bounded batch (at most 50 due intents), use the existing admission
transaction and company-scoped issue lock. Re-read immutable receipt identity,
current generation and authority, source ownership/release evidence, and matching
successors. Never hold the lock over provider calls or external cleanup.

| Result | Receipt and execution effect |
| --- | --- |
| Current generation and all admission gates pass | Atomically create one ordinary queued successor receipt/run with the continuation idempotency key, then mark the canonical intent `coalesced` with that `runId` and `finishedAt`; preserve its namespace for audit. The successor does not carry the reserved payload namespace; dispatch remains separately gated |
| Matching queued/running/scheduled_retry successor for the same generation | Coalesce against that run; no second wake or provider execution |
| Equivalent duplicate receipt | Coalesce against the canonical receipt's successor in the same issue-lock transaction; a receipt UUID alone is not the dedup key |
| Still-current assignment, temporary gate or ambiguous release | Keep unfinished; persist hold and future retry due time; no skipped diagnostic conversion |
| Generation/assignee/source contract superseded, issue terminal or explicit Stop invalidates this intent | Retire with an auditable reason using existing terminal status; never retarget to a new reviewer or restart a stopped task |
| Authority temporarily unavailable/revoked while assignment remains current | Keep held, execute nothing; only current ordinary authorization can release it |
| Malformed provenance or foreign-company association | Reject/retire only the local invalid intent under its own company; no foreign mutation |

Consumption and successor creation must commit together. A pre-commit failure
rolls both back. A post-commit exception is retried by inspecting the association;
it never repeats provider work. If a competing ordinary wake already delivered
this exact generation, adopt its run under the same lock. Do not treat an
unrelated later task turn as delivery proof. If such a turn changes generation,
retire; otherwise keep held until normal admission decides. A successor later
blocked at dispatch retains the existing queue's ownership and retry/hold rules;
a consumed receipt does not manufacture another run.

After **actual** executor cleanup has proven release, notify the same topic scoped
by company/issue, across outgoing and incoming agent identities. Place the hook
at the `executionReleased` boundary, after controller/process, lease and workspace
settlement, including the corresponding native finalization owner when applicable.
Do not use terminal status or lease expiry alone as cleanup proof. A lost cleanup
hint is covered by the existing topic's receipt retry deadline below. A held
cleanup attempt neither dispatches nor changes review history.

#### Deadline, backoff and every gate release

Extend the current continuation `next` calculation, preserving the deadlines of
both existing consumers. For this receipt class only, let U be unfinished,
server-proven, structurally eligible reviewer intents without an associated
successor. Temporary gates do not remove an intent from U. Terminal diagnostics,
retired/consumed receipts and completed review history do not belong to U.

At creation set `attempt=0`, `nextAttemptAt=createdAt`. After a held or failed
attempt persist `nextAttemptAt=attemptTime + min(15s * 2^min(attempt,5), 300s)`
and increment the bounded exponent. Each attempt handles at most 50 receipts;
overflow stays due for a later pass subject to the existing 15-second floor.
Each receipt's due time advances only after its own attempted reconciliation,
never just because a passive deadline query read it. Duplicate notifications do
not reset it. Backoff caps **frequency**, not the lifetime of a valid obligation;
there is no arbitrary attempt limit that silently discards an assigned review.
Retire only on the explicit invalidation rules above.

The reviewer deadline is `min(U.nextAttemptAt)` or null if U is empty. The topic
deadline is the minimum of this value and the two existing duties' deadlines.
Use the existing `registerExecutionControlWork` floor and scheduler registration;
do not add a timer. Before a receipt is due, an unrelated topic wake may inspect
its eligibility but must not redo expensive admission or move its due time.
After each successful pass recompute the minimum. No U and no other continuation
work means null and no recurring SQL/network after startup/settlement. An
unresolved producer transaction or failed reconciliation remains concrete work
owned by the existing coordinator retry, not an idle-history polling excuse.
If persisting backoff fails, the existing 15-second error retry retains the duty;
it cannot advertise quiet. Repeated failure is visible rather than discarded.

The following deadline path is **new receipt duty in the existing topic**, not
an assertion that current gate mutations already notify this receipt class.
Every row has the same durable fallback: its still-unfinished receipt's due time
re-enters normal admission, with bounded 15-to-300-second backoff. This avoids
requiring a notification retrofit across every gate producer. The implementation
must prove this path with the corresponding real mutation, not a manual helper
call. Successful events may shorten latency only through the same coordinator.

| Gate | Effective release and concrete next path |
| --- | --- |
| Company/agent/task pause, tree hold or scheduling suppression | Ordinary resume makes the current assignment eligible; receipt due time in existing continuation registration rechecks it. Stop that invalidates the intent retires it rather than acting as a temporary pause |
| Budget/daily usage cap | Authorized budget increase or normal period reset makes budget admission pass; receipt retry deadline covers both, without assuming budget enforcement emits a receipt wake |
| Dependencies | Ordinary blocker completion/removal clears dependency admission; existing issue dependency wake may deliver/coalesce first, otherwise receipt deadline retries |
| Pending interaction | Accepted/answered/withdrawn interaction clears the current gate through its normal route; receipt deadline retries, preserving response/decision authority |
| Execution ownership/recovery | Proven executor release notifies this topic; recovery resolution / deferred cleanup also remains covered by receipt deadline, but every retry rechecks existing recovery evidence |
| Workspace | Successful existing preparation/repair/finalization clears its hold; receipt deadline rechecks actual workspace and ownership proof, never invents a repair receipt or retries completed provider work |
| Responsible-user/project/agent access | Authorized grant/restoration through existing access paths is observed at receipt deadline; credentials or authority are never borrowed from cleanup actor |
| Reviewer capacity or another active turn | Existing run completion may drain queue; receipt deadline otherwise retries and checks queued/running/scheduled_retry dedup again |

There is no zero-delay held retry: the existing floor applies even to stale/past
deadlines and repeated hints. Batch limits and capped backoff bound work while
held; the receipt disappears from the deadline predicate immediately on retirement
or successful adoption. Drain retains dirty/uncertain work and durable due times
without admitting providers. Startup/resume rebuilds them; shutdown cancels the
existing worker and awaits active work. Do not claim that an in-process deadline
can wake stopped compute or remove any current sleep blocker.

Startup registers the existing topic once and performs its existing first pass.
The new consumer must include this receipt class even with no comments or
interaction payload and when the outgoing author differs from the reviewer.
Recompute due times from persisted JSON after restart; do not grant every receipt
a new attempt allowance or rely on the old author-agent lookup. Old skipped
history remains excluded. No restart is an operational remedy in this proposal.

If current JSON receipt adoption, transaction notifications, cleanup proof or
shared deadline interfaces cannot support this contract, stop implementation and
report the exact primitive and failing acceptance to the parent owner. Do not
quietly replace it with a second scheduler, periodic idle sweep or broader fork.

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

### Amendment acceptance at the assembled service seam

The implementation PR must turn the committed #134 red oracle green and add all
of the following deterministic real PostgreSQL/heartbeat cases. Provider execution
alone may be simulated. Use barriers/promises and the existing controllable
scheduler clock, not sleeps or direct helper calls as sole evidence.

1. Run the outgoing executor through cancellation and delayed real cleanup. Admit
   the incoming reviewer while the lease is held. Release the executor's cleanup
   promise and observe exactly one original-reviewer successor through lifecycle
   wiring, with no second submission/comment. Exercise legacy and applicable
   native finalization ownership separately.
2. Pause receipt transaction before outer commit. Complete cleanup and its empty
   scan first; commit, then observe one successor. Also roll back the outer
   transaction after a released savepoint and assert no delivery or residual duty.
3. Lose an immediate cleanup hint / throw after receipt or successor commit.
   Advance the registered continuation deadline and observe eventual one-run
   delivery/association. Recreate the service/coordinator for startup cases before
   and after receipt/successor commit, preserving persisted backoff.
4. Concurrent duplicate signals, cleanup notifications and two service instances
   yield one canonical generation delivery. Existing matching queued, running and
   scheduled_retry runs are each adopted without a second provider turn.
5. For **each gate row above**, create the held future receipt, run actual gate
   mutation through its owning service, advance its registered due time, and
   observe delivery through the consumer. While held, assert no provider calls,
   increasing due times capped at 300 seconds and no admission before due. Test
   mutation before receipt commit and multiple simultaneous holds as well.
6. Change full policy/state, participant, submission/decision, responsible user,
   assignment or source identity. Assert stale intent never dispatches. Revoke
   and restore real access separately to prove holding does not grant authority.
   Assert no foreign-company reads escaping scope or foreign writes.
7. Snapshot full policy/state, all decision rows, count and responsibleUserId
   before every successful delivery. Values remain equal afterward; missing/null
   maxReviewRounds remains three and count 2 is not reset. Historical skipped
   receipts remain untouched.
8. After startup and settlement, test empty, configured-idle and retained terminal
   history states with no other continuation duties. Advancing the clock produces
   no repeated SQL/network and `nextWakeAt` contains no reviewer duty. The first
   producer reactivates it. Cover notification during sweep, unresolved outer
   commit, drain/resume and shutdown without discarding work.
9. With a held reviewer receipt first in issue order and an ordinary deferred
   wake behind it, release the author and another agent through actual generic
   queue draining. Only ordinary work may promote; the reviewer receipt retains
   its identity, due time, null run and no execution lock. Race generic drain,
   startup/resume and the reviewer consumer across two instances. Before due or
   while held, no reviewer successor exists; after eligibility/due, exactly one
   successor uses the continuation key and unchanged generation. Include null,
   malformed and unknown-version namespace values and direct receipt-ID inputs.
10. Hold the reviewer on a real recovery action. Perform authorized reconciliation
    through its owning service. The receipt alone is not `pending_wake` refusal;
    real active wakes/runs and all other recovery gates still refuse as before.
    Proven resolution/release then permits the due consumer to deliver once.
11. Archive the company with a held receipt through the real service, racing
    consumer adoption and receipt creation. Observe auditable cancellation and
    archive reason, preserved immutable payload/history and no unfinished reviewer
    deadline. No provider starts after archive. If adoption wins, its linked run
    follows ordinary archive cancellation. Unarchive does not replay retired work.
12. Exercise the inventory's temporary budget/tree/agent/project/company pause
    bulk-cancellation paths and explicit Stop paths. Holds retain the duty; Stop
    retires it. Run existing ordinary comment/interaction/retry/recovery/chat
    regressions with no namespace and mixed rows to prove unchanged behavior.

This document defines acceptance; it does not report those future tests as run.
The documentation revision requires link/structure/whitespace checks and CI.
Runtime typecheck/test/build remain required in implementation and must not be
inferred from documentation checks.

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
recovery independently.

The implementation must ship the reader/writer fence before any new receipt can
be produced. Do not run older unfenced workers against a database containing
this class: they could promote it as ordinary deferred work. Deployment must
quiesce old workers using the existing ops lifecycle before starting fenced
producers; no new flag is introduced. A compatible rollback retains the fence,
unfinished receipts and review history. Rolling back to an unfenced binary while
any such receipt is unfinished is unsafe and is excluded. Stop compute and retain
the compatible consumer until ordinary delivery or authorized retirement settles
those obligations; do not edit/replay receipts to make rollback possible. A
rollback does not retract an admitted successor. Future implementation acceptance
must prove this version constraint before ops chooses a deployment/rollback SHA.

## Amendment delivery gate

Open focused draft PR #136 before editing (initial empty commit
`16fc0cab4b`), then review the exact amended document head and native plan revision.
Any change requires renewed independent cross-type review. Only after that
approval, required CI/checks, documentation merge and #135 closure may the
separately assigned #133 implementation resume. Update #133's final design and
acceptance with the merged amendment reference after approval. PR #136 closes
only #135; #134 stays a diagnostic draft. Preserve original implementation and
review assignments, executionPolicy/state, decisions, counts and responsible user.

This corrects delivery of an already selected native reviewer. It adds the
missing lifecycle duty to the existing continuation owner, without introducing a
new recovery capability. Upstream contracts were rechecked on 2026-10-28 via host
GitHub CLI: #16966, #17288 and #15019 remain OPEN at the exact heads listed above.
Their broader cadence/history contracts are not imported. Historical skipped
recovery belongs to [ai-team #567](https://github.com/phenix3443/ai-team/issues/567).
#113/#82/#89/#90 keep their scopes. No deployment, live recovery, database edits,
receipt replay, reviewer replacement, business completion resubmission or restart
fallback is authorized.
