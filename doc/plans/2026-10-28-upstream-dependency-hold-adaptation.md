# Dependency hold: upstream driver adaptation investigation

Date: 2026-10-28. Scope: [#149](https://github.com/phenix3443/paperclip/issues/149).
Status: incomplete supplemental design; scope decision required. Do not implement.
Documentation draft [#150](https://github.com/phenix3443/paperclip/pull/150) was opened before this file was created.

## Decision needed

The native dependency intent and its lossy admission path exist upstream. The fork's delivery worker does not. Existing upstream startup and reaper calls cover dispatch, and the lifecycle readiness callback offers an agent release seam. However, the checked upstream project-budget release has no native-delivery event or release callback. The existing execution-continuation coordinator registration owns recovery-action rows, not native dependency intents. Reusing its name would not establish a correct delivery contract.

Under #149's stop rule, this investigation returns that gap for a scope decision. It does not propose importing the fork worker, adding a topic, or hiding release behind the periodic reaper. The recommended decision is to authorize design of a narrow post-commit release contract in the existing budget owner, together with an explicit existing-driver owner for native intents. That decision must name the driver and cover durable retry/startup, stale claims, coalescing and transaction uncertainty. If no existing owner can carry those obligations without a new worker, revise the scope through the authorized design-discussion route. This document does not grant either authorization.

## Exact baselines and evidence limits

Fresh `git fetch upstream master` and `git fetch origin develop` succeeded. `git rev-parse` returned:

| Baseline | Full SHA | Role |
| --- | --- | --- |
| Upstream master | `8279c990080b15abdcd9981f5793290fab37f9ad` | Current upstream behavior and driver investigation |
| Fork develop | `5a627cd5c32afc54a310f795b6296f0d67cebf34` | Current fork behavior and worker comparison; initial documentation branch base |

These supersede the earlier comparison against upstream `cff331f6ca0a652b5e41641c68dfa5fa584c22ae`. Historical approval of #132 at `20c9f71d951f0f35413da3c7224db7190b33a768` (merge `4449ce582fd5ef4015634a1b7e1fc76d94e63449`) remains historical. It does not approve this adapter. Implementation draft #138 at `51126df85c15bc2533c086b3620eb152f28960ba` remains outside this documentation change.

The evidence here is exact-source inspection, not an executed database reproduction. No upstream red/green regression, runtime fix, full test suite, build or typecheck is claimed. The historical fork reproduction in #131 is not proof of a current upstream runtime result. A completed design must retain the real-database evidence requirement below.

## Existing upstream behavior and the failure sequence

All upstream line references below are pinned to the SHA above. Source links are immutable.

1. Dependency completion already lists wakeable dependents and calls `enqueueWake` with `reason=issue_blockers_resolved`: [status-decision-committer.ts:2167](https://github.com/paperclipai/paperclip/blob/8279c990080b15abdcd9981f5793290fab37f9ad/server/src/services/native-runtime/status-decision-committer.ts#L2167). Its transaction inserts an `agent_wakeup_requests` intent with actor `native-status-committer`: [lines 416–471](https://github.com/paperclipai/paperclip/blob/8279c990080b15abdcd9981f5793290fab37f9ad/server/src/services/native-runtime/status-decision-committer.ts#L416). This establishes existing upstream behavior; it is not the fork cross-task feature.
2. The [native dispatcher at queue.ts:4669](https://github.com/paperclipai/paperclip/blob/8279c990080b15abdcd9981f5793290fab37f9ad/server/src/services/heartbeat/queue.ts#L4669) selects only queued/claimed no-run intents from that actor, claims them and calls normal `enqueueWakeup` at line 4857. It validates the issue's company, current assignee and terminal state.
3. Real budget admission calls `budgets.getInvocationBlock`; budget rejection and agent invokability rejection pass a condition to `writeSkippedRequest`: [queue.ts:2702](https://github.com/paperclipai/paperclip/blob/8279c990080b15abdcd9981f5793290fab37f9ad/server/src/services/heartbeat/queue.ts#L2702). With an issue ID, that function takes the company-scoped issue lock and calls `recordExecutionWait` at lines 2477–2484.
4. Despite the helper's name, [execution-wait.ts:49](https://github.com/paperclipai/paperclip/blob/8279c990080b15abdcd9981f5793290fab37f9ad/server/src/services/execution-wait.ts#L49) explicitly writes `status=skipped`, `runId=null`. Its comment describes diagnostics, not a durable retry owner. Coalescing only updates the diagnostic count; it does not make the row deferred or resumable.
5. After rejection throws, the dispatcher catch requeues the original. A later dispatch finds the existing actor-bound receipt and copies its skipped state at [queue.ts:4719](https://github.com/paperclipai/paperclip/blob/8279c990080b15abdcd9981f5793290fab37f9ad/server/src/services/heartbeat/queue.ts#L4719). Its normal success settlement at line 4901 likewise copies skipped, reserving coalesced treatment for a run or a deferred receipt. The original then falls outside the queued/claimed selector. This is the source-level loss mechanism to reproduce in the database.

Do not classify all `agent.not_invokable` refusals as transient. A manually paused agent can recover; a terminated or foreign-company target cannot. No error string, actor string, diagnostic count, or null run alone establishes retry authority.

## Fork-to-upstream responsibility map

Fork paths refer to the pinned develop SHA; upstream paths refer to the pinned master SHA. A missing mapping is a blocking finding, not a proposed fallback.

| Fork responsibility | Existing upstream owner/call chain | Transaction, fence and gap |
| --- | --- | --- |
| Native producer persists intent | `native-runtime/status-decision-committer.ts:416,2167` → intent insert | Status transaction owns persistence. Retain its company scope. No fork worker is needed to prove the producer exists. |
| Dispatch and receipt adoption | `heartbeat/queue.ts:4669` → `enqueueWakeup` | Existing queue interface is the repair owner. Hold classification, single receipt identity and claim-token fencing need a design; deterministic actor text is insufficient. Fork `queue.ts:4899` has an explicit receipt recovery helper; upstream keeps this logic inline. |
| Worker activation after completion | Existing `heartbeat/runtime-execution.ts` dispatch calls (lines 968,1146); reaper below | Current direct producer execution paths exist. They do not establish a retained work registration with drain-safe retries and claim deadlines. Full reconstruction must cover every supported producer, not only this fast path. |
| Startup and periodic backstop | `index.ts:1733` startup reaping; `index.ts:1947` scheduler → `heartbeat/recovery.ts:2002` → native dispatcher | Existing bounded ticks are real. They cannot prove release-event delivery while ticks are frozen. Retention must not add held-row claims/writes or extra scans. |
| Fork `cross-task-continuation-worker.ts` pending predicate, 5-second retry and stale-claim deadline | No equivalent native-intent registration found upstream | Fork worker uses `readCrossTaskContinuationWork` and `DELIVERY_QUEUES.crossTaskContinuations`; upstream lacks both. Do not port them. Existing dispatcher polling is not an idle event-driven equivalent. |
| Shared delivery coordinator | `index.ts:1382–1391` → `executionContinuation` → `deliverReconciledExecutions` | [execution-recovery-resolution.ts:250](https://github.com/paperclipai/paperclip/blob/8279c990080b15abdcd9981f5793290fab37f9ad/server/src/services/execution-recovery-resolution.ts#L250) selects resolved `issueRecoveryActions` with pending continuation evidence. A dependency intent without that recovery action is not its work. Do not manufacture a recovery row or append an unrelated scan. |
| Authorized manual agent resume | `agent-lifecycle-driver.ts:14` `onReady` → `resumeQueuedRunsForAgent` | A real existing lifecycle seam, after readiness. It currently resumes admitted runs, not unadmitted native intents. A minimal extension can be evaluated here; it does not cover project budget release. |
| Agent budget release | `budgets.ts:339` → `applyAgentBudgetHoldInTransaction(false)` → lifecycle owner | Preserve manual holds and lifecycle readiness. Budget release is not authority to resume a manual pause. |
| Project budget release | `budgets.ts:345–354` updates `projects` then returns | **Blocking gap:** no release signal/callback to the native dispatcher. There may be no agent lifecycle transition at all. `BudgetServiceHooks` at lines 63–65 contains only `cancelWorkForScope`. |
| Company budget release | `budgets.ts:357–370` → existing agent-lifecycle signal and company update | Signal does not itself dispatch native intents; lifecycle callbacks must be shown for affected eligible targets, not assumed. A company release cannot erase another applicable hold. |
| Window rollover and accounting changes | `budget-enforcement-worker.ts:26–55` → `reconcileDueBudgetPolicies` → budget owner; accounting registration at lines 59–92 | Budget worker owns real policy deadlines. Accounting repairs admitted work and explicitly does not dispatch another paid turn. Its event cannot be repurposed as dependency authority. Project release still reaches the gap above. |
| Other gate release and restart/drain | Existing queue, recovery, lifecycle and coordinator owners | Complete event coverage, late-parking invalidation, rollback/savepoint settlement, supported writer contract and stale-claim deadlines remain unresolved until a native-delivery owner is named. No speculative fallback is approved. |

The precise blocking sources are [project release](https://github.com/paperclipai/paperclip/blob/8279c990080b15abdcd9981f5793290fab37f9ad/server/src/services/budgets.ts#L331), [budget hooks](https://github.com/paperclipai/paperclip/blob/8279c990080b15abdcd9981f5793290fab37f9ad/server/src/services/budgets.ts#L63), [coordinator registrations](https://github.com/paperclipai/paperclip/blob/8279c990080b15abdcd9981f5793290fab37f9ad/server/src/index.ts#L1382), and [lifecycle readiness](https://github.com/paperclipai/paperclip/blob/8279c990080b15abdcd9981f5793290fab37f9ad/server/src/services/agent-lifecycle-driver.ts#L14).

## Contract retained for the next design revision

The full behavior, transitions, legacy adoption rules and regression matrix in [the original plan](2026-10-28-dependency-wake-hold-retention.md) and #131 remain requirements. Its fork worker/topic references are historical implementation assumptions, not portable instructions. This investigation relaxes none of the following:

| Requirement | Required acceptance evidence on both baselines |
| --- | --- |
| Reversible versus permanent refusal | Retain a trusted dependency input for a temporary gate; retire invalid, terminal, cancelled, deleted, terminated or superseded targets. Ambiguous legacy receipts remain visible for explicit repair. Never reopen input that already owns a run. |
| Real pause and budget | Pause through lifecycle; enforce positive real billed-cents budgets at agent, project and company scope with actual spend/exposure. Cover reservations, pending/unpriced costs, correction/settlement, valid override, disabled policy and UTC window rollover. Multiple policies/gates require final legal release; manual pause always needs explicit resume. |
| Stable hold | After initial parking/legacy settlement, multiple real scheduler/reaper ticks cause zero held-input claims, row writes, new receipts, runs or adapter calls. Reads stay within existing bounded baseline tick/page work. No held-row retry deadline or coordinator hot loop. |
| Automatic release | Disable/freeze periodic scheduler/reaper ticks. Trigger each real lifecycle/budget/accounting/other gate mutation; record committed release signal and driver activation. No explicit dispatcher/reaper call between release and one linked run plus one adapter invocation. Window tests retain only the budget owner's real deadline. |
| Exactly one logical delivery | Repeated completion/release/dispatch, two controllers and independent DB clients, stale takeover, release-versus-parking, pause/Stop during admission, and crash at every receipt/run/link boundary. One persisted owner and one invocation; late claimant cannot reopen settled input. |
| Current authority | Reassignment to another agent or human, responsible-user change/revocation, remaining/reopened blockers, review, checkout, recovery and subtree holds. No substituted principal, cleared gate or stale-owner run. Current assignment producer must deliver its own valid input. |
| Isolation and lifecycle | Company-scoped lookup/adoption/claim/link; forged provenance and same-looking foreign keys rejected. Empty/completed/held-only startup becomes idle, rollback and savepoint do not publish early, write during drain is retained, shutdown/resume reconstructs durable work. |
| Fairness and bounded history | More than one page of held records cannot starve an eligible record. One intent and bounded receipt ownership per input; deterministic legacy adoption under the issue lock without repeated mutation. |

The queue is the deep module; normal admission and the native dispatcher are its existing interface. Policy remains in lifecycle/budget owners. The interface must include ownership, locking order, transaction settlement, performance bounds and failure recovery, not just a nullable-run signature. No new public admission override is proposed.

A completed revision must specify a reserved durable receipt identity, exact claim compare-and-set including observed `claimedAt`, final-write fence, target/company binding, and single-owner transition between original and any deferred receipt. Hold observation must be side-effect-free before claim and authoritative admission must recheck gates. Release racing a late wait marker must retain another reconciliation pass after outer commit. A notification alone cannot prove these properties.

## Database red/green plan and remaining work

Use the assembled `heartbeatService`, real migrated embedded PostgreSQL database, real native completion producer, dispatcher and actual lifecycle/budget owners. Mock only the external adapter. Start from each full baseline above and retain the failing output before a fix. Use existing `server/src/__tests__/heartbeat-dependency-scheduling.test.ts` as the harness precedent; fork worker tests cannot establish upstream driver behavior.

For the minimal source-level loss case, pause the agent before native dependency completion, dispatch through the existing path, capture original and diagnostic receipt IDs/statuses/run links, release through lifecycle, and verify one automatic invocation with periodic ticks frozen. Repeat separately with actual project budget exhaustion and legitimate policy release. Capture SQL snapshots, claim/update timestamps, runs, adapter counts, committed event trace and tick state. A skipped DB suite is missing evidence. Do not claim a regression is reproduced from helper mocks or source inspection.

Then run the matrix above, including stable intervals longer than two old retry periods, baseline/fixed query and write counts at equal ticks/page limits, and real `index.ts` startup/scheduler wiring. Record exact baseline/fixed SHAs, commands, hard timeout, exit codes and all failures. Targeted checks come first; required typecheck, tests and build follow for a runtime PR. This documentation-only investigation runs no runtime suite and authorizes no runtime patch.

## File scope, size and review gates

This documentation PR changes only the prior plan's prerequisite note and this dated investigation. No runtime, DB, shared API, UI, scheduler, polling, topic or switch changes are included.

A prospective repair would at least touch the owning heartbeat queue (classification/identity/fences), lifecycle driver (ready event), budget release owner (currently missing contract), and startup/existing driver wiring, plus database integration tests. Fork-only `cross-task-continuation.ts`, its worker and topic must remain unchanged by this task; removal of existing fork features is not authorized. The two baselines have different receipt promotion implementations and driver registrations, so copying a fork patch is not a valid upstream adapter.

A defensible runtime line estimate is not available until the blocked owner/contract is decided. It already spans at least four runtime areas plus tests, so treat it as exceeding the upstream small-PR multi-module threshold rather than promise a sub-300-line repair. Prepare independent slices or a design discussion package with the source evidence, single-owner state machine, scope, test matrix and unresolved driver decision. Submit that package through the authorized internal entry; do not contact external maintainers or open a large upstream PR autonomously.

Author self-review checked the pinned source chain, both baseline differences, driver ownership and all #149 acceptance clauses. The project-budget and native-coordinator gaps prevent readiness. Keep this draft open, #149 open, #138 draft and unmerged, and implementation #131 paused. Do not submit an incomplete proposal as approved. After a scope decision, finish the mapping, submit the complete exact SHA to uninvolved cross-type review with the default three-round history intact, and re-review any changed SHA. Merge only an approved head with required checks. Verify #149 is CLOSED before final task completion.
