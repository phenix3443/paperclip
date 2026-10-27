# Native execution reconciliation: admission, authorization and safe hand-back

Status: proposal for independent review. Issue: [#59](https://github.com/phenix3443/paperclip/issues/59).
This document authorizes no implementation, installation, deployment, restart,
production request, credential access, live `resolve`, state clearing or replay.
Implementation starts only after this plan is approved, merged and #59 is closed.

Contract: the approved operator contract
[ai-team `lease-output-recovery-contract.md`](https://github.com/phenix3443/ai-team/blob/001a97718166f191e295185e5dcf80f3e9843bcf/docs/paperclip/lease-output-recovery-contract.md)
(ai-team#488, merge `001a97718166f191e295185e5dcf80f3e9843bcf`, approved head
`7046387e223eafc37422f77554ef0f6689710f3d`). Its section "fork 必须交付的原生前置"
lists seven native prerequisites. This plan maps each one to native code and
splits the work into two slices. It does not change the contract.

Source references below were read at `develop` `30a15efe9ba0177301e824197402ea05779ad068`.
Line numbers are source lines, not the `dist` lines that the contract cites.

## Problem

`POST /api/issues/:id/recovery-actions/resolve` can settle an execution
reconciliation hold today (`server/src/routes/issues.ts:9585-10299`). For a run that
produced real output, the route is not safe enough:

- The request carries no expected state. `sourceIssueStatus` is a target, not a
  compare-and-set. The caller cannot prove that the issue, run, action, owner,
  workspace, policy or review state still match what was verified.
- The route checks that the caller is Board, but it cannot check which internal
  decision authorized this exact reconciliation. There is no native decision that
  targets an immutable document revision.
- There is no request receipt. A lost response cannot be told apart from a request
  that never committed, and a second request with a different payload replays as
  if it were the same.
- Gates are read outside the transaction. `assertSafeRecoveryHandBackGates`
  (`issues.ts:7091-7214`) reads the subtree pause, project pause, approvals and
  budget through services built on the raw `db`. It does not check dependencies or
  pending interactions. Gate writers do not lock the source issue.
- Successor delivery happens later in a worker
  (`deliverReconciledExecutions`, `server/src/services/execution-recovery-resolution.ts:286-386`).
  It rechecks only assignee, owner and terminal status before it wakes the agent.
- Any non-null `executionState` other than `pending` can reach a hand-back. Nothing
  proves that a `changes_requested` review keeps its stage, decision and count.

A host precheck cannot close these gaps, because the checks must hold at commit
time inside the database. They belong in the native route and services.

## Scope and non-goals

In scope: the native resolve request, admission, receipts, authorization
decisions, gate serialization, delivery revalidation, and a separate
`changes_requested` hand-back. Schema, shared types and validators, routes,
services, migrations, UI API client and docs stay synchronized (AGENTS.md §5).

Out of scope:

- The ai-team operator action (`reconcile_execution_with_output`). It is the
  ai-team implementation issue (ai-team#489) and starts after these slices deploy.
- Candidate discovery, a scheduler, a host fallback, a generic Board API proxy, or
  any new agent permission. `resolve` with `executionReconciliation` stays Board-only.
- Live recovery of any task. Runtime IDs, candidates and evidence stay in the
  Paperclip recovery coordination task, not in Git. No historic SHA in this plan is
  evidence for a future execution.

## Current behavior (verified)

| Area | Current source | Behavior and limit |
| --- | --- | --- |
| Request schema | `packages/shared/src/validators/issue.ts:607-660` (`resolveIssueRecoveryActionSchema`) | Strict. `executionReconciliation` has `runId`, `providerStopped: true`, `actionOutcome`, `outcomeEvidence` (20-12000 chars), optional `workspaceRepairEvidence`. No expected state, authorization or idempotency key. New fields are rejected with 400. |
| Route transaction | `issues.ts:9655-9696` | Locks `issues` then one `issue_recovery_actions` row `FOR UPDATE`. Run, coordinator and lease rows are read without locks. |
| Settled replay | `issues.ts:9725-9776` | An action with `automaticRecovery.replay = "blocked"` is reopened to `active` (9762) when reconciliation is sent; other settled actions return `replayed` without comparing the payload. |
| Reconciliation checks | `execution-recovery-resolution.ts:74-208` | Terminal run, owner, run issue, workspace repair evidence, lease termination receipts, local `process.kill(…, 0)`, coordinator lease and successor, unreleased leases, continuation build. Reads are unlocked. |
| Evidence write | `execution-recovery-resolution.ts:211-284` | Writes `evidence.executionReconciliation` and `continuationDelivery` in a savepoint. Status and outcome are written later by the route (`issues.ts:10163`). |
| Hand-back gates | `issues.ts:7091-7214` | Owner, checkout/run, pending stage, subtree pause, project pause, approvals, budget. Items after the pending stage use raw-`db` services. No dependency or interaction check. |
| Pending stage | `execution-recovery-resolution.ts:33-71` | Blocks `pending` states, except a verified pre-start cancelled reviewer run with `not_performed`. Other non-null states are not refused. |
| Delivery | `execution-recovery-resolution.ts:286-386`, `server/src/services/heartbeat/queue.ts:2167-4436` | Worker selects `continuationDelivery = pending` without locks, invalidates only on missing task, owner change, or done/cancelled, then wakes with key `execution-reconciliation:<actionId>`. Queue admission locks the issue and action, rechecks the execution blocker and dependency readiness, and defers behind an active run. Budget, agent and pause checks run before the issue lock (2691-2758). |
| Wake key | `packages/db/src/schema/agent_wakeup_requests.ts:49-102` | No unique index for the `execution-reconciliation:` key prefix. |
| Decisions | `packages/db/src/schema/issue_execution_decisions.ts` | Bound to a review stage (`stage_id` not null). No document, revision or digest target. |
| Documents | `packages/db/src/schema/documents.ts`, `document_revisions.ts` | Immutable revision rows with `revision_number`; `documents.latest_revision_id` and `latest_revision_number` point to the newest. |

## Design overview

The route gains one optional object, `admission`, inside `executionReconciliation`.
When `admission` is present the route runs the new admission service. When it is
absent the old behavior stays for existing callers (no-output restore, workspace
repair), and a capability flag lets the operator refuse to call an old server.

```
resolve(request)
  └─ tx: lock order L1..L9 (below)
       ├─ receipt lookup by (company, idempotencyKey)  → same digest: return receipt
       │                                               → different digest: 409, no write
       ├─ compare expected snapshot digest             → mismatch: refusal, rollback
       ├─ verify authorization decision                → invalid: refusal, rollback
       ├─ admission checks (runs, wakes, leases, gates) → any failure: refusal, rollback
       ├─ write action evidence + receipt + status     (one commit)
       └─ commit
  └─ refusal: separate short tx writes one audit row only
worker: deliver → lock order → revalidate gates → wake exactly once, or record invalidated/waiting
```

## Mapping of the seven prerequisites

Each row names the slice that delivers it. Slice A is the base admission. Slice B is
`changes_requested`.

| # | Contract prerequisite | Native implementation | Slice |
| --- | --- | --- | --- |
| 1 | Request and state binding | `admission.expected` snapshot and `admission.expectedDigest`; canonicalization below; comparison under lock | A |
| 2 | Native authorization binding | `issue_document_decisions` table, company `executionReconciliationAuthority`, decision verification under lock | A |
| 3 | Transactional admission | New `admitExecutionReconciliation(tx, …)` with run, successor, wake, lease and coordinator checks after locks | A |
| 4 | Concurrent gates | Lock order L1-L9, gate writers lock the issue row first, delivery revalidation in the worker | A |
| 5 | Stage preservation | A refuses every non-null `executionState`; B admits only eligible `changes_requested` with whole-state equality | A (refusal), B (support) |
| 6 | Request idempotency | `execution_reconciliation_receipts` table with key, digest, revision, decision, expected snapshot, result | A |
| 7 | Atomic refusal | Single transaction for all writes; refusal audit in a separate transaction with no action, delivery, wake or run | A |

### 1. Request and state binding

New fields inside `executionReconciliation` (strict schema; unknown keys stay 400):

```ts
admission: {
  schema: "execution_reconciliation_admission_v1",
  idempotencyKey: string,            // 16-128 chars, [A-Za-z0-9:_-]
  expected: ExpectedReconciliationState,
  expectedDigest: string,            // sha256 hex of canonical(expected)
  authorization: {
    documentId: uuid, revisionId: uuid, revisionNumber: int,
    bodyDigest: string,              // sha256 hex of the revision body bytes
    decisionId: uuid,
  },
  targetStatus: "todo" | "in_progress", // must equal sourceIssueStatus
}
```

`ExpectedReconciliationState` contains, with no optional keys:

- `companyId`, `projectId` (null allowed), `issueId`, `runId`, `actionId`.
- Run: `status`, `finishedAt` (ISO, required, a missing value refuses),
  `agentId`, `processPid`, `processGroupId`, `runtimeMode`.
- `unstartedRunIds`: sorted list of hold-cancelled, never-started runs for the issue
  (section 3). Empty list when there are none.
- Action: `status`, `cause`, `kind`, `outcome`, `ownerAgentId`, `returnOwnerAgentId`,
  `updatedAt`.
- Issue: `status`, `statusVersion`, `assigneeAgentId`, `assigneeUserId`,
  `responsibleUserId`, `workspaceBindingRevision`, `executionPolicy` (whole
  object), `executionState` (whole object), `unblockDescriptor`, and the monitor
  columns (`monitorNextCheckAt`, `monitorAttemptCount`, `monitorScheduledBy`,
  `monitorNotes`).

The server builds the same structure from the locked rows and compares the digest.
It never trusts the client snapshot as data; the snapshot only proves what the
caller verified. A mismatch returns `409 expected_state_mismatch` with the server
digest and the names of the differing top-level keys, never their values.

Canonicalization reuses the ai-team #397 rules, made exact:

- JSON with UTF-8 bytes, object keys sorted by Unicode code point, no whitespace.
- `null` is written; a missing key is invalid. The server fills every listed key,
  using `null` when the column is null.
- Timestamps are ISO 8601 UTC with milliseconds (`Date.toISOString()`).
- Numbers must be safe integers. Non-integers, `NaN`, infinities and duplicate keys
  are rejected (400) before hashing.
- One shared implementation lives in `packages/shared` and is used by the server,
  the tests and the operator. A test vector file fixes the expected digests.

### 2. Native authorization binding

The contract requires a decision that the server can verify: a real CTO identity,
the exact immutable revision and digest, scope `execute`, and a decision that is
still valid. Comments, role names and operator claims do not count.

New table `issue_document_decisions` (append-only):

| Column | Meaning |
| --- | --- |
| `id`, `company_id`, `issue_id`, `document_id` | Scope. The document must belong to the issue (`issue_documents`). |
| `revision_id`, `revision_number`, `body_sha256` | The exact revision. The server computes the digest from `document_revisions.body`. |
| `scope` | `execution_reconciliation` only in this plan. |
| `outcome` | `approved` or `revoked`. A revoke row targets an earlier approval. |
| `expires_at` | Required for `approved`, at most 72 hours after creation. |
| `actor_agent_id`, `actor_user_id`, `created_by_run_id` | Set by the server from the authenticated actor and run. Never from the body. |
| `created_at` | Server time. |

Route: `POST /api/issues/:id/documents/:key/decisions` with body
`{ revisionId, scope, outcome, expiresAt, revokesDecisionId? }`. Any actor that can
read the issue may record a decision. Recording grants nothing. A decision only
counts at admission when its actor is on the company authority list.

Authority list: new company column `execution_reconciliation_authority jsonb`
default `{"agentIds": []}`. Only Board can change it, through the existing company
update route with `assertBoard`. It is not an agent permission and it does not let
the listed agent call `resolve`. An empty list refuses every request with
`admission`. The role field cannot be used: the CTO agent's role is
`engineering-manager`, which is not unique, and names are display data.

Admission verifies, under lock:

1. The document belongs to the recovery issue named in the decision, in the same
   company.
2. `documents.latest_revision_id = authorization.revisionId`. A newer revision R2
   makes R invalid even if R was approved.
3. The server-computed `sha256(body)` equals `bodyDigest` and the decision's
   `body_sha256`.
4. The decision is `approved`, scope `execution_reconciliation`, not expired, not
   revoked by a later row, and its `actor_agent_id` is in the authority list at
   admission time.
5. The revision body is JSON with `scope = "execute"` and contains the exact
   `{issueId, runId, actionId}` tuple, the `expectedDigest`, the `actionOutcome`, the
   `targetStatus` and an `expiresAt` no later than the decision's. Other fields of
   the body are evidence and are not interpreted by the server.

The receipt stores the revision and decision IDs. The payload digest does not
include them, which keeps the contract's acyclic order: payload → digest →
revision → decision → request.

A revoke, a new revision, an expiry or an authority-list change all take effect at
the next admission. Once a receipt exists, later changes do not undo it; they
block the next request.

### 3. Transactional admission

New service `admitExecutionReconciliation(tx, input)` in
`server/src/services/execution-reconciliation-admission.ts`. It runs after the
locks below and before any write. It refuses unless all hold:

- Company, issue, run and action match the request, and the action's source run is
  the request run.
- The run is terminal (`failed`, `interrupted`, `timed_out`, `cancelled`) with a
  `finishedAt`. Process and lease checks reuse `validateExecutionReconciliation`
  with `tx`; local process checks stay `process.kill(pid, 0)` and remote leases need
  termination receipts.
- The coordinator row has no `lease_owner`, its phase is final, and it has no
  `failureDetail.successorRunId`.
- No other action on the issue is `active` or `escalated`.
- No run for the issue (by `issueId`, `nativeIssueId`, `contextSnapshot.issueId` or
  `retryOfRunId` = source run) is `queued`, `running` or `scheduled_retry`.
- No wake for the issue is `queued`, `claimed` or `deferred_issue_execution`.
- No run for the issue was created after the source run, in any status, and no run
  has `retryOfRunId` or `contextSnapshot.previousRunId` equal to the source run.
  This covers successors linked only through context. The definition matches #397's
  "newer run". One exception: a run that the hold itself cancelled before start
  (`status = cancelled`, `errorCode = execution_reconciliation_required`, and
  `startedAt`, `processPid`, `processGroupId`, `nativeSessionId` all null; the same
  test as `unusedAdmission` in `explicit-native-continuation.ts`) is allowed only when
  its ID is listed in `expected.unstartedRunIds`. The caller must have seen it.
- Gates (section 4) all pass on locked rows.
- The request outcome is `completed`, `not_performed` or `mixed`; the schema has no
  `unknown`. `mixed` is for saved results plus remaining work, never for effects
  nobody has checked. The operator refuses before calling when any effect is unknown.

### 4. Gate serialization and lock order

Rule: a gate counts only if it is read inside the admission transaction, after the
lock that serializes its writers. Every gate helper used by admission takes `tx`;
the current raw-`db` reads in `assertSafeRecoveryHandBackGates` are not reused.

A writer that can only open a gate (resolve a blocker, answer an interaction,
release a pause) may race with admission. The worst result is a refusal on stale
data, which is safe. A writer that can close a gate must be serialized with
admission. The plan changes only those writers.

Existing documented orders that this plan follows: company accounting lock before
any run or policy lock (`server/src/services/accounting-transaction.ts:8-10`); issue →
wake → run (`server/src/services/heartbeat/queue.ts:754,1265`); issue → coordinator →
run (`execution-recovery-resolution.ts:505`, `server/src/services/execution-control-reconciliation.ts:77-114`);
issue → run → lease (`server/src/services/legacy-shutdown-workspace-settlement.ts:117`).

Admission lock order (the delivery worker uses the same order):

| Step | Row or lock | Mode | Serializes against |
| --- | --- | --- | --- |
| L1 | `companies` row | `FOR SHARE` | Budget hard-stop, budget project pause, company pause, authority-list change (all write the company row or hold its accounting lock) |
| L2 | Owner agent row | `FOR SHARE` | Agent pause and terminate (lifecycle store: accounting lock → agent `FOR UPDATE`) |
| L3 | Advisory `issue-tree-hold:<companyId>` | `pg_advisory_xact_lock_shared` | Subtree hold creation (changed to take it exclusively, G1) |
| L4 | Source issue | `FOR UPDATE` | PATCH, monitor set and claim, workspace binding, dependency sync, interaction create, wake enqueue, approval link (G2) |
| L5 | Blocker issues of the source, ascending id | `FOR SHARE` | Blocker status changes (a reopened blocker closes the gate) |
| L6 | Recovery actions of the source issue, ascending id | `FOR UPDATE` | Other recovery writes |
| L7 | Wakes for the source issue | `FOR UPDATE` | Wake claim |
| L8 | Coordinator row of the source run | `FOR UPDATE` | Native finalization |
| L9 | Source run and runs for the issue | `FOR UPDATE` | Run claim and finalization |
| L10 | Leases of the source run | `FOR SHARE` | Lease release |
| L11 | Authorization `documents` row | `FOR SHARE` | New revision R2 (updates the row), decision insert (G4) |

The receipt insert comes last. Its unique index serializes identical keys.

L5 follows `syncBlockedByIssueIds`, which locks the source before its blockers
(`server/src/services/issues.ts:7502-7521`). A rare cross-order with another
dependency edit, or the known coordinator-first order in
`server/src/services/budget-reservations.ts:10-12`, can still produce a PostgreSQL
deadlock or serialization error. Admission maps `40P01` and `40001` to
`409 concurrent_change`. The transaction has rolled back, so nothing was written;
the caller re-reads and starts again with the same key.

Gates checked after the locks, each refusing with `gate_closed:<gate>`:

| Gate | Check |
| --- | --- |
| `dependency` | Every `blocks` relation into the source issue has a blocker in `done` or `cancelled` |
| `interaction` | No `pending` interaction on the issue, for any responder |
| `approval` | No linked approval in `pending` or `revision_requested` |
| `subtree_pause` | No active pause hold covering the issue (`getActivePauseHoldGate` with `tx`) |
| `project_pause`, `company_pause`, `agent_pause`, `budget` | Project and company not paused, owner agent invokable, no budget invocation block (with `tx`) |
| `monitor` | No scheduled monitor. A monitor is a real business wait; this route never clears it |
| `workspace` | `workspaceBindingRevision` and pending selection unchanged from the expected snapshot |
| `checkout` | `checkoutRunId` and `executionRunId` null or the source run |
| `owner` | Assignee, action `returnOwnerAgentId` and source run agent are the same agent |

Gate writers that must change in slice A:

| ID | Writer (current source) | Today | Change |
| --- | --- | --- | --- |
| G1 | Subtree hold create (`server/src/services/issue-tree-control.ts:704-813`) | No issue lock | Take `pg_advisory_xact_lock('issue-tree-hold:<companyId>')` exclusively in its transaction. Release only opens the gate; unchanged |
| G2 | Approval link (`server/src/services/issue-approvals.ts:107`) and approval moves into `pending` or `revision_requested` (`server/src/services/approvals.ts:185`) | No transaction, no issue lock | Run in a transaction that first locks every linked issue `FOR UPDATE` in ascending id |
| G3 | PATCH execution policy transition (`server/src/routes/issues.ts:14136` computes on the unlocked row, writes at `:14677`) | Transition may use a stale row | Recompute on the locked row; if the result differs from the pre-lock result, return 409 |
| G4 | New decision insert | n/a | Lock the `documents` row `FOR UPDATE` before inserting, so it conflicts with L11 |
| G5 | Delivery worker (`execution-recovery-resolution.ts:286-386`) | Unlocked select, three checks | Per action: L1-L10, same gates, then wake or record a wait (next section) |

Writers that already serialize and need no change: PATCH and status (issue lock,
`issues.ts:11142`); monitor set and scheduler claims (issue lock or row update);
workspace selection and binding (issue lock, `execution-workspaces.ts:1508,1545,1587`);
interaction create, accept, reject and answer (issue lock); non-empty dependency
sync (issue lock); document revision upsert (updates the `documents` row);
company and agent pause, budget (company and agent rows); wake enqueue (issue lock,
`queue.ts:2825`). Unlocked interaction expiry and cancel paths only leave `pending`,
so they only open the gate.

Known residual, not changed here: `claimQueuedRun` (`queue.ts:953-1238`) checks
budget, pause and dependencies before its lock. This applies to every run in the
product, not only reconciled ones. The contract guarantee is at admission and at
delivery; claim-time locking is a general dispatch change with its own review.

### 5. Stage preservation

Slice A refuses every request whose locked `executionState` is not null, with
`409 execution_state_not_supported`. It does not use the pending-reviewer exception
(`isVerifiedPreStartCancelledReviewerRun`), which stays limited to never-started
`not_performed` reviewer runs.

Slice B adds `changes_requested` support. It is admitted only when all hold:

- `executionState.status = "changes_requested"`, `currentParticipant` is null or
  the original author, and `returnAssignee` is the source run's agent, which is also
  the issue assignee and the action's `returnOwnerAgentId`.
- The last decision (`lastDecisionId`) exists in `issue_execution_decisions` with
  outcome `changes_requested`, and its stage is in the policy.
- `changesRequestedCount` is below the effective maximum. `maxReviewRounds` null or
  missing means 3. At or above the limit refuses (the task belongs to its
  responsible human).
- No pending interaction, pending or `revision_requested` approval, or human
  takeover (`assigneeUserId` set) exists.
- `targetStatus` is `in_progress`. `todo` is refused in slice B, because the PATCH
  path for `todo` can recompute the stage. Any other target needs a new reviewed
  plan.

The hand-back writes only `status`, `statusVersion`, the action and the receipt.
After commit, `executionPolicy`, `executionState` (every key, including
`currentStageId`, `currentParticipant`, `returnAssignee`, `completedStageIds`,
`lastDecisionId`, `lastDecisionOutcome`, `changesRequestedCount`, `reviewRequest`,
`monitor`) and all decision rows are byte-identical to the locked snapshot. The
service asserts this before commit by re-reading and comparing canonical digests,
and rolls back on any difference. A later `done` by the author goes through the
normal review gate, so the reviewer sees the same stage and count.

Pending review, escalated review, approval stages and states at the round limit
stay refusals in both slices.

### 6. Request idempotency

New table `execution_reconciliation_receipts`:

| Column | Meaning |
| --- | --- |
| `id`, `company_id`, `issue_id`, `action_id`, `run_id` | Scope |
| `idempotency_key` | Unique per company |
| `request_digest` | sha256 of the canonical request without the key |
| `expected_digest`, `expected_snapshot` jsonb | What admission compared |
| `authorization_revision_id`, `authorization_decision_id`, `authorization_body_sha256` | What authorized it |
| `result` jsonb | Final issue status, statusVersion, action status/outcome, `continuationDelivery` |
| `actor_user_id`, `created_at` | Board caller and time |

Unique indexes: `(company_id, idempotency_key)` and `(company_id, action_id)`, so one
action has at most one admitted reconciliation.

Rules:

- Same key, same digest: return `200` with the stored receipt and `replayed: true`.
  No write. The response also carries the current delivery state read now.
- Same key, different digest: `409 idempotency_conflict`. No write.
- Different key, same action already admitted: `409 action_already_reconciled`
  with the existing receipt ID.
- The old `replayed: true` for settled actions is no longer returned on the
  `admission` path unless a matching receipt exists.
- Delivery keeps the existing `execution-reconciliation:<actionId>` wake key. Slice A
  adds a partial unique index on `agent_wakeup_requests (company_id, idempotency_key)`
  for that prefix, so a second wake cannot be inserted.

A lost response is handled by reading `GET /api/issues/:id/recovery-actions/receipts/:key`
(Board-only, read-only). It returns the receipt or 404. 404 is proof that nothing
committed under that key, because the receipt and the action write share one
transaction.

### 7. Atomic refusal

All admission writes (action status and evidence, issue status and statusVersion,
coordinator `replacementDenied`, receipt, queue notifications) are in one
transaction. A refusal throws before the first write, so the transaction rolls back.

The settled-hold reopen at `issues.ts:9762` currently writes `status = active`
before validation. On the `admission` path it moves after all checks, inside the
same transaction, so a refusal leaves the hold exactly as it was.

After rollback, a separate short transaction writes one activity row
`issue.execution_reconciliation_refused` with the refusal code, request digest,
expected digest and key. It writes no action, delivery, wake or run, and it does
not touch source run events. The original failure history stays.

Refusal codes are stable strings: `capability_unsupported`,
`expected_state_mismatch`, `authorization_invalid`, `authorization_stale`,
`authority_not_configured`, `idempotency_conflict`, `action_already_reconciled`,
`execution_state_not_supported`, `run_not_settled`, `newer_execution_exists`,
`gate_closed:<gate>`, `concurrent_change`.

## Durable delivery revalidation

`deliverReconciledExecutions` changes in slice A:

- It selects candidates without locks, as now, then for each action opens a
  transaction and takes the same lock order (L1-L10).
- It re-runs the gate checks of section 4 and the "no newer execution" check, except
  that the run it is about to create is excluded.
- If a gate is closed, it does not wake. It records `continuationDelivery = "waiting"`
  with the gate name and leaves the action resolved. The gate's normal release
  path (dependency resolution, interaction answer, unpause) notifies the
  continuation queue, which retries. This is a native wait, not a host wake.
- If the issue changed owner, was closed, or the receipt is missing, it records
  `invalidated` as today.
- The existing queue admission (`heartbeat/queue.ts:3283-3342`) also checks that a
  receipt exists for actions reconciled with `admission`.

## Capability and version proof

`GET /api/health` (`server/src/routes/health.ts`) has no capability field today. It
gains a `capabilities` object in both the public and full responses, with
`capabilities.executionReconciliationAdmission` set to
`"v1"` (slice A) or `"v1+changes_requested"` (slice B). The operator must read it and
refuse when it is missing; it never probes with a production `resolve`. The
deployed commit in `health` must equal the approved merge SHA of the slice.

## Bootstrap: the implementation task's own hold

The ai-team operator task (ai-team#489, which implements `reconcile_execution_with_output`)
now has its own execution reconciliation hold. Its last run stopped by the active-run
watchdog after it had posted its blocked comment. Native records show cause
`legacy_execution_requires_reconciliation`, kind `active_run_watchdog`, legacy
runtime, a `codex_local` agent, and `automaticRecovery.replay = "blocked"` with
`actionOutcome = "unknown"`. `getExecutionBlocker`
(`server/src/services/execution-blocker.ts:44-55`) therefore holds every new wake for
that task. The hold must be released without the operator code that the task itself
has to write.

The route chosen must not need that unfinished code, must not widen any agent's
permission, must not recreate the task or clear its history, and must keep read-only
diagnosis separate from the gated release.

Options found in current native code:

| Option | What it needs | Fit |
| --- | --- | --- |
| A. Native explicit user continuation (`admitExplicitNativeContinuation`, `server/src/services/explicit-native-continuation.ts:80-407`) | One new human user comment on the held task, posted after the run finished | Already in the deployed commit `6d74176932f9a9970a109fe98b26b803fe55b4f5`; this file and `execution-blocker.ts` are unchanged between it and the plan's base. Applies to legacy `legacy_execution_requires_reconciliation` holds for conversation adapters (`codex_local` is one). It starts a fresh turn, marks the hold `explicit_user_continuation`, and records that no outcome was inferred. It checks process stop, released leases, no active run, no pending interaction or approval. No operator code, no new permission, no history change. |
| B. New `resolve` with `admission` after slice A deploys | Board-authenticated caller, CTO decision on an authorization revision | Valid, but today only the operator holds an isolated Board credential, and the operator action is the code still to be written. A human Board user could call it, which is the same human dependency as A with more steps. |
| C. Old `restore_execution_recovery` (`not_performed`) | Existing operator allowlist | Not allowed. The run produced output, so `not_performed` would be false. |
| D. Let an agent (CTO or ops) trigger continuation | New agent permission | Not allowed by #59. |

Recommendation: option A, with read-only diagnosis first.

1. Read-only diagnosis (ops, any time): confirm from native records that the held
   run is terminal, its process group no longer exists on the control-plane host,
   its leases are released, no run or wake is live for the task, and no pending
   interaction or approval exists. Record the saved output (comment, status, Git
   HEAD, PR state) so the successor can continue from it. Also confirm from
   `shouldWakeAssigneeForIssueComment` that a user comment wakes the assignee of a
   `blocked` task, and that the task's adapter history is a conversation adapter.
   This step writes nothing.
2. Gated release (CTO decision, then one human action): option A itself does not
   need this plan's code. It is timed after slice A is deployed only because the
   task has no work before then; an earlier release would start a run that blocks
   again. The CTO records the decision in the recovery coordination task and asks a
   human Board user to post one new message on the held task. This is the "account only a
   human holds" case: the native path accepts only `actorType = "user"`, and agents
   cannot and must not post as a user or receive Board credentials.
3. Acceptance: a new run exists for the task with `contextSnapshot.previousRunId`
   equal to the held run, the hold action shows `explicitUserContinuation` and
   `automaticRecovery.replay = "explicit_user_continuation"`, `actionOutcome` stays
   `unknown`, the decision history and review counts are unchanged, and the new run
   produces useful output or a valid native wait.

If the CTO does not accept a human step, no native route exists today that meets
all constraints. The missing capability is an agent-authorizable continuation for a
hold whose only effects are native records. Building it would need its own reviewed
plan and is out of scope here.

## Slices

### Slice A: base admission, authorization and idempotency

Delivers prerequisites 1, 2, 3, 4, 6, 7 and the refusal part of 5. Scope:

- Migration: `issue_document_decisions`, `execution_reconciliation_receipts`,
  `companies.execution_reconciliation_authority`, partial unique wake key index.
- `packages/shared`: canonical JSON and digest helper with test vectors,
  `admission` schema, decision schema, refusal codes, health capability.
- Server: decision route, receipt read route, admission service, route changes,
  gate-writer lock changes, delivery revalidation.
- UI: company settings field for the authority list (Board only); API client types.
- Docs: `doc/SPEC-implementation.md` recovery section, this plan's status.

### Slice B: `changes_requested` hand-back

Delivers the support part of prerequisite 5. Starts after slice A is merged and
deployed. Scope: eligibility checks, whole-state preservation assertion, target
`in_progress`, health capability `v1+changes_requested`, tests.

Slice A is larger than one review can hold safely. Under its one Issue it ships as
ordered PRs, each reviewed on its exact head: A1 canonical digest, expected-state
binding, receipts and atomic refusal; A2 decisions and the authority list; A3 gate
writer locks (G1-G4), admission gates and delivery revalidation (G5). The health
capability is set only in A3, so a partly deployed slice A still refuses
`admission` requests with 400.

Each slice has its own Issue. Every PR gets cross-type review on its exact head, and
each slice gets a separate ops deployment task. Merging into `develop` does not close the Issue; the
author closes it after approved delivery.

## Test matrix

All tests use real PostgreSQL (`server/src/__tests__/helpers/embedded-postgres.ts`,
`describeEmbeddedPostgres`) and go through the route, the services and the delivery
worker. Concurrency tests use two connections and explicit barriers so that both
commit orders run. No test uses production data or claims live recovery.

| Case | Expected |
| --- | --- |
| Valid request, state null, output verified | One receipt, action resolved, one delivery, one run with `retryOfRunId` = source |
| Same key, same payload, sequential and concurrent | One receipt, second returns it with `replayed: true`, one run |
| Same key, different payload | 409 `idempotency_conflict`, no write |
| Different key, same action | 409 `action_already_reconciled`, no write |
| Any expected field changed (reviewer, count, monitor, workspace revision) with statusVersion unchanged | 409 `expected_state_mismatch`, no write |
| Authorization: R2 written before admit | Refused `authorization_stale` |
| Authorization: admit commits before R2 | Receipt fixed on R; R2 does not undo it |
| Decision expired, revoked, wrong scope, wrong revision, actor not on list, empty list | Refused, no write |
| Run not terminal, process alive, lease held, coordinator lease or successor | Refused `run_not_settled` |
| Live or queued run, scheduled retry, queued/claimed/deferred wake, newer terminal run, run linked only by `contextSnapshot.previousRunId` or `retryOfRunId` | Refused `newer_execution_exists` |
| Each gate (dependency, interaction, approval, subtree pause, project pause, agent pause, budget, monitor, workspace binding) changed concurrently, both commit orders | Either admission refused, or gate write waits and then sees the resolved issue; never a delivery past a closed gate |
| Gate closes after admit, before delivery | Delivery records `waiting:<gate>`, no wake; reopening the gate delivers once |
| Response lost after commit | Receipt read returns the receipt; retry with same key returns it; one run |
| Failure before commit (injected) | Receipt read 404; no action change |
| Refusal | Action, issue, coordinator, wakes and runs byte-identical; one refusal activity row |
| Settled hold with `replay = blocked` refused | Hold unchanged (not reopened) |
| Non-null `executionState` in slice A | Refused `execution_state_not_supported`, state unchanged |
| Slice B: eligible `changes_requested` | Author run created; policy, state, decisions and count byte-identical; later `done` triggers the same review stage |
| Slice B: pending review, approval stage, round limit, human takeover, pending interaction, target `todo` | Refused, no write |
| Old callers without `admission` | Existing tests in `issue-recovery-actions.test.ts` and `workspace-restore-repair-route.test.ts` pass unchanged |

Repository checks: `pnpm -r typecheck`, `pnpm test:run` for the affected packages,
`pnpm build`, and migration generation per `doc/DATABASE.md`.

## Deployment and acceptance

Per slice:

1. Plan approved and merged; #59 closed.
2. Slice Issue and PR, cross-type review on the exact head, merge into `develop`.
   Record approved head and merge SHA.
3. Ops deploys the merge SHA (separate gated task). Acceptance reads `GET /api/health`
   commit and `capabilities.executionReconciliationAdmission`.
4. After slice A: a Board user sets `execution_reconciliation_authority.agentIds`
   for the company. Until then every `admission` request is refused
   (`authority_not_configured`), which is the safe default.
5. The ai-team operator work resumes only after step 3 and 4 evidence. The
   bootstrap release of its own hold follows the section above.

Live recovery of any source task stays in the recovery coordination task, with its
own independent acceptance.

## Migration and rollback

- Additive migration only: two new tables, one company column with a safe default,
  one partial unique index. Before creating the index, the migration checks for
  duplicate `execution-reconciliation:` wake keys and fails with a clear message if
  any exist; it does not delete rows.
- Rollback of code: the old server rejects `admission` with 400, which the operator
  treats as `capability_unsupported`. Receipts and decisions stay in the database and
  are ignored. Committed reconciliations and successors are not undone; a new risk
  goes through native stop and recovery.
- Rollback of slice B alone: `changes_requested` returns to
  `execution_state_not_supported`.

## Open questions for review

- Is 72 hours the right maximum decision lifetime? A shorter limit makes stale
  decisions less likely; a longer one avoids re-approval when deployment is slow.
- Should the receipt read route also be open to the authority-list agent (read
  only)? This plan keeps it Board-only to avoid any new agent capability.
