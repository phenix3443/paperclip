# Preserve approval progress during reassignment

Date: 2026-10-30. Design revision: 2. Scope: design only.
Tracks [issue #240](https://github.com/phenix3443/paperclip/issues/240).
This document specifies proposed behavior; none of its recovery operations is deployed.

## Problem statement

Board reassignment of a pending review or approval to a non-participant can clear
`executionState` while leaving the policy and decision history in place. A later
`done` or `in_review` request then starts the first review. This loses the cursor,
not the historical decisions. Replaying reviews would change responsibility and
can reset the effective review limit.

The supplied, independently checked incident evidence identifies deployment
`6cda8f0c46636f8abd42375e57794cff59da258a` (0.3.1). A pending approval at index 2
had two completed review stages, an approved last decision, and a change-request
count of zero. Reassignment cleared the state; source revalidation cancelled the
historical recovery action. No active action remains. The existing recovery
resolver cannot import a cursor; the pre-start reviewer exception excludes approval.
Policy CAS protects a policy edit but cannot restore missing state.

These are inherited diagnosis results, not a new production investigation. Private
activity, task, participant and account identifiers stay in the internal handoff.
Durable decision rows were not individually audited by that diagnosis. Their
provenance remains a mandatory recovery precondition, not an established fact.

## Solution

Deliver two separate results:

1. Prevent future cursor loss in two paths: unsupported assignee-only reassignment,
   and reconciliation of a live stage with no eligible participant. Use existing
   participant selection and policy CAS for supported moves.
2. Keep an already lost cursor blocked until a separately authorized native repair
   can derive it from verified history. A preventive patch alone cannot repair it.

A normal assignment request must never double as an approval or historical import.
A successful recovery restores a pending gate, not a delivered task.

## User stories

1. As an operator, I want an unsupported reassignment rejected without losing progress.
2. As an operator, I want an explicit participant edit to retain stage and participant IDs.
3. As a successor, I want to verify delivery without inheriting another person's past decisions.
4. As a reviewer, I want completed reviews and their decision authors to remain unchanged.
5. As an approver, I want the pending approval to remain required after recovery.
6. As a responsible user, I want escalation and consecutive-change limits preserved.
7. As a paused author, I want recovery to leave my account and execution stopped.
8. As an operator, I want stale, ambiguous and repeated recovery requests to fail safely.
9. As an auditor, I want to trace a repair to its source evidence and authorized actor.

## Implementation decisions: prevention

The issue execution-policy transition module owns stage semantics. The ordinary
issue mutation transaction owns locking, assignment, decision persistence and
audit. The route owns authentication, company/task access, assignment permission
and transport validation. The UI reports the rejection and reuses existing policy
controls. Neither a plugin nor a new orchestration service owns this correction.

For a live pending review or approval:

- An assignee-only Board request to an eligible participant re-pends the same stage.
  Preserve all completed IDs, last decision/outcome, review request, return assignee,
  change count, escalation evidence and unrelated monitor state. Generate no decision.
- Reject unassignment or assignment to a non-participant with `422` and a stable
  conflict reason. Leave status, assignment, policy and state unchanged. Validate
  before stopping an execution or accepting comments/uploads; recheck the exact
  transition inputs under the existing issue transaction lock before commit.
- To select a new approver, an authorized policy editor first performs a policy-only
  `executionPolicy` plus `expectedExecutionPolicy` CAS. Retain the active stage ID
  and its participant slot ID; change only that slot's principal. Preserve the two
  completed stages and all historical principals. Then reread and make the ordinary
  supported assignment, if the policy edit has not already reconciled assignment.
  This sequence has two transactions: a failed second step retains the gate and
  the explicit policy change; it must never clear state to finish the move.
- Reject a policy edit that retains the live stage but leaves it with no eligible
  participant after excluding `returnAssignee`. Use the same selection rules as
  reconciliation, not merely a nonempty participant array. Removing the current
  participant without a replacement, or leaving only `returnAssignee`, is rejected.
  An eligible alternative allows reconciliation within the same stage. The explicit
  slot replacement above must preserve completed-stage and counter provenance.
- If the stored live stage already has no eligible replacement, an unrelated PATCH
  must never call `clearExecutionStatePatch`. An untouched blocked hold stays blocked
  with its cursor intact; otherwise reject with `422` before effects, retaining the
  full issue snapshot. A failed request need not write `blocked`. This also covers
  a missing current participant. An authorized policy-only CAS that supplies an
  eligible participant can repair membership without importing or resetting state.
- An escalated human participant remains authoritative even if absent from the
  configured participant list. Apply this exception before ordinary membership
  validation: an agent candidate is not required to sustain the human hold.
  Neither assignment nor policy editing may turn that hold back into an agent review.

An untouched blocked gate stays blocked. Same-assignee requests are idempotent.
Ordinary supported reassignment retains completed IDs and does not restart completed
reviews. These guarantees apply to a retained cycle, not a deliberately abandoned one.

### Inventory of clearing paths and the scope of classification

The following references are to `server/src/services/issue-execution-policy.ts` at
revision 1's source HEAD `d700bdf6ba01173b9f19c36bc7816a3a04b7904b`. Line numbers
identify the reviewed baseline, not a new runtime implementation.

| Existing path | Classification and revision 2 behavior | Evidence used by the transaction |
| --- | --- | --- |
| No policy, L697-705 | Existing policy removal/absence cleanup; preserve existing behavior, including return-to-executor behavior | Locked current policy/state and the authorized request's policy removal, if any; history alone cannot prove explicit removal |
| Terminal done/cancelled reopened, L707-713 | Deliberate new cycle; preserve clearing and allow later normal first-stage start, even with old decisions | Locked terminal status and authorized requested nonterminal status |
| Stored stage ID absent from replacement policy, L714-741 | Existing policy replacement/abandonment semantics; preserve the live-cycle `done` rejection and other allowed clear/return paths | Locked old state, effective policy and policy CAS/request; a pre-existing mismatch without an explicit edit is ambiguous historical drift |
| Board pending done/cancelled, L658-662 | Existing explicit terminal override; preserve clearing and terminal status; neither override fabricates an approval | Authorized Board actor, explicit requested terminal status and locked pending state |
| Live participant no longer belongs and selection fails, L796-813 | Accidental loss; reject the causing policy edit and retain/reject already-invalid state as described above | Effective live stage, stored participant/returnAssignee and actual eligible selection, after the escalation exception |
| Board assignee-only non-participant/unassign, L948-976 | Accident path; reject with `422`, preserving snapshot and all decisions | Authorized assignment request, locked live state and effective stage membership |

Classification here is an in-transaction branch decision using the locked snapshot
and explicit request. It does not require scanning historical decisions. Explicit
terminal operations keep their existing precedence over the assignee-only rejection;
a combined Board done/cancel plus assignment request is not silently reclassified as
assignee-only. Other pending status overrides retain their existing rejection rules.
The two new guards must not intercept legitimate terminal/reopen paths. A live policy
edit that retains a stage but strands its participants is the new rejection; blanket
rejection of policy removal, stage-ID replacement, completed-stage edits or limit
lowering is not part of this minimum patch. Existing validation still applies.

### Historical null detection is a separate capability gap

There is no established durable cycle-abandonment discriminator in this proposal.
The ordinary route records `issue.updated` with `details.changes`, `details._previous`,
updated fields and actor/run attribution. Reopen logging can also supply
`details.reopened` and `details.reopenedFrom`. These are candidate evidence for
individual investigation, not a demonstrated complete, atomic cycle ledger covering
every writer, retention gap and historical deployment. Decisions alone cannot
separate an intentional new cycle from a lost one; a first-stage loss may have no
decision at all. This revision therefore withdraws the general history-based
null-state fail-closed guard from the minimum prevention patch. It adds no historical
lookup, inferred abandonment marker or restart ban for tasks with old decisions.
Fresh tasks and legitimate reopen/policy replacement continue their normal start.
The known lost incident remains blocked by its existing operational hold; the minimum
patch does not automatically identify or protect every legacy null-state task.

CTO must separately decide whether to authorize a durable classification contract in
the existing mutation/audit transaction, with explicit transition reason, cycle
identity, before/after state and policy, actor and version binding. This is a gap,
not an existing action name or permission to add fields now. Until complete coverage
is proven, an ambiguous historical null remains unclassified: do not reconstruct it
or claim that ordinary advancement is globally blocked. Any future guard must use
proven loss evidence for the current episode, honor later proven abandonment, and
permit a fresh cycle after legitimate reopen/replacement. Incomplete history must
never become evidence that a task is fresh or that it lost a cycle.

Optional broader changes for CTO: reject Board done overrides, retain state on
cancellation/reopen, or prohibit all destructive live policy changes. These alter
existing escape semantics and are not prerequisites for the two-path correction.
If selected later, define their abandonment evidence and migration behavior together
with the classification contract; do not infer the new semantics from old null rows.

## Implementation decisions: incident recovery gap

**Current capability:** unavailable. The cancelled recovery action cannot be revived
or used with the active-action resolver. Ordinary PATCH has no supported state-import
field. A scheduler, plugin, direct SQL, installed-file patch, or policy-only CAS is
not a substitute. Keeping the incident blocked is the safe present behavior.

**Recommended next scope decision:** after design approval, ask CTO to authorize a
narrow repair variant in the existing issue-update contract and transaction. It is
new recovery capability even though it uses an existing route. Do not implement it
under this documentation task. No new table, route, scheduler, feature flag, generic
`executionState` import, or privileged host command is proposed.

The variant accepts source identifiers and expected snapshots only; the server derives
all restored fields. It must not accept caller-supplied completed IDs, decisions,
counters, actor ownership, or arbitrary state. Reject mixed ordinary mutation fields.
Its minimum contract, conditional on that later authorization, is:

1. Require the existing Board/operator mutation authority, task/project visibility,
   company boundary and assignment/policy permissions. Deny agents, viewers and
   low-trust callers; CTO's orchestration decision is not an API credential or a
   privilege grant. Ops must establish an actually supported authorized caller.
2. Bind company, issue ID, expected status and `statusVersion`, expected null state,
   current full policy, assignment, responsible user, source clearing activity ID,
   and the exact historical state/policy evidence being used. Include the intended
   successor and expected paused-author identity/status. Compare full normalized
   values, not hashes supplied as proof. Server canonical hashes identify the receipt.
3. In the normal authority/hold lock order, lock the issue and relevant participant
   availability rows; recheck current permissions, pauses, budget, active execution,
   queued wakes, interactions and recovery actions. Require no conflicting work or
   live execution; do not stop, cancel, clear locks or resume accounts as part of repair.
4. Load the source activity in the same company and issue. Verify its server-recorded
   actor/authorization, before-state and null after-state, and predecessor transition.
   Load the referenced durable decision rows and their run/actor provenance. Verify
   stage ID/type, historical eligible principal, outcome, order, approvalsNeeded and
   completed-stage evidence. Prove lastDecisionId/outcome and consecutive change count
   agree with that chain, including any human reset and escalation. Missing policy
   snapshots, deleted principals/runs that prevent proof, duplicate/ambiguous chains,
   or unknown state fields fail closed. Do not infer authorship from comments.
5. Establish one continuous loss episode: inspect intervening issue mutations. Permit
   only evidenced blocking/diagnostic changes that leave policy, ownership and cycle
   semantics intact. A new decision, execution, cancellation, policy edit, ownership
   change or competing repair requires a fresh scope decision, not relaxed comparisons.
   In particular, the historical activity version is not the current expected version;
   both the old transition and the current blocked snapshot must be independently bound.
6. Derive the pending state from that verified pre-loss snapshot. Preserve every stage
   and participant slot ID, completed stages, last decision/outcome, review count,
   review request, escalation and unrelated monitor state. Do not insert/update any
   historical decision. The final approval remains pending. Do not rerun completed reviews.
7. Keep the Board-selected successor responsible for follow-up and final verification.
   Historical approval remains attributed to its original reviewer. For this incident,
   authorize only the pending approval participant slot's principal to become the
   selected successor; do not rewrite completed-stage participants. If this recovery
   changes policy, compare `expectedExecutionPolicy` and apply that limited edit in the
   same repair transaction. This is an explicit exception to ordinary policy-only PATCH,
   and therefore part of the later scope decision, not an existing supported API.
8. Keep the original returnAssignee identity. Its manual pause is not a reason to edit
   it. A request-changes decision must persist that decision/count and leave a blocked
   return path, with no wake to the paused author and no implicit implementation transfer.
   Resuming that author or choosing a replacement requires a separate explicit owner
   decision. Approval follows ordinary completion gates; no recovery-supplied verdict.
9. Commit repaired state, any authorized participant adjustment, version increment and
   content-free repair audit receipt atomically. The receipt records source activity,
   historical decision references, actor/run, request fingerprint, before/after versions
   and state/policy hashes. Store it in the existing activity log; an audit failure rolls
   back the repair. Preserve existing status (`blocked`) and successor assignment. Only
   a later explicit, authorized transition can activate the pending participant.
10. Under the issue lock, use source activity as a once-only repair identity. An identical
    principal/request retry may return the stored receipt without any write or wake only
    while the current snapshot exactly equals its recorded post-state/version. A changed
    request, principal, policy, version or later null state rejects as stale/consumed.
    Search committed receipts for the source before applying; serial issue locking makes
    duplicate requests mutually exclusive without a new uniqueness table. No read from
    comments and no in-memory idempotency cache. If existing activity persistence cannot
    meet atomicity/provenance, stop and return that specific gap to CTO.

Return `403` for denied authority, `404` for inaccessible evidence, `409` for stale or
consumed snapshots, and `422` for unsupported/ambiguous evidence. All failed checks
leave source policy/state/decisions/assignment unchanged and create no wake. Existing
HTTP security logging can record denial; it cannot serve as a success receipt.

Alternatives for CTO: ship prevention first and retain the incident blocked; or approve
the narrow existing-transaction repair after its feasibility test. A generalized import,
new recovery endpoint or host database edit is outside this proposal. If authoritative
historical proof is absent, neither option permits a fabricated restoration.

## Testing decisions and acceptance matrix

Use the existing ordinary issue PATCH and transaction persistence seams, with synthetic
company/issue/decision fixtures. Policy-function tests explain transitions but cannot
prove authorization, concurrency, stop ordering, audit atomicity or wake delivery. Prefer
route-plus-database tests for those guarantees. No production fixture or credential is
required. The following are required assertions for later implementation, not tests
reported as passing by this design PR.

| Case | Observable acceptance |
| --- | --- |
| Pending review and approval; eligible reassignment | Same stage/index, IDs, decisions, count and return owner; no fabricated decision |
| Assignee-only non-participant or unassign | 422 before stop/upload/comment effects; complete source snapshot unchanged |
| Board done/cancel, including combined assignment | Existing explicit terminal override succeeds and clears state; no fabricated decision; existing rejection of other pending statuses survives |
| Completed reviews/workflow | No completed review restarts; completed workflow remains complete |
| Policy slot replacement | Exact CAS; only pending principal changes; stage/slot IDs and old decision actors retained |
| Live stage loses eligible participants | Remove current principal without alternative, leave only returnAssignee, or remove all candidates: policy edit rejected with exact snapshot preserved |
| Already-invalid live membership | Unrelated PATCH rejects or preserves untouched blocked hold; cursor never clears; eligible policy-only CAS repairs membership in the same stage |
| Escalated human outside configured list | Human hold survives candidate validation even without an eligible configured agent |
| Policy removal/stage-ID replacement | Existing clear/return behavior survives; existing live-cycle done rejection survives; later permitted new cycle starts normally with old decisions still attributed |
| Escalation and limits | Human hold sticky; default/null limit 3; third consecutive agent change request escalates; explicit limits survive |
| Fresh null and legitimate reopen | Fresh issue starts first stage; done/cancelled issue with old decisions reopens and later starts normally; no history-based false rejection |
| Known lost null or decision-free loss | Incident remains operationally blocked; minimum patch claims no automatic legacy-null detection; missing/ambiguous proof refuses repair |
| Future classification contract (conditional) | Proven current loss blocks restart; proven later abandonment permits a new cycle; incomplete history cannot classify either way |
| Authentic recovery | Exact verified chain restored pending at index 2; blocked successor unchanged; zero decision inserts |
| Wrong source/tenant/actor/run/stage/outcome | Denied or invalid; no writes, no wake, no evidence leakage |
| Concurrent policy/state/version/owner drift | One admissible winner; stale request rejected under lock, even if statusVersion alone did not change |
| Concurrent pause/budget/authority/queued work | Gate closes before commit; no repair or dispatch through that gate |
| Retry, response loss and replay | Same post-state returns one receipt; altered retry/later null cannot reuse consumed source |
| Paused return author | Changes requested persists count/decision, blocks hand-back, does not resume or wake author |
| Successor approval and external delivery | Restoration grants no approval; open upstream PR prevents final delivery; new code needs independent review |
| Failure injection | Evidence/audit/state/policy failure rolls back repair; no partial cursor, policy, decision or wake effects |
| Post-commit publication failure | Committed receipt remains inspectable; no duplicate repair, decision or wake on retry |

Minimum red/green path after authorization: reproduce non-participant clearing in the
existing policy test; reproduce failed participant reselection; add route rejection,
preservation and the terminal/reopen/policy-replacement counterexamples above.
Exercise actual persistence for concurrent policy CAS. Add receipt deduplication,
injected audit failure and recovery tests only after recovery scope is granted.
Historical classification tests are conditional on its separate scope decision.
Relevant existing suites are
`issue-execution-policy.test.ts`, `issue-execution-policy-routes.test.ts` and
`issue-execution-policy-persistence.test.ts` under server tests. Identify recovery test
fixtures at implementation time; do not mistake a mocked route for a durable transaction.
Run only affected Vitest files locally with a whole-command time limit. Run typecheck,
full tests and build in GitHub CI, never the constrained host.

## Out of scope and delivery gates

This PR changes documentation only. No source task policy/state/dependency mutations,
production probes/recovery, runtime code, packages, schema, deployment, restart, account
resume or new credentials are authorized. It does not reopen review of the background
upstream contribution or close that contribution.

The author submits exact document revision, plan-document revision and PR HEAD for an
independent different-type reviewer. Only the approved HEAD may merge to `develop`.
Verify CI, merge commit and closure of #240 before final completion; non-default-branch
merge may require explicit issue closure. Implementation, deployment and real recovery
remain separate CTO dispatches. Future runtime fixes also require upstream submission.

Reverting this docs PR removes the design only. A runtime rollback must not clear any
retained/repaired cursor or reverse decisions: stop further repair attempts, leave affected
work blocked and obtain fresh evidence. Never undo recovery with a null-state write.

## Evidence available and evidence still required

Available: independently checked deployment diagnosis and source-transition evidence;
existing route/transaction ownership and targeted suite names; this inspectable design.
Private source IDs and exact historical SHA remain bound in the task plan/handoff.

Still required: CTO scope decisions for optional escape-semantics changes and durable
historical-null classification; individual durable decision/provenance verification; proof that retained
activity has the full historical policy/state needed for safe restoration; authorized
caller availability; all red/green and concurrency/fault tests; deployed-version and live
read-back evidence. CI passing on documentation proves none of those runtime outcomes.
