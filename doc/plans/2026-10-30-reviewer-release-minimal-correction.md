# Minimal reviewer release continuation correction

Date: 2026-10-30 UTC. Design issue: [#234](https://github.com/phenix3443/paperclip/issues/234).
Status: proposed design and interface-gap disposition, awaiting exact-head independent
review. **No runtime implementation is authorized.**

## Problem and decision requested

A valid original reviewer assignment must survive predecessor cleanup, transient
holds and a controller failure, without applying an old submission to a new one.
[#211](https://github.com/phenix3443/paperclip/pull/211) delivers ordinary skipped
wakes on one executor-release event. [#219](https://github.com/phenix3443/paperclip/pull/219)
adds deferred-owner delivery but explicitly excludes pending reviewers and review-stage
wakes. Neither establishes the full [#133](https://github.com/phenix3443/paperclip/issues/133)
contract. Keep #133 open and #134 closed.

The smallest safe direction is to deepen the #211 release owner, preserving ordinary
queue admission as the sole run creator. Adding generation comparison alone fixes
a safety defect but cannot provide durable delivery. Current interfaces do not
connect an ordinary skipped assignment to a durable pending obligation or atomic
successor association. **Stop before implementation at this missing primitive.**
The options below are a concrete scope decision for the delivery owner; approval
of the evidence alone must not be treated as approval to implement an option.

This is a future-only correction. The historical five skipped assignments remain
diagnostic (option B). No adoption, live recovery, business replay, reviewer
replacement, production database inspection or deployment is authorized.

## Fixed versions and evidence

| Reference | Exact version / result |
| --- | --- |
| Analysis base, refreshed `origin/develop` | `ef5f04157907ecf96a7698afb4daac3aee899b64` |
| #211 head / merge | `f2590ef1f773c99133cfb10656ec9e9d344aa6ce` / `d4e335a89d3e0a206b1bd1520f2ab04ae5585f07` |
| #219 head / merge | `67b24673e44a04e8df83149a01c79c2eae73a8d0` / `a3e51336ea1f99bede1cccdbe3546df7ac6c495e` |
| Original amended plan | [#136](https://github.com/phenix3443/paperclip/pull/136), `4dea5cabb41256a359c73f7a93e2fe796e7bde62` |
| Replacement report | Immutable report revision `fa07e6a9-470f-4ad5-a9fa-de1e874dfee9`; second-stage review `8bb14e83-c13f-41b4-8981-216c29c455bf`, 2026-10-30; report approval only |
| Initial design PR | [#235](https://github.com/phenix3443/paperclip/pull/235), opened before diagnostic edits; initial head `4892be2997` |
| Final design head / plan revision | Recorded in the PR and native review submission, outside this self-referencing file |

The replacement report and independent comment were read through the authenticated
task API. #133, #234, #211, #219 and their Git objects were read through host Git/gh.
The old #134 branch/worktree was not changed. No old test result is attributed to
the current base. Diagnostic source and execution limitations are in the separate
[probe record](2026-10-30-reviewer-release-minimal-correction.diagnostic.md).

## User stories and retained contract

1. The reviewer receives one assignment for the exact submission that selected it.
2. The author can finish cleanup without overlapping the reviewer or resubmitting work.
3. An operator can pause work, restore a temporary hold, or Stop it with distinct outcomes.
4. A controller can restart without losing pending delivery or repeating accepted work.
5. A reviewer can inspect unchanged policy, state, decisions, counts and responsibility.
6. Other ordinary comments, interactions, retries and agents keep their existing behavior.

## Actual owners on the base

Paths below are repository-relative. They identify current implementation, not proposed hooks.

| Owner / interface | Current behavior and gap |
| --- | --- |
| `heartbeat.ts:3913–3926` | After real cleanup, terminal state, and absence of native-resume/workspace/ownership holds, writes `executionReleased`, calls #211 selector then enqueue, then #219. Selector/enqueue failures warn. Marker commit and queue admission are separate. Only this production site calls the #211 selector. |
| `heartbeat/released-execution-wake.ts` | Locks company-scoped issue; selects latest ordinary `skipped/execution_reconciliation_required`; checks current assignee, pending stage ID/agent, newer runs and live wakes. Returns options with `execution-release:<releasedRunId>:<receiptId>`. It neither consumes the receipt nor saves complete generation, due time or successor association. Its live-wake query lacks the ordinary namespace predicate. |
| `heartbeat/deferred-owner-wake.ts` (#219) | Selects oldest ordinary deferred wake per other agent. Excludes ended agent, pending reviewer and payloads with `executionStage`; handles pending interactions separately. Admission followed by separate retirement. Also called from `run-control.ts` cancellation and `queue.ts` stale dispatch, and heartbeat stale checkout. These remain ordinary-owner duties, not reviewer recovery hooks. |
| `heartbeat/queue.ts`, `execution-wait.ts` | Admission owns real gates and issue locking. Automatic assignment blocked by cleanup becomes a terminal diagnostic via `recordExecutionWait`. Saved comment/interaction/status duties can use different deferred paths. No caller-provided payload is a server generation proof. |
| `heartbeat/case-handoff-lifecycle.ts:252–305` | `recordRunExecutionReleased` saves evidence; `isRunExecutionReleased` can reconstruct proof only from existing process/provider/cleanup evidence. Case handoff and recovery callers use it for their own duties. It does not notify or reconstruct #211 ordinary skipped delivery. Terminal status alone is insufficient. |
| `native-runtime/native-finalization-reconciler.ts` | Resumes workspace finalization, commits decisions, dispatches its own durable effects; invokes `onWorkspaceSettled` on completed workspace paths. A committed status decision is not proof that process and leases have released. |
| `heartbeat/recovery.ts:2048–2083` | `settleRecoveredNativeWorkspace` releases environment leases/runtime services and finalizes agent status. It does not call #211. |
| `native-local-process-stop.ts:147–229` | `releaseSettledNativeRunProcess` validates terminal run/coordinator, provider evidence and leases, then clears process identity. `discoverSettledNativeRunProcesses` and retry handle late process release. They do not call #211. |
| `heartbeat/reviewer-assignment-continuation.ts`, `queue.ts:5486`, `index.ts:1411` | Namespaced intent consumer and existing `executionContinuation` registration are already present from earlier merged slices, including deadline calculation. Search finds no production caller of `createReviewerAssignmentIntent`. This consumer handles its own reserved rows, not #211 ordinary skipped rows. Its presence does not prove reviewer delivery. Do not activate its producer or restore #134 as the remedy. |
| `execution-control-work.ts`, `delivery-work-coordinator.ts`, DB work signals | Shared worker, deadline, transaction notification and startup/drain machinery exist. Their current pending predicate excludes #211 skipped rows. Infrastructure availability is not an established durable owner for this class. |

### Native release order must converge on one owner

For workspace-before-process, workspace success may still leave process ownership;
late `releaseSettledNativeRunProcess` is the final proof. For process-before-workspace,
workspace finalization/recovery remains the last gate. Executor teardown can also
be the last owner when neither path is deferred. Each must expose settled evidence
to the same reviewer release owner, and that owner must recheck *both* conditions
under current admission authority. None may create a reviewer run directly.
Existing callbacks and process-release outcomes identify potential integration
sites; no current callback covers every order plus durable retry. Native dual-order
automatic delivery is unexecuted in this design run and remains a required test.

## Minimal correction contract, subject to the interface decision

### Immutable generation and future eligibility

At the first authorized native reviewer handoff, while company/issue and review
transition state are serialized, save the original receipt identity plus:

- Company, issue, selected reviewer, assignee agent/user and responsible user.
- Complete raw `executionPolicy` and `executionState`, including reviewRequest,
  returnAssignee, participant identity, completed stages, decision IDs/outcomes,
  changesRequestedCount and missing/null/default review limits.
- The decision-row evidence for this submission, source run and source agent,
  authorized actor identity, source issue binding and original wake context.

Reuse the existing canonical `issueExecutionGeneration` for the fields it covers:
full policy/state, assignee and responsible user. It does **not** include decision
rows or source run identity; the owner must bind and compare those separately.
Canonical object key order must be stable; array order and raw null/missing policy
semantics must not be normalized into a new review state. Effective default/null
maxReviewRounds remains three. Never update an old receipt's immutable identity
when another signal arrives. A valid new submission gets a new receipt identity.

Only receipts first saved by this server-owned transition after the future producer
is approved qualify. An older `createdAt`, presence of a payload key, caller digest,
stage ID or matching reviewer is not provenance. Missing proof means diagnostic
only, with no automatic promotion; this must apply to #211's selector too. No
backfill or timestamp-only deployment cutoff is proposed. Public inputs must not
forge, overwrite or copy the server-only identity. Read current authority again at
admission and dispatch; stored identity never grants access after revocation.

### One delivery responsibility and atomic settlement

#211's owner should reconcile an obligation, rather than return arbitrary old wake
options to callers. Cleanup/native/gate notifications are hints to that owner.
Ordinary queue admission remains the sole run creator. Inside its existing locked
transaction it must compare immutable generation/source/current authority, then
associate the original receipt with a matching queued/running/scheduled_retry
successor or create and associate one successor. A same-submission receipt from
another release/source actor must coalesce under the same canonical submission.
A release-specific key is insufficient as the only uniqueness proof.

Do not mark a duty delivered merely because enqueue returned an object: it may
represent another skip or deferral. Receipt association, successor identity and
terminal consumption must commit together. A failure after successor commit must
recover that successor, not invoke another provider. A different-generation run
is neither a duplicate proof nor permission to adopt the old receipt.

#219 retains ordinary non-review owner/interaction work. It must continue to exclude
review-stage and pending-reviewer rows. Existing reserved namespace rows keep their
current isolation and retirement semantics; this proposal creates no producer for
them. Detect any intersecting unfinished same-submission duty before enabling a
future producer, and return it for an ownership decision rather than dispatch from
two consumers. No generic drain can turn a held reviewer duty into runnable input.

### Precise missing primitives and options

| Missing interface | Why current interfaces are insufficient | Acceptance affected |
| --- | --- | --- |
| Server-proven first-submission receipt binding | `recordExecutionWait` records diagnostics; #211 reads arbitrary older skips. No immutable full-generation/source/decision proof at this handoff seam. | 6, 7, future-only |
| Locked receipt-to-successor adoption | #211 unlocks before enqueue; its key includes the release run; ordinary enqueue has no source-receipt claim/consume contract for this class. Namespaced reviewer admission is a different owner. | 2, 3, 4, 9 |
| Durable pending predicate and settlement | A committed release marker plus a terminal skipped row supplies no saved unfinished/due duty. Existing continuation deadline returns null for this state. | 3, 5, 8 |
| Final release convergence | Native workspace callback and process-release result do not join #211 after each final owner settles. Existing recovery restores its own work only. | 1, 3, 5 |

**Recommended option A, for CTO acceptance before implementation:** extend the #211
owner's internal interface to own a future-only pending receipt and locked adoption
in existing wake storage. Reuse the existing `executionContinuation` coordinator,
startup notification protocol and scheduler; replace/disambiguate the reviewer
registration so it has one delivery responsibility for the new class. Persist
per-receipt due/backoff and association in existing storage. Do not enable the old
producer or add another topic, scheduler, route, table, timer, configuration flag
or recovery authority. The precise storage/provenance classification and locked
adoption capability must be accepted as the missing primitive and tested before
any producer is enabled. This document does not claim those capabilities exist.

**Option B:** implement only complete-generation/future-only safety in the existing
release path, explicitly leaving durable liveness unresolved and #133 open. It is
a bounded increment, not a replacement for all twelve requirements. It still needs
new authorization, provenance design and exact-head independent review.

**Rejected within current scope:** resurrect #134's producer/consumer, duplicate its
fork stack, add a third reviewer delivery loop, reinterpret historical skips,
broaden recovery authority, or rely on future release events as retry. A proposal
to reuse the old complete intent architecture requires an explicit changed scope;
it is not authorized by choosing option A.

The author has stopped at design. CTO must select the option and accept every
mechanism substitution below before a separate implementation assignment. If the
existing JSON/status/transaction interface cannot represent A without a forbidden
addition, preserve this gap and return for scope selection again.

## Gate restoration and durable liveness

The event-only path has no complete gate-release fallback today. Proposed option A
retains the amended 15-second floor and persisted capped backoff:
`next = attemptTime + min(15s * 2^min(attempt,5), 300s)`. Frequency is bounded;
valid work is not discarded after five attempts. Hints do not reset due time.
The existing shared worker handles at most 50 due receipts per pass and computes
null when none remain. This is proposed behavior, not a passing current test.

| Gate | Actual owner / restoration path to exercise | Required same-owner continuation |
| --- | --- | --- |
| Company / agent / project pause and scheduling suppression | `companies.update`, agent lifecycle/update, `projects.update`, current suppression resolver | Authorized resume may hint; persisted due duty must recheck even without a new release. |
| Task / ancestor hold | `issue-tree-control.ts` resume and hold-release transaction | Preserve temporary hold; before-commit resume and multiple holds remain pending until all gates pass. |
| Real budget / daily cap | `budgets.ts` policy update, `resumeScopeFromBudget`, normal period evaluation | Do not clear budget by replay; due duty observes authorized restoration or period change. |
| Dependency | `issues` blocker mutation/completion and `issue-dependency-wakeups.ts` | Existing dependency wake may arrive first; one generation still produces one successor. |
| Interaction / approval / connection intent | Existing interaction/approval resolution and `satisfied-connection-intents.ts` | Preserve resolver authority and pending states; due duty observes actual saved resolution. |
| Recovery / execution ownership | `recovery/service.ts` authorized action resolution; proven executor/process/lease settlement | A parked duty is not active execution or self `pending_wake`; real recovery blockers remain effective. |
| Workspace | Native finalization/recovery and workspace repair owners above | Require actual release proof; never repeat a provider result to manufacture cleanup. |
| User / project / company access | `authorizationService` and existing membership/access mutations | Revoke holds or invalidates according to saved identity; restored access never upgrades an obsolete submission. |
| Capacity / queued or retry work | Queue/run completion and retry owners | Match complete generation and atomically adopt queued/running/scheduled_retry work; unrelated work remains independent. |

For every row, test actual mutation through its owning service against real PostgreSQL.
Include restoration before receipt outer commit, concurrent holds, admission just
before due, rollback and final dispatch revalidation. A helper clearing a field is
not evidence that that gate's real lifecycle works. No row is waived by this plan.

## Twelve amended acceptance items

These are retained future implementation gates, not claims that this design fixes
runtime behavior. Numbers match the [amended plan](2026-10-28-reviewer-lease-continuation.md#amendment-acceptance-at-the-assembled-service-seam).

| # | Retained guarantee, owner and required proof | Current evidence / disposition |
| --- | --- | --- |
| 1 | #211 owner after actual executor cancel and delayed cleanup; native workspace/process orders converge without second submission. | Selector positive control passes. Native and full cancellation path unexecuted; lifecycle probe limitations are separate. |
| 2 | Queue transaction owns both receipt race orders, outer commit after empty cleanup read, savepoint rollback and association. | Issue lock exists; no complete two-order/rollback probe here. Missing atomic adoption primitive. |
| 3 | Same release owner plus existing coordinator reconstructs pending work after lost hint, receipt/successor commit failure and restart; preserves backoff. | Release-commit probe loses delivery and returns null deadline; full process/coordinator restart unexecuted. Option A requires acceptance. |
| 4 | Queue owns canonical-generation coalescing across duplicate receipts/releases/two instances and queued/running/scheduled_retry. | Sequential positive control passes only; cross-release key cannot prove the requirement. Require dual-instance barriers and all three states. |
| 5 | Same owner retains every gate row above, 15–300s due times, before-commit restoration and multiple holds. | No complete gate mutation matrix run. Event-only release is insufficient; retained deadline option is not a waiver. |
| 6 | Server-saved generation plus source/decision binding; current authority at admission/dispatch; cross-company isolation. | Same-stage changed submission produces one successor instead of zero. Add policy/full-state/decision/count/user/source/revoke-restore matrix. |
| 7 | Snapshot complete policy/state, decision rows, counts, responsible user, null/default three; exclude all historical diagnostics. | No production state touched. #211 has no provenance boundary. Require raw before/after snapshots and historical negative controls. |
| 8 | Existing coordinator owns idle/startup/first producer/dirty sweep/outer commit/drain/resume/shutdown without recurring SQL after settlement. | No idle SQL measurement performed. U must contain only unfinished future obligations, never completed history. |
| 9 | Queue classification before limit and at writes, generic-drain/exact-ID/unknown namespace isolation, mixed rows, two-instance race, owner key. | Existing fence retained; #211 live-wake check lacks it. Require updated whole-tree access inventory before producer, including raw SQL/aliases/status-independent writes; no claim of complete audit here. |
| 10 | Recovery owner resolves real action; duty alone does not self-block; real pending input/run still refuses. | Existing reserved-row fences do not prove ordinary #211 restoration. Require authorized service mutation and one legal delivery. |
| 11 | Company archive serializes creation/adoption, audits retirement, stops linked runs, removes deadline, unarchive never replays. | No archive race run. Require company share lock before issue; winning archive and winning adoption tested separately. |
| 12 | Temporary budget/tree/agent/project/company holds retain duty; explicit Stop retires it; ordinary mixed comment/interaction/retry/recovery/chat unchanged. | No complete mixed-row suite here. Keep ordinary owners and existing reserved retirement; test real bulk mutation paths after A is accepted. |

The original committed #134 red oracle at `de1a4c2ffaab1e5cae2e08fb551d7292d96adb0e`
remains an additional acceptance input. It was not ported or run in this design.
A future implementation must turn its no-resubmission assertion green on its own
approved base. Old branch greens and this plan's manual probes do not satisfy it.

### Mechanism clauses requiring an explicit decision

| Original clause | Proposed disposition and evidence needed before acceptance |
| --- | --- |
| 15-second floor, 15–300s capped backoff | Retain exactly through the existing coordinator and persisted due state. #211's no-timer design does not justify removing durable retries. |
| Reserved `_paperclipReviewerAssignmentContinuation` namespace | Preserve all existing fences and ordinary mixed-row behavior. Do not activate its old producer. A release-owner representation must provide equivalent exclusion and unforgeable provenance; exact classification is an unresolved primitive, not N/A. |
| `review-assignment-continuation:<receipt UUID>` | #211 currently uses release+receipt key. Propose receipt-stable delivery identity plus atomic generation association; cross-release/double-receipt tests must prove equivalent one-successor semantics. Exact key choice awaits CTO acceptance. |
| Earliest unfinished-receipt deadline; null when empty | Retain the semantic contract in the existing `executionContinuation` registration. A null deadline in the failed probe is evidence of missing duty, not evidence of quiet correctness. |

## Implementation sequence after a separate authorization

1. Accept the owner, missing primitive, storage/classification and each mechanism
   disposition. Refresh base, inspect intervening #211/#219/native changes and
   update the complete wake-access inventory. If scope cannot fit, stop again.
2. Prove the first immutable generation/provenance seam with unchanged and changed
   submission controls, including ordinary adoption. Ship any necessary exclusion
   fences before enabling a producer; an intermediate producer must never escape.
3. Add atomic admission/association and durable settlement as one correctness slice.
   Exercise both commit orders, fault boundaries and real restart. Avoid a broad
   architecture PR; split only at safe disabled-producer seams.
4. Join final native/legacy release hints and every actual gate restoration via the
   same owner/fallback. Prove the entire twelve-case matrix and old red oracle.
5. Exact-head CI and cross-type independent review precede any merge. A changed
   head needs new review. No deployment or historical recovery follows implicitly.

## Upstream ownership and conditional contribution

A bounded host-Git/gh check on 2026-10-30 found upstream PR
[paperclipai/paperclip#16966](https://github.com/paperclipai/paperclip/pull/16966)
still OPEN at `3803bcb898e1ea73f0a2358f92a1dc1cd6011dae`, with no merge commit.
Fetched upstream master was `ac4f13d205ce7783856a673497b2c01be7781ce7`.
An earlier ls-remote in this run returned `0c70cedce9a803bdc201324528abb35e423e7cd0`;
master moved during analysis. The fetched commit is the source-inspection version.
At that fetched commit, targeted searches found none of `resumeExecutionOwnershipWaits`,
`selectReleasedExecutionWake` or `_paperclipReviewerAssignmentContinuation` in
server services/index. This is a bounded owner check, not proof that no equivalent
logic exists under another name.

Searches for reviewer generation, execution ownership and release wake did not
establish a merged equivalent owner or a corresponding #211 upstream contribution.
No upstream Issue/PR was created, no author was contacted, and no conditional
obligation was declared complete. The existing conditional upstream owner must
recheck final owner and duplication on new merge/maintainer evidence before a
focused full-generation patch is authorized. Preserve its prior approvals/history;
never copy the old fork stack or treat an open prerequisite as merged.

## Verification, review and rollback

This PR changes documentation only. Isolated test sources are preserved as code
blocks in the diagnostic record, outside automatic test discovery, because they
intentionally assert the currently missing contract. Their red results remain
visible; moving them into documentation does not turn the contract green.
No runtime source patch was made. Local build/typecheck/full-suite runs are
excluded by host policy; exact-final-head GitHub CI supplies those checks when
required. The PR records actual checks and missing results separately.

The design self-review maps every amended acceptance item, distinguishes current
facts from proposed contracts, and preserves the implementation stop. Independent
review must check exact base/head, source/evidence, ownership, all twelve items and
scope. Plan approval does not approve a runtime patch. Merge closes only #234;
#133 stays open for the separately assigned implementation.

Documentation rollback reverts this plan only. A later receipt implementation must
not roll back exclusion/provenance readers while unfinished new receipts exist;
retain reader/retirement compatibility or stop the producer and settle/retire those
receipts under the approved owner. Never reinterpret them as ordinary history.
