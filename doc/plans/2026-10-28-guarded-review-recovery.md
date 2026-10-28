# Guarded author return binding and stranded review continuation

Date: 2026-10-28 (UTC). Design for [#87](https://github.com/phenix3443/paperclip/issues/87).
Status: proposed; requires independent review of the exact PR head.
This document grants no implementation, deployment or live recovery authority.
Runtime object IDs and individual execution approvals remain in Paperclip.

## Problem Statement

Ordinary reassignment changes who works now but retains the stored future author
return identity. A later request for changes can therefore send work back to an
unavailable author. A second case has a pending review and a board-owned stranded
action. It needs a legal current-reviewer turn to register an existing prerequisite,
without making another review decision on an unchanged deliverable.

The two cases need distinct operations. Changing a future return identity is an
explicit authorized change. Continuing a reviewer preserves every review field.
Neither operation is a review approval or a new business authorization.

## Evidence and version boundary

Read-only inspection in this run found:

- `/api/health` reports `fdbafff72d8fd6ae7f12eb5827631efc67d208f3`.
  The installed `current` symlink resolves to the matching managed installation.
  Its `server/dist/routes/issues.js` has `pendingReviewResume` and the verified
  pre-start reviewer predicate. Its installed execution-policy implementation
  prefers an existing non-null `returnAssignee` over the current assignee.
- The source base is `773d1cc4edd129816fce0d60f76c8159c6756cfe`.
  It contains additional reconciliation admission scaffolding and C1 continuation
  work absent from the installed version. Production admission is still disabled:
  `issues.ts` rejects `executionReconciliation.admission` unless the test-only
  admission option is supplied. Its presence in source is not a deployed capability.
- The independently reviewed diagnostic report referenced by the assignment was
  actually read. Its installed-function memory replay confirms ordinary reassignment
  does not update a non-null return identity, including on resubmission. This is
  diagnostic evidence, not an execution approval or proof of recovery.
- The author case currently has `changes_requested`, count 2, and a board-owned
  active `stranded_assigned_issue`; it is `blocked`, with no `executionBlocker`.
  The source adapter run started, has PID/PGID and diagnostic output, then failed
  on a monthly quota error. It is not eligible for the no-output operator action.
- The reviewer case currently has `pending` review, count 1, and is `blocked`.
  Its active action is `stranded_assigned_issue` with
  `cause=execution_review_participant_recovery`, `evidence.latestRunId` and
  `evidence.previousStatus=in_review`; `executionBlocker` is null.
  Crucially, its source run has a non-null start time, PID/PGID and 84,109 bytes of
  output. The error text `Cancelled before issue reassignment` describes cancellation
  ordering, not pre-start execution. A durable `executionReleased` record exists,
  but does not inventory its external effects. **This is not a #6 pre-start case.**

These are time-bound observations, not reusable live request payloads. No recovery
POST, source task mutation, quota change or credential access was performed.
Before implementation or execution, compare health, installation, source and
capability evidence again; never probe a live mutation to discover support.

### Sources and reuse

All source paths below are repository-relative and refer to the fixed source base.

| Source | Contract reused and limit |
| --- | --- |
| [#6](https://github.com/phenix3443/paperclip/issues/6), [#7](https://github.com/phenix3443/paperclip/pull/7); `server/src/services/execution-recovery-resolution.ts`, `isVerifiedPreStartCancelledReviewerRun` | Existing pre-start cancelled pending-review reconciliation; retain this strict predicate and its tests. |
| `server/src/routes/issues.ts`, `pendingReviewResume`, `requiresExecutionReconciliation`, `assertSafeRecoveryHandBackGates`; `packages/shared/src/types/execution-projection.ts` | Existing route, authority and cause checks. A stranded action is not automatically an execution reconciliation hold. |
| [#11](https://github.com/phenix3443/paperclip/issues/11), [#12](https://github.com/phenix3443/paperclip/pull/12), [#37](https://github.com/phenix3443/paperclip/issues/37); `server/src/services/decided-review-reassignment.ts` | Started reviewer continuation requires durable decision, stop and distinct resubmission provenance. Unstarted cancelled turns do not consume a submission; open decisions and uncertain history remain held. This is not a generic started-run permission. |
| [Owner repair design](2026-10-23-owner-repair-continuation.md), [#49](https://github.com/phenix3443/paperclip/issues/49); `server/src/services/recovery/owner-repair-continuation.ts` | Release-bound typed waits and durable execution release. A version bump or successful measurement event alone does not authorize rebinding or prove cleanup. Completed repair settlement cannot be repurposed as author replacement. |
| [Admission design](2026-10-27-native-execution-reconciliation-admission.md), [#60](https://github.com/phenix3443/paperclip/issues/60), [#61](https://github.com/phenix3443/paperclip/issues/61) | Reuse exact native authorization, canonical receipts, transactional gates and dispatch revalidation. #60 initially rejects every non-null executionState; #61 only preserves changes-requested state and returns to the same original author. Neither authorizes changing that identity or pending review recovery. |
| `server/src/services/issue-execution-policy.ts`, `applyIssueExecutionPolicyTransition` | Owns review transitions, default/null maxReviewRounds=3, participant selection and changes-requested routing. New recovery must not counterfeit a transition decision. |
| ai-team `scripts/paperclip/operator_requests.py`, `restore_refusal` and `restore`; `docs/paperclip/internal-recovery.md`; [output recovery contract](https://github.com/phenix3443/ai-team/blob/001a97718166f191e295185e5dcf80f3e9843bcf/docs/paperclip/lease-output-recovery-contract.md) | Existing operator requires todo, matching executionBlocker, no active recovery action and no process/session/log evidence. Neither case matches. No output may be relabeled not_performed to use it. |

## Solution and exact existing path

For the genuinely pre-start synthetic case already supported by #6/#7, the
existing Board-authenticated route is `POST /api/issues/:id/recovery-actions/resolve`:

```json
{
  "actionId": "<matching-reconciliation-action>",
  "outcome": "restored",
  "sourceIssueStatus": "in_review",
  "executionReconciliation": {
    "runId": "<exact-source-run>",
    "providerStopped": true,
    "actionOutcome": "not_performed",
    "outcomeEvidence": "Verified source cancellation before execution; exact evidence references."
  }
}
```

This is a route shape, not a request to execute it. It requires the issue already
be `in_review`, state pending/currentStageType=review, the run cancelled with
startedAt/processPid/processGroupId all null, and the same agent as assignee,
currentParticipant and action.returnOwnerAgentId. It also requires exact
company/issue/source-run association, an eligible reconciliation cause, stopped
resources, no live checkout/run/coordinator/successor, safe hand-back gates and
no restricted chat binding. This legacy route does not itself prove the new
transactional dependency/interaction/round-limit contract; do not treat it as #60
admission. A settled replay-blocked action can be reopened only
under the route's existing exact-action conditions, with no competing active action.
Result: in_review stays in_review; no review decision or counter change; durable
continuation targets that reviewer. Ordinary agent credentials cannot submit the
Board-only reconciliation. The current operator whitelist cannot issue this shape.

The actual reviewer case fails at least three independent requirements: blocked
status, an ineligible stranded cause and a started source run. Its action stores
latestRunId rather than the runId/sourceRunId used by that route branch. Do not
rename cause, copy run fields, PATCH status first or resolve without reconciliation
as a workaround. #11/#37 can only serve it if their full durable-decision and
resubmission proof passes; the cancellation message and lastDecisionId alone do
not prove that. Otherwise it remains held pending the narrow capability below.

## User Stories

1. As a dispatcher, I want an explicit future author-return change, so ordinary
   reassignment does not silently alter review routing.
2. As the replacement author, I want prior authors' work and review findings
   retained, so I continue the existing plan within its original scope.
3. As the current reviewer, I want a legal continuation without an invented
   decision, so I can register an existing prerequisite on my own task.
4. As an independent reviewer, I want identities, decisions and limits retained,
   so recovery cannot be used to erase unfavorable review history.
5. As an operator, I want an exact authorized receipt and real successor evidence,
   so response loss cannot trigger duplicate work.

## Implementation Decisions (future work)

### Terms and ownership

`returnAssignee` is the future author-return identity in executionState.
`returnOwnerAgentId` is the recovery action's continuation target. These fields
have different owners and must not be conflated. Historical decision actors,
document authors and contribution records never change when future routing changes.
An executionBlocker is a derived execution hold; an active stranded action is a
separate recovery obligation. Absence of the first does not resolve the second.

The execution-policy Module owns the narrowly validated return-field replacement.
The recovery Module owns exact action/source binding, settlement and continuation
intent. The existing admission Module owns authorization, receipts and locked gate
checks. Queue/dispatch owns execution admission. Routes and the host operator are
Adapters to these Interfaces; neither owns an alternative safety implementation.
No new scheduler, generic recovery engine or arbitrary state-edit Interface is needed.

### One explicit recovery intent, two separately gated variants

Extend the existing native recovery admission Interface, not ordinary PATCH.
Proposed wire name: `executionReconciliation.admission.intent`, a strict union:

- `rebind_author_return_v1`: exact old principal and new agent principal;
  target status `todo`, scope limited to remaining author revisions.
- `continue_stranded_review_v1`: current reviewer only; target status `in_review`;
  evidence mode `pre_start_not_performed` or `started_verified_outcome`.

These names are proposed, unsupported today. Existing admission requests without
an intent retain their existing semantics; #60/#61 do not become broad permission.
Unknown intent/version is 400 `capability_unsupported` without side effects.
Capabilities must explicitly distinguish base admission, preserved author hand-back,
author-return rebinding and stranded reviewer continuation. Stage support cannot
be inferred from an endpoint's existence or an HTTP 200 on another case.

Both variants use the exact authorization/receipt machinery from #60. The dispatcher
records a native-verifiable execute decision against an immutable evidence revision
and canonical payload digest. It must bind company/project/issue/action/source run,
old/new principal or current reviewer, intent, target status, full expected snapshot,
allowed remaining work and expiry. Server policy identifies the authorized dispatcher;
a role name, task comment, inherited approval or operator claim is insufficient.
The invoking identity remains a Board-authorized operator with company access.
No agent receives Board credentials or permission to mutate other tasks.

Expected binding extends #60's complete snapshot with action kind/cause/fingerprint,
ownerType/previousOwner/returnOwner, full evidence digest and updatedAt; authoritative
source-run reference including its field name; review decision-history digest;
parent, responsibleUserId, all stage/participant IDs, full executionPolicy/state,
statusVersion/lastStatusDecisionId, workspace binding and monitor/hold state.
Run, direct/context/retry successors and wakes are read with native association
rules; no transcript mention can establish ownership. For stranded actions use
server-validated `evidence.latestRunId`; do not invent a sourceRunId alias.

#### Author-return rebinding

Accept only an agent-owned author principal in `changes_requested`, count below
resolveMaxReviewRounds(policy), a current review stage with matching policy/history,
and a blocked source whose sole effective block is the exact stranded action.
Reject pending/completed/escalated/approval states and any independent business wait.
The recorded assignee and old return identity must match the approved snapshot;
a prior deliberate mismatch must be separately explicit in the execute payload.
The target must be an eligible same-company/project author of the required type,
with the required host runtime access, and no participation in the independent
review of this work. The current case requires host Claude as author and Codex as
independent reviewer; an unavailable old owner does not justify changing families.
Verify configuration/eligibility without reading or copying provider credentials.

In one transaction, replace only future executionState.returnAssignee and current
issue assignee, preserving the rest of executionState and executionPolicy exactly.
Set the source to todo through the native issue status owner, increment statusVersion,
record the real status decision, and resolve only the matching stranded obligation.
Record an append-only routing event with old/new principal, authority/revision/digest,
source action/run and pre/post snapshots. Historical recovery owner/returnOwner,
source run and review decisions remain unchanged; the receipt explicitly carries
new continuation target, rather than falsifying the old action's return owner.
Delivery must use this receipt target, not the generic old-returnOwner worker.

Submitting the new author's result must return to the same independent review
stage; a further request for changes returns to the new author. Count 2 remains 2
at rebinding. The next agent request for changes reaches 3 and invokes the original
responsible human gate. Missing/null maxReviewRounds stays 3. No count or decision
reset, policy rewrite, new task, reassignment loop or implicit self-approval is allowed.

#### Stranded pending-review continuation

Accept only board-owned active stranded_assigned_issue with the exact review recovery
cause, pending review state, current assignee=currentParticipant=action.returnOwner,
and the exact recorded source run. Preserve returnAssignee, participant, stage,
all history and count, including lastDecisionOutcome=changes_requested within a
pending state. No review decision is inserted and no deliverable is approved.

The blocked→in_review change must be a native recovery status restoration bound to
the action that produced the blocked projection. Require original in_review→blocked
activity/status-decision provenance, same full state/policy and no unrelated status
change. `evidence.previousStatus` alone is insufficient. If historical provenance
cannot be established, refuse; require a newly authorized native projection-repair
record as a separately reviewed extension, never a host PATCH or fabricated history.

For a genuinely pre-start source, reuse #6's predicate plus source/event/output,
provider/session, lease and execution-release checks; an error string alone never
proves not_performed. For a started source, require the existing output contract's
complete action inventory, artifacts/digests and stopped-resource proof, bound to
this intent. Every effect must be completed or not_performed with evidence; unknown,
unreadable or ongoing effects refuse. Completed/mixed outcomes retain completed
work and allow only the remaining coordination, without repeating external actions.
The real started reviewer case cannot proceed until ops supplies that inventory.

The resulting reviewer turn may register the already-created implementation
prerequisite using the source task's own run and existing native authority. It then
waits for the prerequisite/new deliverable. It must not request changes on an empty
diff, add a review round, create a duplicate prerequisite or write another task's
blockedByIssueIds. C1 dispatchers retain ownership of their source fields.

### Transaction, concurrency and durable delivery

Reuse #60's L0–L11 lock order and serializers for authorization, company/agent/tree
holds, issue, action/run/wake/lease/workspace, dependencies, decisions, interactions,
approvals and monitors. Include both old and target agent eligibility rows in stable
ID order at their existing owner-lock level. Any incompatible new lock order must
be designed and reviewed before implementation. Gate writers and both admission
and dispatch must use the same protocol; host prechecks cannot close a race.

Under locks: authenticate → read same-key receipt → compare complete snapshot →
verify immutable revision, current dispatcher authority and expiry → validate intent
and stopped/effect evidence → reject newer execution/successors/wakes or any gate
→ apply minimal routing/status/action changes → persist receipt and delivery intent
plus audit in the same commit. No action resolution before durable delivery intent.
Rollback leaves no action/status/state/wake/run mutation; refusal audit may be separate.

Use #60 canonical digest and company+key uniqueness, additionally fence the same
action/source/intent consumption across different keys. Same key+same payload returns
the original receipt, even after status changed. Same key+different payload is 409;
different keys cannot consume the same obligation twice. Receipt includes pre/post
state digests, exact authorization, old/new routing, target status/agent and durable
continuation identity. Keep the receipt/tombstone for the obligation's lifetime.

The existing durable worker/queue, extended for the receipt's explicit intent,
rechecks target identity, authority/revision validity and all gates under dispatch
locks. One admitted obligation yields at most one successor; coalescing into the
source run is forbidden. Crash after commit resumes the same receipt. A cancelled
unstarted turn must follow #37's proved unserved-turn semantics, without minting
new authorization, review decisions or counters. Started turns are never silently
replayed. Stop, reassignment or revoked authorization invalidates old delivery;
valid typed waits retain their exact release provenance as in #49, not an arbitrary
version rebinding. No durable evidence means no claim of successful continuation.

### Refusals and operator slice

Reject live/queued/claimed execution or conflicting checkout, unresolved leases or
coordinator, unknown process ownership/effects, newer terminal execution, wrong
company/owner/family/reviewer, target participation conflict, exhausted rounds,
open decisions/interactions/approvals, dependencies, pause/Stop/budget, stale
workspace/policy/state/monitor, expired/superseded authorization or incompatible
chat/native-workspace recovery. Never turn a refusal into a different intent.

The ai-team host slice is necessary only after the corresponding native capabilities
deploy. Add strict allowlisted actions `rebind_author_return` and
`continue_stranded_review`, accepting only action, exact authorization reference and
reason. The approved payload owns the tuple, intent and target. No arbitrary path,
method, state patch or generic Board proxy. Keep restore_execution_recovery unchanged.
Re-read external artifacts before/after the call, keep evidence outside Git and
report native refusals. Absence of executionBlocker alone is not operator success.

## Testing Decisions and acceptance

Design-only checks verify scope, sources and document structure. Future implementation
must test observable route/receipt/queue behavior with real isolated PostgreSQL
transactions, not just a pure predicate or FakeApi. Reuse issue-recovery-actions,
issue-agent-mutation-ownership-routes, execution-recovery-resolution, decided-review-
reassignment and heartbeat-process-recovery fixtures. Do not exercise real tasks.

| Fixture / competing event | Required observation |
| --- | --- |
| Existing genuine #6 pre-start case; repeated resolve/sweep | Same in_review/state/decisions/count, one reviewer turn; original counterexamples stay refused. |
| Realistic stranded started reviewer with cancellation text | Pre-start mode refuses; missing/unknown effect inventory refuses without writes. |
| Proven started reviewer, exact blocked projection and known effects | One current-reviewer successor; pending state and count 1 unchanged; prerequisite registered only by its own run; no review decision. |
| Count-2 author replacement | New author/current assignee bound explicitly; all other state/policy/history intact; subsequent done returns to reviewer; next changes request escalates at default 3. |
| Exhausted/null/default/explicit round limits; approval/human escalation | Correct limit retained; no agent author substitution or reviewer turn on exhausted state. |
| Wrong actor/company/role/principal; reviewer participated in authoring | 401/403 or specific conflict; no target or history mutation. |
| Live lock, lease/PID unknown, newer run, direct/context successor, queued wake | Atomic refusal, no resolution, new delivery or duplicate execution. |
| Pause/approval/decision/interaction/dependency/monitor/authorization mutation | Both commit orders with independent DB connections: admission refuses or later dispatch is held/invalidated; no provider starts through a closed gate. |
| Same-key identical/conflicting requests; different keys same obligation | One receipt/settlement/successor maximum; conflict cannot overwrite evidence. |
| Crash before commit, after commit, before wake and after wake before receipt update | Rollback or durable resumption of same obligation, no lost delivery and no duplicated run. |
| POST response lost; receipt absent/committed/abandoned/unreadable | Reconcile original key via #60 receipt lookup/settle; committed result is reused, unreadable stays uncertain; never blind retry or new key. |
| Artifacts/PR/head change after inventory; unknown external operation | Refuse or stop acceptance for re-evidence; no not_performed relabeling. |
| Unrelated status bump while waiting; cleanup not settled | #49 release provenance and execution-release checks hold; no continuation. |
| #11/#37 decided-review proof and cancelled-unstarted turn | Reuse only matching submission; open decision/uncertain history stays held. |
| Old server or partial deployment / unsupported intent | Explicit capability refusal; no fallback to host PATCH, old resolve or cleared state. |

Recovery acceptance requires the exact receipt, action and pre/post invariant
comparison plus a distinct real successor with correct company/issue/agent,
source lineage, actual start/useful output or a verifiable native wait. A wake receipt,
resolved action, cleared hold, changed assignee or queued label alone is insufficient.
Business delivery remains a separate outcome and must obey the original plan-only scope.

## Delivery slices and bootstrap

1. **Native admission foundation:** finish and independently review #60, and its
   gate/receipt/authorization/worker prerequisites. #61 remains the same-author
   changes-requested increment; do not redefine it as author replacement.
2. **Native author-return increment:** separate focused Issue/PR for the explicit
   routing change and receipt-target delivery above, dependent on the foundation
   and applicable stage support. Synchronize db/shared/server/client/docs/maps.
3. **Native stranded-review increment:** separate focused Issue/PR for exact blocked
   projection restoration and pre-start/verified-started review continuation.
   Reuse #6/#11/#37/#49 and foundation primitives; do not duplicate their schedulers.
   It does not need to wait for author replacement if its own prerequisites are ready.
4. **Host operator Adapter:** separate ai-team Issue/PR only for deployed intents,
   strict whitelist, response-loss handling and internal-recovery/runbook updates.
   Run its repository checks and old-action regression suite; use synthetic tuples.
5. **Ops deployment and separate acceptance:** CTO schedules independently reviewed
   exact heads; ops installs approved native artifacts, verifies health commit,
   migrations and explicit capabilities, then releases the operator at its approved
   SHA. A separate untouched reviewer accepts isolated end-to-end evidence.

Bootstrap must not depend on reviving either stranded business task. Use a separate
CTO-assigned development/deployment path with working identities. Configure the
native dispatcher authority through its approved Board-only setup path, verify
immutable revision/digest decision support and isolated receipts, then enable only
the corresponding operator actions. No database edits, self-grants or temporary
broad permissions. A partial #60 release keeps both review intents unsupported.

Only then may CTO issue fresh, tuple-specific execute decisions in the original
recovery coordination, with ops supplying stopped/effect evidence. Each C1 dispatcher
updates its own task fields from its own run. Independent acceptance compares all
invariants and successor evidence; business authors/reviewers continue their own work.
This design's merge does not authorize any of those operations or unblocking tasks.

Rollback disables new intents/operator actions and preserves receipts, source runs,
history and completed work. A missing capability fails closed. Already committed
routing changes and successors cannot be undone by deleting receipts or rewriting
executionState; any corrective action needs fresh authority and current evidence.

## Out of Scope

Runtime implementation, actual recovery, provider login, credential/lease manipulation,
quota reset/payments, installation/deployment/restart, business code or external project
operations, other recovery cases and a new scheduler. No source task, dependency,
participant, responsible human, contribution history or review counter is rewritten
by this document. Exact live identities and execution payloads stay in Paperclip.
