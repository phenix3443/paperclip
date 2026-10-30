# Complete inline context for coalesced queued comments

Date: 2026-10-29. Status: proposed; production implementation requires independent review of this exact document revision.

Scope: [fork issue #177](https://github.com/phenix3443/paperclip/issues/177). This is a separate repair from [upstream PR #18060](https://github.com/paperclipai/paperclip/pull/18060). It does not approve, amend, or replace that PR's review.

## Problem and observable contract

When two or more comments on the same submission join an unstarted queued run, every live admitted comment must remain in the queue and in the provider's inline wake input. A second comment must not disappear when claim reconstructs the run context. A successful provider start and a readable API feed do not establish this contract.

The source exploration's real PostgreSQL/process test failed at `finished.contextSnapshot.wakeCommentIds`: it expected both fresh comment IDs and received only the first. Its process wrote `PAPERCLIP_RUN_ID`, not the prompt. The failure establishes lost canonical IDs; it does not establish what text the provider read. That limitation remains part of acceptance.

## Fixed comparison and reproducible evidence

| Role | Full SHA |
| --- | --- |
| Fixed base of #18060 | `51c3f8924cb0bd5fe7cbda15ad9b8f06a6a11055` |
| Fixed head under investigation | `b88510990d7c59be1b2b1371d8c4774f36a7fc87` |
| `upstream/master`, fetched for this investigation | `49fe8b87a49aa5a8985a08dd3d5ce57bdd24756c` |
| Fork documentation starting point | `b011dfde0fc59a619d96ace48414fc88a8d5985c` |

The companion fixture uses the public `heartbeatService.wakeup` and ordinary queue drain against disposable real PostgreSQL. It seeds a pending reviewer and a busy run, sends two comments without changing submission, then releases capacity. Both lock variants use identical input: no `issues.executionRunId`, or that field set to the first queued run. It checks that the second receipt joins the first run before it checks the finished canonical IDs. Synthetic bodies are `FIRST_INLINE_BODY_177` and `SECOND_INLINE_BODY_177`.

Copy `fixtures/2026-10-29-queued-inline.test.ts` beside the target tree's existing `server/src/__tests__/helpers/`, as `server/src/__tests__/queued-inline.test.ts`. In each pinned checkout run:

```sh
timeout 300 pnpm install --frozen-lockfile --ignore-scripts
timeout 180 pnpm --filter @paperclipai/plugin-sdk ensure-build-deps
timeout 240 pnpm exec vitest run --project @paperclipai/server server/src/__tests__/queued-inline.test.ts
```

Do not run against the instance database or replay a real task. The fixture cleans up its database, process executions and marker in `finally`/`afterAll`. Its process marker only establishes startup. The implementation regression below must additionally capture provider input.

Execution results and initial preparation failures are recorded in [the companion evidence file](2026-10-29-queued-comment-inline-evidence.md). The comparison fixture is [stored beside it](fixtures/2026-10-29-queued-inline.test.ts). A module-load failure is not a reproduction. A base/head comparison must reach the same symptom before attributing a regression to #18060. If the base passes, or cannot reach the path for a semantic reason, return that evidence for a scope decision before production changes.

## Owner and current data flow

The wake-queue module owns editable queued messages and persistence. Heartbeat coordinates admission and claim. Task-context rendering and adapters consume admitted IDs; they must not recover dropped comments by independently scanning the feed.

There are two coalescing producers to cover:

1. With an issue execution lock, heartbeat delegates to `admitWakeBehindIssueExecution`; `coalesceIntoActiveExecutionRun` updates the run context and inserts the incoming coalesced wake in the caller's transaction.
2. Without that lock, heartbeat's ordinary same-task coalescing branch updates the run context and inserts the incoming wake directly.

Both can merge IDs into `heartbeat_runs.context_snapshot` without extending the root wake's `_paperclipWakeContext.wakeCommentIds`. Claim locks issue, wake, then run; it reads the root wake's IDs, removes deleted comments, and rebuilds context from those IDs. Thus a wider run projection can shrink to the older root envelope. The root envelope is already used by queue inspection, editing, deletion and claim; making the renderer scan extra receipts would leave those consumers inconsistent.

## Proposed narrow repair

Extend the existing queue persistence seam to append an admitted comment to a **mutable ordinary queued-message root**. Reuse the same operation from both producers. Keep policy and mutation together in wake-queue; do not introduce a second aggregation owner in heartbeat or the renderer.

The operation has one outcome: merged into the still-pending queue, or no longer eligible and returned to existing admission. It accepts company, issue, target run and incoming admitted comment identity plus its existing transaction. It loads current rows itself. A caller-supplied merged JSON object is not sufficient authority.

Within the existing admission transaction:

1. Take the issue lock, then root wake, then target run, matching queue editing and claim. A caller already holding the issue lock reuses that transaction. Do not start a second root transaction or acquire wake after run.
2. Re-read company, issue, agent, root/run linkage, status and `startedAt`. Require root `queued`, run `queued`, run never started, and matching current task/generation under existing admission checks. Recompute from the locked envelope, not the earlier active-run snapshot.
3. Positively establish that the root is an editable ordinary comment queue. For the narrow repair, use the ordinary automatically created `issue_commented` root with no idempotency key or dedicated receipt identity, no resolved interaction, no chat/ledger handoff or immutable source-proof contract. `ordinaryWakeRequestPredicate` alone is **not** an immutability test: it only excludes reviewer-assignment continuation namespace. Incoming durable/interaction/manual identities retain their current owner path. If ownership cannot be established, do not change the receipt or silently consume the incoming comment; use existing separate/deferred admission.
4. Append validated incoming comment IDs to locked root IDs with stable first-occurrence deduplication. Keep queue order, including explicit user reordering; do not sort by UUID or replace it with database row order. Check comment company/issue/liveness and preserve existing actor authorization before admission. A message body is content, never execution authority.
5. Write root envelope and the run's canonical ID projection together, using existing queued-comment helpers. Invalidate derived wake/task-markdown projections so dispatch rebuilds them through the current trust/redaction path. Insert the distinct incoming coalesced receipt in the same transaction with its original actor, source, identity and payload. Do not overwrite its source history with the merged run context.
6. Guard writes by company, agent, linkage and expected queued status and check affected rows. A lost race returns to existing deferred/follow-up admission; it must not return success with a receipt attached to an already claimed run. Any admission/receipt insertion failure rolls back envelope, run projection and execution-lock changes together. Publish existing notifications only after the outer transaction commits.

Claim remains the final editor cutoff. If merge commits first, claim sees all admitted IDs. If claim commits first, the later comment follows existing durable follow-up admission and is not treated as delivered to that provider invocation. Existing deletion/edit conflict behavior remains in force. No running, started retry, or scheduled retry is granted an editable queue merely by its status name.

The conservative immutable-root fallback must be tested in both arrival orders. It may use the existing deferred wake and release/promotion mechanism; it must not require a new consumer, timer, table, route or receipt type. If the existing path cannot retain the incoming input under these constraints, stop and obtain a scope decision rather than broaden receipt mutability.

## Immutable execution evidence

Only the editable queue's ID envelope and derived run projections change. Existing queue helpers also update the queue's latest-comment pointer; that is permitted only for the editable ordinary root above. Do not apply them to an immutable source receipt.

Never rewrite a receipt ID, idempotency identity, original actor/source binding, interaction decision, source-run proof, reviewer assignment generation, or already admitted submission proof. Do not stamp the current generation onto an old queued/running run to make it eligible. Dedicated reviewer continuations, chat inbound receipts, case/owner-repair handoffs and retry proofs keep their current owner and gate checks. Equality of agent or reviewer alone does not imply equality of submission.

Cross-generation retirement stays with the existing pending-run retirement owner. Old run and receipt snapshots remain unchanged except for their existing retirement status transitions. Fresh comments enter a fresh admission. This repair must not shrink or bypass claim/provider gates for responsibility, company, current participant, access, budget, pause, blockers, recovery or source authority.

## Expected implementation footprint

| Area | Expected change and reason |
| --- | --- |
| `server/src/modules/wake-queue/application/ports.ts`, `use-cases.ts` | Narrow merge result and queue-owned eligibility/atomic merge orchestration; reuse existing admission scope. |
| `server/src/modules/wake-queue/adapters/postgres.ts` and, if needed, existing queued-comment adapter | Locked envelope/run update and source receipt insertion; one persistence owner shared by both producers. |
| `server/src/services/heartbeat/queue.ts` | Wire ordinary coalescing to the owner and handle lost-claim fallback; keep coordinator policy growth small. |
| Existing queued-comment helpers | Reuse canonical ID/projection invalidation; change only if the shared operation needs an existing helper contract extended. |
| Assembled heartbeat PostgreSQL and wake-queue tests | Observable coalescing, claim, rollback and provider-input assertions. |

No db/shared HTTP contract/UI change is proposed. Rendering and adapter production code should remain unchanged. If they need changes to compensate for lost IDs, revisit the owner diagnosis first. Update mapped behavior only if implementation changes a mapped access or user-visible contract.

## Implementation acceptance, after plan approval

Use the highest existing execution seam: public wake admission → ordinary queue drain → real local adapter subprocess. Configure an existing text-consuming adapter with a deterministic local executable that records **only synthetic prompt input**, emits its minimal valid completion protocol, and exits. Do not call a paid model or use actual credentials. Assert the actual child stdin/request contains both unique bodies once, in queue order. A spy that merely fabricates the provider prompt is insufficient. Keep process startup and canonical-ID assertions as separate diagnostics.

Required cases:

- Two and three same-submission comments, with and without issue execution lock. All IDs remain in queue inspection before claim, then all bodies appear in actual provider input. No duplicate provider turn.
- Duplicate admission/retry and stable ordering; concurrent two-writer append with barriers rather than sleeps. Queue edit/reorder/delete before claim still applies to every merged comment, including the second. Deleted body must not reach provider input.
- Deterministic merge/claim races in both orders. Losing merge produces a retained follow-up, never a claimed-run mutation or a lost receipt.
- Cross-generation retirement on the fixed #18060 lineage: old IDs/proofs are not carried into the fresh run; both comments for the new submission survive. Keep the existing source failure visible until the strengthened assertion passes.
- Fault after envelope update and after receipt insertion, including caller-owned outer transaction rollback. Old envelope, run context, receipts and execution lock match their pre-transaction values; retry admits once. No provider or delivery notification starts from rolled-back state.
- Immutable/durable roots and incoming sources in both arrival orders: source receipts and generation/source proofs stay byte-for-byte equal; input uses the permitted separate/deferred path. Include resolved interactions and dedicated reviewer continuation namespace.
- Different company/issue/agent, deleted comment, forged actor/source and changed responsibility/generation are denied by existing owners. Content aggregation grants no new execution authorization. Relevant pause/budget/access/provider-gate tests remain green.

The comparison fixture is intentionally red until a production fix is authorized. Keep its original failure output beside the fixed regression results; do not replace it with feed-read assertions. Run smallest affected tests first under command time limits; full typecheck, tests and build must pass before implementation handoff, using CI for suites that exceed the run budget.

## Delivery and limits

This task delivers this dated document, the synthetic comparison fixture and actual evidence in a fork documentation PR into `develop`, with `Closes #177`. Review the exact commit SHA before merging. Update #177 with the approved final plan after review; a proposed document is not approval.

After approval, implementation uses a new independent patch from the then-current pinned `upstream/master`; verify the bug still reproduces there. Submit the narrow repair to upstream `master`. Deliver the same repair to fork `develop` through its own branch/PR and independent exact-SHA review, resolving only necessary integration differences. The generation-specific integration tests may run on the #18060 lineage as additional evidence; they do not make that unrelated PR a dependency of the ordinary repair. If evidence shows a new regression introduced by #18060, return it for a scope decision before changing that PR or starting the repair.

No deployment, real-task replay, historical receipt repair, Discord action, monitoring change or modification of #18060's draft/review history is authorized here. This plan does not claim a production fix or complete provider-input acceptance.
