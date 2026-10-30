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
- `server/src/services/execution-recovery-resolution.ts` 625-740 (`preserve_without_replay_v1` settlement)
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
`blocked` under `preserve_without_replay_v1` and never reaches the continuation
requeue at all.

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
| SOL-2771 | system `execution-recovery` settlement 06:57:07 (`outcome: blocked`, `replay: not_authorized`), no `issue.updated` | none | none | none (settlement resolved it) | 2ff3130d `cancelled` 06:01-06:02, 504e1d06 `issue_reassigned` | running elsewhere | **F3.** Board resolved a stranded action at 06:56:41 (note: run cancelled by manual pause, restore `in_review`). 26 s later a different execution recovery action settled and re-blocked it. Plugin `stale_wake_reconcile` wake requests at 13:00 and 14:00 have no matching run on the issue (cause unknown). |
| SOL-2813 | system `execution-recovery` settlement 06:37:11 (`outcome: blocked`, `replay: not_authorized`), no `issue.updated` | none | none | none | 14e73544 started 06:36:27, `cancelled agent_paused` 06:36:56 | idle | **F3**, pause path: run had started (not cancel-before-start); whether the provider did any work: unknown. |

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

**F3: candidate upstream bug (new, not in #237).** At
`execution-recovery-resolution.ts` 650-660, `preserve_without_replay_v1` sets
`status: "blocked"` directly through `tx.update(issues)`:

- `blockedTransitionAt` is not stamped. The normal issue update path stamps it
  at `issues.ts` 11204. Every ready-state key and the self-blocked check key off
  this field.
- No `issue.updated` status activity is written. Only
  `issue.execution_recovery_settled` is.
- The recovery action is marked `resolved`. The issue therefore stays `blocked`
  with no active recovery action, no blocker, no descriptor and no owner, and
  none of stranded recovery (status filter), the backstop (no blockers) or
  active-action reconciliation (no active action) will look at it again.
- It can override a Board restore made seconds earlier (SOL-2771).

The same code is on upstream `master` (introduced by upstream #13075), so this
would be an upstream fix. Two parts are separable. The missing transition
stamp/activity is a contract inconsistency regardless of intent. "Stop without
replay and leave no owner" may be a deliberate safety stop, and that is the
unknown below.

**F4: #237 point 3 is untested, not shown broken.** The code reads as correct
for the requeue path after resume. Untested: the requeue itself, and the
interaction with F3 when the paused run reaches settlement first (SOL-2813).

## 6. Unknowns (not to be read as bugs)

- U1: whether SOL-2308's participant run d1d4765a recorded a review decision
  before re-escalation. That needs the run's status-decision record, which these
  samples do not include.
- U2: whether the `preserve_without_replay_v1` stop is meant to leave the issue
  ownerless, or expected some other surface (Inbox, notice) to own it. The code
  comment only states "Recorded work is preserved; actions with unverified
  outcomes will not be repeated."
- U3: why plugin `stale_wake_reconcile` wake requests on SOL-2771 (13:00, 14:00)
  have no run on the issue (deferred, deduped, or run on the agent without issue
  linkage).
- U4: whether SOL-2813's cancelled run had done provider work before the pause.

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
| T7 | Same as T6 but the run reaches `preserve_without_replay_v1` settlement first | pins current behavior: assert the fields from F3 (`blockedTransitionAt`, activity, action status) so the fix scope is explicit |
| T8 | Board restores (`recovery_action_resolution`) then a pending execution recovery action settles | pins whether the settlement may re-block the restored issue (F3, SOL-2771) |

T7 and T8 decide F3. T1-T6 characterize the existing native behavior, and that
is enough to close #237 points 1-3 as intended or untested.

## 8. Overlap with ai-team #682 / #685 / #706

- #685's scope (1), "blocked issues with no unresolved dependency, declared wait
  or pending interaction", is exactly the native gap left by §2.1 step 1 plus
  F3. Native code has no owner for those issues today, so this plugin work does
  not duplicate native recovery.
- #685's scope (2), "native skips caused by a pause whose actor is now
  available", overlaps §2.3. If T6 passes, the plugin part for chain-end
  `todo/in_progress/in_review` is redundant there. It is not redundant for
  issues already moved to `blocked` by F3.
- #706 changes the plugin wake budget only and does not overlap native code.
- This report changes none of their review, scope or publication gates and is
  not a prerequisite for them. Nothing here supports retiring plugin behavior. A
  removal would need an exact native fix version, approved source, deployment
  and independent acceptance.

## 9. Options for the CTO (#237)

1. Close #237 points 1 and 2 as intended upstream behavior (F1, F2). Keep any
   ownership fix in ai-team process: descriptor owner sync on reassignment, and
   CTO handling of board-owned actions.
2. Authorize a separately scoped upstream fix issue for F3, limited to: stamp
   `blockedTransitionAt` and write the status activity in
   `preserve_without_replay_v1`. Decide U2 first; only if it is not intended,
   also leave an owned path (for example keep a board/system action active
   instead of resolving it). The tests are T7-T8.
3. Authorize characterization tests T1-T6 as a test-only fork/upstream PR to
   settle point 3 (F4).

Recommended: 1 + 3 now, and 2 after U2 is answered from upstream history or the
maintainers. The plugin's scope (1) stays needed until a native F3 fix is
deployed and accepted.
