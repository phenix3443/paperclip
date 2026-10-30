# Blocked recovery exceptions and real waits (investigation)

Date: 2026-10-30. Issue: phenix3443/paperclip#238. Background: #237 (stays open
for CTO disposition). Documentation only: no runtime, test, schema, route or
plugin change is proposed for merge here, and nothing in this report authorizes
one.

## 1. Versions and inspected paths

| What | Exact value |
|---|---|
| Deployed server (`GET /api/health` `commit`) | `6cda8f0c46636f8abd42375e57794cff59da258a` (2026-10-30 15:10 +0800) |
| Fork `develop` read for source | `ef5f04157907ecf96a7698afb4daac3aee899b64` |
| Deployed vs `develop` | deployed is an ancestor of `develop`; the five later commits (#174, #232, #227, #230, #229) do not touch `server/src/services/recovery/service.ts` or `server/src/services/issue-dependency-wakeups.ts` |
| Upstream `master` compared | `5a7a6b32baf0ae7c1445d1bdbaf7903dc7497173` |

Line numbers below are at `ef5f0415`.

- `server/src/services/recovery/service.ts`
  - `wasBlockedByAssigneeAgent` 1195-1252
  - `reconcileStrandedAssignedIssues` 4975-; status filter 4983; board-owned skip 5231; paused-agent skips 5154-5174
  - `reconcileActiveRecoveryActions` 3928-4110; board-owned auto-resolve 4011-4060
  - stranded escalation creates board-owned action with `board_escalation_no_takeover_v1` 2600-2640
  - `reconcileResolvedDependencyWakeBackstop` 6237-6530; self-blocked skip 6429
- `server/src/index.ts` 1823 (startup) and 2005 (periodic recovery tick): both call `heartbeat.reconcileResolvedDependencyWakes()`, a thin wrapper (`heartbeat.ts` 1658) over the backstop. The run-completion path (`heartbeat/run-completion.ts` 1026) calls it scoped to one finished blocker.
- `server/src/services/execution-recovery-resolution.ts` 493-497 (contract comment), 625-740 (`preserve_without_replay_v1` settlement)
- `server/src/services/execution-blocker.ts` 96-107 (`executionBlockerPredicate`: a resolved action whose `evidence.automaticRecovery.replay = 'blocked'` is still an execution blocker)
- `server/src/services/execution-projection.ts` 263 (projects that hold as `recovery_needed` / "Stopped")
- `server/src/services/decided-review-reassignment.ts` 282-340 (`proveDecidedReviewContinuation`, the narrow native path that can continue a `blocked` review behind a `reviewHoldBlock` receipt)
- `server/src/services/recovery/service.pause-durability.test.ts` (classification only)
- `server/src/__tests__/heartbeat-process-recovery.test.ts` paused-agent cases at 5414, 11366, 15476

## 2. What native code actually does

### 2.1 Resolved-dependency backstop (#237 point 1)

The corrected premise holds. Each periodic recovery tick runs the backstop over
every visible `blocked` issue with an agent assignee and no conversation agent,
paged with a cursor (`RESOLVED_DEPENDENCY_WAKE_BACKSTOP_CANDIDATE_LIMIT`). For
each candidate it skips, in order:

1. `notReadySkipped`: dependency readiness is not ready **or the issue has zero
   recorded blockers** (`readiness.blockerIssueIds.length === 0`). A `blocked`
   issue that waits only on an `unblockDescriptor`, an external party or nothing
   at all is never a backstop candidate. This is by construction, not a bug in
   the backstop: it repairs lost dependency wakes, and such an issue has no
   dependency.
2. `existingWakeSkipped`: a wake already exists for the same ready-state key
   (dependent, full blocker set, `blockedTransitionAt`).
3. `selfBlockedSkipped`: the latest status/assignee/blocker activity at or after
   `blockedTransitionAt - 5s` was the assignee agent itself (directly, or via
   `native-status-committer` from its own run) setting `blocked`, **and** no
   blocker completed or finalized its workspace after `blockedTransitionAt`. So
   the exception only covers "the agent blocked itself knowing its blockers were
   already resolved". If a blocker finishes after the agent blocked itself, the
   skip is lifted and the wake is sent.
4. `livePathSkipped`, `interactionSkipped`, `pauseHoldSkipped`.

Expected semantics: an agent that blocks itself while all recorded blockers are
already resolved is declaring a wait outside the graph; native code will not
re-wake it. Who wakes it is the job of the declared wait (descriptor, external
wait lines, monitor, PR patrol), not of the dependency backstop.

### 2.2 Board-owned stranded recovery actions (#237 point 2)

`reconcileStrandedAssignedIssues` only scans `todo / in_progress / in_review`.
When it gives up on an issue it moves it to `blocked` with an active recovery
action owned by `board` (`board_escalation_no_takeover_v1`, `nextAction` begins
"Board operator: ..."). It then skips any issue whose active action is
board-owned (5231).

`reconcileActiveRecoveryActions` still settles board-owned actions, but only when
there is a healthy open child or a new source execution path outside the action
(`sourceHasNewPathOutsideRecoveryAction`). `durablePathRestored` is deliberately
`action.ownerType !== "board" && ...`. The assignee merely becoming available
again is not a settlement trigger.

Expected semantics per the code and its comments: a board-owned action is the
durable human-owned path, and generic recovery must not race it. That the
assignee recovered does not, by itself, prove the earlier failure is safe to
repeat. Within upstream's model this is intended. The friction is a team-policy
one: in this deployment the CTO, not the Board, decides internal matters. That
belongs to ai-team process, not to an upstream fix.

### 2.3 Pause-release at chain ends (#237 point 3)

While the agent is `paused`, stranded recovery skips its issue when the latest
run was cancelled with `agent_paused` or by an operator (5164-5174). After
resume, `classifyContinuationFailure` treats `agent_paused` as `default`
(retryable), so the continuation path is expected to requeue. This is read from
code only. No integration test resumes a paused agent and checks that a chain-end
issue (`todo/in_progress/in_review`, waited on by another issue) gets exactly one
continuation. `service.pause-durability.test.ts` only covers classification.

A second path that #237 did not name shows up in the samples (§4, F3): when the
cancelled run reaches execution recovery settlement, the issue can be moved to
`blocked` under `preserve_without_replay_v1`. From then on it is not a pause
skip any more: it carries a no-replay execution hold (§2.4), and the
continuation requeue is not expected to run.

### 2.4 No-replay execution holds (`preserve_without_replay_v1`)

`settleUnrecoverableExecutions` documents its own contract (493-497): failed
execution is a system responsibility; after automatic recovery is ruled out it
preserves evidence and stops without replay, and "the resolved record retains a
dispatch hold until actual evidence clears it". The code matches that:

- The action row is set to `status: resolved`, `outcome: blocked`, with
  `evidence.automaticRecovery = { policy: preserve_without_replay_v1, replay:
  blocked, actionOutcome: unknown }`. When the task was an agent review in
  progress it also stores a `reviewHoldBlock` receipt (run, statusVersion,
  previous status `in_review`, stage, last decision).
- `executionBlockerPredicate` (`execution-blocker.ts` 96-107) counts a resolved
  action with `replay = 'blocked'` as an execution blocker, and the issue read
  model exposes it as `executionBlocker` with `canContinue=false`,
  `canRetry=false`. `execution-projection.ts` shows it as "Stopped".
- So `activeRecoveryAction: null` on such an issue does **not** mean nobody
  holds it. The hold is the resolved action, owned by `board`, with the
  responsible user on the issue. Its `nextAction` is the supported handling:
  inspect the run, then send a new message to request continuation.
- The only automatic way out is narrow: `proveDecidedReviewContinuation` can
  continue a `blocked` review whose `reviewHoldBlock` receipt still matches the
  current statusVersion/stage/decision and that has a later resubmission. With
  no recorded decision it holds (`selector_*` / `P4b_*`).

Expected semantics: a deliberate no-replay safety stop with a Board-owned,
human-cleared hold. Generic wake paths must not replay it, and this includes the
plugin: ai-team #682/#685 exclude active execution/recovery owners and holds.

## 3. Sample selection

Source: `GET /api/companies/{companyId}/issues?status=blocked` at about
2026-10-30T14:10Z returned 105 blocked issues (blockerAttention:
76 `needs_attention`, 22 `covered`, 7 `stalled`). This is a snapshot used for
selection, not a repeat of the 104/64/89 measurement in #237.

Twelve issues were chosen to cover every bucket in #238, not sampled at random:

- self-blocked with a self-owned descriptor and no blockers (SOL-2125)
- descriptor owner different from the assignee (SOL-2355)
- recorded blockers unresolved, covered or stalled (SOL-2282, SOL-2916, SOL-2264, SOL-2528, SOL-2304)
- created directly as `blocked` (SOL-2929)
- `blocked` with an active board-owned recovery action (SOL-2308, SOL-2789: the only two in the snapshot)
- `blocked` with no `blockedTransitionAt` and no blocker (SOL-2771, SOL-2813)

Per issue, read through supported endpoints with the current agent identity:
`GET /api/issues/{id}`, `/activity`, `/runs`, `/interactions`, plus
`GET /api/companies/{id}/agents` for current member status. No Board
credentials, no writes. Board user ids, run log contents and comment bodies are
left out.

## 4. Per-sample evidence

Columns: status author (activity actor/source of the latest move to `blocked`),
blockers (state), declared wait, active recovery action, latest runs
(status/errorCode), pending interactions, monitor, assignee status now, class.
All twelve had zero pending interactions; only SOL-2304's tree had a live run
(the CTO's run f204f707).

| Issue | Status author | Blockers | Declared wait | RA | Latest runs | Assignee now | Class |
|---|---|---|---|---|---|---|---|
| SOL-2125 | assignee agent, own run 0e64f6a4, 13:37:38 | none | descriptor owner = assignee; External owner/action lines for upstream PR #17849 | none | succeeded ×4 | running elsewhere | Intended graph-external wait, declared; PR patrol owns the wake. Backstop: `notReadySkipped` (no blockers). |
| SOL-2355 | agent 2808078b (not the assignee db0dc13e), run 6059f311 | none | descriptor owner = 2808078b, assignee = db0dc13e (plugin reassigned at 06:02) | none | succeeded ×3, one `issue_reassigned` | idle | Declared wait with **ownership mismatch** after reassignment (descriptor not updated). ai-team process gap, not upstream. |
| SOL-2282 | assignee agent, run fd7278c7 | SOL-2922 `in_review` | none | none | succeeded; earlier `cancelled`, `claude_transient_upstream` | idle | Real dependency wait, covered. Backstop: `notReadySkipped`. |
| SOL-2916 | assignee (ops), runs 0cc4d152, 6c9565de | SOL-2917 `blocked` | none | none | succeeded ×4 | idle | Real dependency wait; chain stalls upstream at SOL-2917. |
| SOL-2264 | assignee (CTO) re-blocked ×4 on 10-30 | SOL-2266 `blocked` | none | none | succeeded ×4 | idle | Real dependency wait. |
| SOL-2528 | assignee (ops), run ed513704 | SOL-2527 `blocked` | none | none | `legacy_disposition_repair_suppressed`, succeeded, `issue_reassigned` | idle | Real dependency wait. |
| SOL-2304 | assignee (CTO), run 0f26f7a3 | SOL-2927 `in_progress`, SOL-2586 `blocked` | none | none | running f204f707 (on SOL-2929) | idle | Real dependency wait, live child. |
| SOL-2929 | created as `blocked` by CTO run f204f707 | SOL-2589 `blocked` | none | none | creator run running | idle | Real dependency wait; `blockedTransitionAt` null because it was created blocked. |
| SOL-2308 | system `recovery.reconcile_execution_review_participant` 10:02:16 | none | none | board, `execution_review_participant_recovery` | participant run d1d4765a succeeded 10:01-10:02 | running | Board action re-created 86 s after a Board `recovery_action_resolution` restored `in_review`. Whether d1d4765a recorded a review decision: **unknown**. Code intent (§2.2) suggests intended re-escalation if it did not. |
| SOL-2789 | system `recovery.reconcile_execution_review_participant` 07:07:08 | none | none | board, `execution_review_participant_recovery` | executor run `issue_reassigned` | participant **paused** | Intended: review participant is paused; board-owned action is the native path. |
| SOL-2771 | system `execution-recovery` settlement 06:57:07 (`outcome: blocked`, `replay: not_authorized`), no `issue.updated` | none | none | none active; **no-replay hold** (see below) | 2ff3130d `cancelled` 06:01-06:02, 504e1d06 `issue_reassigned` | running elsewhere | **Intended no-replay hold (§2.4)**, board-owned. Board resolved a stranded action at 06:56:41 (note: run cancelled by manual pause, restore `in_review`); 26 s later a second watchdog action on the same run settled and re-blocked it (F3b). Plugin `stale_wake_reconcile` wake requests at 13:00 and 14:00 have no matching run on the issue (U3). |
| SOL-2813 | system `execution-recovery` settlement 06:37:11 (`outcome: blocked`, `replay: not_authorized`), no `issue.updated` | none | none | none active; **no-replay hold** (see below) | 14e73544 started 06:36:27, `cancelled agent_paused` 06:36:56 | idle | **Intended no-replay hold (§2.4)**, pause path: run had started (not cancel-before-start); whether the provider did any work is unknown (U4). |

Hold detail for SOL-2771 and SOL-2813, re-read on 2026-10-30 with the current
agent identity from `GET /api/issues/{id}` and `GET /api/issues/{id}/recovery-actions`
(read-only):

| | SOL-2771 | SOL-2813 |
|---|---|---|
| Stage / actual reviewer | review stage pending; current participant = assignee `2808078b`; returnAssignee `0a4e6b65`; no decision yet (`lastDecisionId` null) | review stage pending; current participant = assignee `a42292d9`; returnAssignee `e07f5d35`; last decision `changes_requested` (count 1) |
| `executionBlocker` | action `d82eec61-53dc-4eb9-a3ac-d0fdd36bb822`, run `2ff3130d-f04b-4eb3-bff5-7dacc05c57bb` (`cancelled`, "Agent lifecycle stop requested") | action `9965c0cc-79e1-4bb8-a042-7c53a2d7eb54`, run `14e73544-0f99-4a95-b139-0e1418c8061c` (`cancelled`, "Cancelled due to agent pause") |
| cause / flags | `legacy_execution_requires_reconciliation`; `canContinue=false`, `canRetry=false` | same |
| Action row | kind `active_run_watchdog`, `resolved` / `blocked`, owner `board`, returnOwner = participant; evidence `automaticRecovery.replay=blocked`, `actionOutcome=unknown`, `reviewHoldBlock` present | same shape |
| Earlier action on same run | `332e7614-5309-4880-91a7-5082e0482388`, resolved 06:02:22 with the same policy | none |
| `activeRecoveryAction` / `interruption` | null / `responsibility: system`, `state: failed` | same |
| Supported handling (`nextAction`) | inspect the run, then send a new message to request continuation; responsible user is set on the issue | same |

The backstop's `selfBlockedSkipped` exception did not apply to any of the
twelve. None had all recorded blockers resolved, so the §2.1 exception never
came into play.

## 5. Findings

**F1: #237 point 1 not reproduced.** No sampled issue was a backstop candidate
(blockers present and all resolved) that went without a wake. The issues that
do strand fall into two groups. Some have no blockers at all, and those are
outside the backstop by design. The rest have unresolved blockers further up
the chain. Verdict: intended behavior, plus incomplete wait ownership in team
process (SOL-2355). It is not an upstream bug on this evidence.

**F2: #237 point 2 is intended upstream semantics.** Board-owned actions
settle only on a healthy child or a new source path. SOL-2789 fits that exactly.
SOL-2308 re-escalated right after a manual restore, and whether that is correct
depends on whether its participant run recorded a decision (unknown, see §6).

**F3: the no-replay stop is intended and owned; two narrower contract
questions remain (candidates, not confirmed bugs).** The earlier draft of this
report read the resolved action as "no owner". That was wrong. SOL-2771 and
SOL-2813 are held by a board-owned no-replay execution hold (§2.4, hold
table): `executionBlocker` is set, continue/retry are refused, and the
supported path is a human inspecting the run and requesting continuation. That
the stranded scan, the backstop and active-action reconciliation do not touch
these issues is the hold doing its job. It is not a lost wake, and nothing here
says a plugin should wake them.

What remains, both in `execution-recovery-resolution.ts` 650-660 and both also
on upstream `master` (introduced by upstream #13075):

- **F3a, transition record.** The settlement writes `status: "blocked"` with a
  direct `tx.update(issues)`. It does not stamp `blockedTransitionAt` (the
  normal update path stamps it at `issues.ts` 11204, and ready-state keys and
  the self-blocked check use it) and writes no `issue.updated` status activity,
  only `issue.execution_recovery_settled`. Classification: candidate contract
  inconsistency. Whether any reader needs those fields for a hold that
  dependency logic never sees is unknown (U2).
- **F3b, re-block after a Board restore.** On SOL-2771 a second watchdog action
  on the same already-settled run `2ff3130d` settled 26 s after the Board
  restored `in_review`, re-applying the hold. Classification: unknown (U5).
  It may be intended (the Board restore did not clear the run's no-replay
  evidence, and the hold is meant to stay until actual evidence clears it) or
  a duplicate-action race.

**F4: #237 point 3 is untested, not shown broken.** The code reads as correct
for the requeue path after resume. Untested: the requeue itself, and the case
where the paused run reaches settlement first (SOL-2813). In that case the
expected result is a no-replay hold, not a requeue.

## 6. Unknowns (not to be read as bugs)

- U1: whether SOL-2308's participant run d1d4765a recorded a review decision
  before re-escalation. That needs the run's status-decision record, which these
  samples do not include.
- U2: whether the missing `blockedTransitionAt` / `issue.updated` record on a
  `preserve_without_replay_v1` block (F3a) is deliberate, and whether any
  native reader (inbox ordering, blocked-owner notice, analytics) depends on it.
  Not unknown: who owns the hold (board, §2.4).
- U3: why plugin `stale_wake_reconcile` wake requests on SOL-2771 (13:00, 14:00)
  have no run on the issue (deferred, deduped, or run on the agent without issue
  linkage).
- U4: whether SOL-2813's cancelled run had done provider work before the pause.
- U5: whether re-settling a second watchdog action on an already-held run after
  a Board restore (SOL-2771, F3b) is intended.

## 7. Minimal isolated integration-test matrix

All embedded-Postgres service tests, no production fixtures.

| # | Setup | Expected |
|---|---|---|
| T1 | Blocked issue, agent assignee, one blocker, blocker → done after the agent self-blocked | backstop sends one wake (self-blocked skip lifted); a second sweep is deduped |
| T2 | Same, but blocker already done before the agent self-blocked | `selfBlockedSkipped`; no wake across repeated sweeps |
| T3 | Blocked, zero blockers, descriptor only | `notReadySkipped`; documents the boundary |
| T4 | Board-owned stranded action; assignee becomes invokable; no new path | action stays active, issue untouched |
| T5 | T4 plus a new queued wake outside the action | action resolved `new_source_execution_path` |
| T6 | Chain-end `in_progress` issue, latest run `cancelled agent_paused`, agent resumed | exactly one continuation requeued; no escalation |
| T7 | Same as T6 but the run reaches `preserve_without_replay_v1` settlement first | issue `blocked`; action `resolved`/`blocked` with `automaticRecovery.replay=blocked`; `executionBlocker` set with `canContinue=false`/`canRetry=false`; stranded scan, backstop and a resumed agent's wake produce **no replay and no dispatch**. Also records the F3a fields (`blockedTransitionAt`, status activity) as current behavior |
| T8 | Board restores (`recovery_action_resolution`) then a second pending watchdog action on the same held run settles | no replay of the held run in either branch (dispatch hold kept); pins whether the issue is re-blocked (F3b / U5) |
| T9 | Chain end `todo` / `in_progress` with one `blocked` downstream, actor idle, latest run `succeeded`, no wake | records which native path (if any) dispatches it; this is the plugin candidate (3) boundary |
| T10 | Chain end `in_review`, participant ≠ assignee, `blocked` downstream, participant idle | native stranded scan picks the participant, not the assignee; records whether it dispatches |
| T11 | Chain end whose latest run failed or was cancelled (not by operator), `blocked` downstream | native stranded recovery acts (requeue or escalate); a plugin candidate (3) wake must lose the race |
| T12 | Chain end with a no-replay hold (T7 state) or a board-owned active action | no native and no plugin dispatch |

T7 and T8 decide F3a/F3b without weakening the hold. T9-T12 measure the native
side of candidate (3) (§8). T1-T6 characterize the rest, and that is enough to
close #237 points 1-3 as intended or untested.

## 8. Overlap with ai-team #682 / #685 / #706

The current #682 "Approved delivery scope" and #685 "Approved scope" bodies
name three candidate scenarios. Each is compared with native coverage below.
Active execution/recovery owners and holds exclude a task from all three in
both bodies.

- **Scope (1)**: `blocked` with no unresolved dependency, declared wait,
  monitor or pending interaction. Native coverage: none by design. The backstop
  needs recorded blockers (§2.1 step 1) and stranded recovery does not scan
  `blocked`. Issues with a no-replay hold (§2.4: SOL-2771, SOL-2813) do **not**
  belong here: they carry an execution hold and are excluded by the plugin's
  own hold guard. Classification: intended native gap; the plugin does not
  duplicate native recovery here.
- **Scope (2)**: native skips caused by a pause whose actor is now available.
  Native coverage: §2.3. While paused, stranded recovery skips on purpose; after
  resume the continuation path is expected to requeue (untested, T6). If T6
  passes, scope (2) is redundant for `todo/in_progress/in_review` issues that
  native stranded recovery still scans. A paused run that already reached a
  no-replay hold (T7, SOL-2813) is not a scope (2) case: it is held, and
  neither native nor plugin should replay it.
- **Scope (3)**: blocker-chain ends. A `todo/in_progress/in_review` terminal
  of an unresolved blocker chain with at least one `blocked` downstream task,
  whose actual responsible actor (the current review participant in review)
  is idle and has not executed since the last relevant change. Ranked by
  distinct blocked downstream count, shared descendants counted once, cycles
  and incomplete graphs fail closed, re-checked before dispatch so a native
  wake wins the race. These tasks may have no pause history, so T6 and scope
  (2) do not cover them. Native coverage: partial and unknown in size. Native
  stranded recovery scans the same statuses and also uses the review
  participant (service.ts 5076-5082), but it decides from the task's own latest
  run (failed/cancelled/missing dispatch, legacy continuation) and does not
  look at downstream waiters or order by them. Its deliberate skips (board-owned
  action, operator-cancel exemption, pause, native passive wait, succeeded
  native run) can leave an idle chain end that native code considers settled.
  The backstop does not cover it either: it wakes the downstream issue once all
  of its blockers resolve, and it does not wake the blocker. Classification:
  native coverage partial (T11), plugin-only remainder unknown (T9-T10),
  excluded when a hold exists (T12). The plugin's race and hold guards are what
  keep the overlap safe. This report does not show either side redundant.
- **#706** changes only the plugin dispatch capacity (distinct available idle
  Coders instead of a fixed three). It does not overlap native code, and it does
  not change the candidate scope or the gates.

This report changes none of #682/#685/#706's review, scope, publication or
acceptance gates and is not a prerequisite for them. Nothing here supports
retiring plugin behavior. A removal would need an exact native fix version,
approved source, deployment and independent acceptance, authorized separately.

## 9. Options for the CTO (#237)

1. Close #237 points 1 and 2 as intended upstream behavior (F1, F2). Keep any
   ownership fix in ai-team process: descriptor owner sync on reassignment, and
   CTO handling of board-owned actions.
2. Treat no-replay holds (SOL-2771, SOL-2813) as intended (§2.4). Their
   supported path is a responsible human inspecting the run and requesting
   continuation. This is a per-task operator decision outside this report; no
   plugin or fork change follows from it.
3. Authorize characterization tests T1-T12 as a test-only fork/upstream PR,
   which settles point 3 (F4), the candidate (3) boundary and F3a/F3b. T7/T8/T12
   assert that the dispatch hold stays.
4. Only after T7/T8 and U2/U5 are answered from upstream history or the
   maintainers: decide whether a separately scoped upstream issue is worth
   filing for F3a (stamp `blockedTransitionAt` and write the status activity)
   and/or F3b. Either fix must keep the hold and the no-replay rule.

Recommended: 1 + 2 + 3 now; 4 later, only if the tests or U2/U5 show a real
contract need. The plugin's three candidate scenarios stay as approved under
#682/#685; this report gives no reason to narrow or retire any of them.
