# Authorized target-bound continuation for archived workspaces

Status: design plan for phenix3443/paperclip#64. No runtime code changes in this document.

Source references were read at `develop` `17a63c1ae53fb204c84da2584ff601bd64ef9c97`. The diagnosis is the independently reviewed Paperclip report revision `7a310afd-aa9d-41b4-878c-cbbc6264626a`. It was made against the deployed build `6d74176932f9`. Runtime IDs and local paths stay in that report and are not repeated here.

## 1. Problem

An agent can be allowed to resume another task it is assigned to. It sends `POST /issues/:id/comments` with `resume: true` from a run that is bound to a different task (for example a patrol or scheduling task). When the target task is closed and its isolated execution workspace is archived, the request fails with:

```
403 Task workspace run identity is unavailable
```

The comment, resume-intent and cross-issue cap gates have all passed by then. The failure comes from an eager reopen step that runs before the comment is saved:

1. `routes/issues.ts` comments route calls `reopenClosedIssueExecutionWorkspaceOrRespond` after `assertExplicitResumeIntentAllowed` and `assertCrossIssueInfluenceWithinRunCap` pass.
2. That calls `executionWorkspacesSvc.reopenClosedIsolatedExecutionWorkspaceForIssue` with the request actor (`req.actor`) and the target issue.
3. The service calls `assertTaskWorkspaceExecutionAccess(db, req.actor, companyId, { issueId: target })` before any rebuild. It calls it again inside the plugin lifecycle lock, before the git rebuild, and in the managed copy identity check.
4. `services/task-workspace-access.ts` loads `actor.runId` and requires `runRetainsIssueIdentity(run, task.id)`.
5. `services/task-repository-acquisition.ts` `runRetainsIssueIdentity` accepts only `nativeIssueId`, `contextSnapshot.issueId/taskId`, or the immutable `issueId` of the run. The source run is bound to the source task, so the check fails. Being the same assignee does not change this.

The guard is correct. A run bound to task A must not rebuild and write task B's workspace on disk. The defect is in the ordering: control-plane admission ("this agent may ask for task B to continue") is joined to filesystem execution ("this run may realize task B's workspace"). Only a run bound to task B should do the second.

The same reopen helper is called from the PATCH route (`routes/issues.ts`, around line 14628) and the checkout route (around line 16071). Section 9 covers them.

## 2. Options compared

### Option A: deferred target-bound successor (chosen)

The cross-task request does not touch the workspace. In one database transaction it saves the comment, moves the target to `todo`, and writes a durable continuation intent bound to the target task. The native intent consumer turns it into a successor run whose issue identity is the target (section 6.4). During its normal workspace preparation (`services/heartbeat/workspace-preparation.ts`, `ensurePersistedExecutionWorkspaceAvailable` under `shouldRestoreExistingWorkspace`) it restores the archived workspace with its own identity. `assertTaskWorkspaceExecutionAccess` then passes, because the run really is bound to the target.

- Authorization: unchanged. The control-plane gates that already allowed the request stay as they are. Filesystem execution keeps the existing guard, and only a target-bound run passes it.
- New trust surface: none. No token, no new permission, no change to `runRetainsIssueIdentity`.
- Cost: the reopen happens a little later, at run start instead of during the HTTP request. A rebuild failure shows up on the successor run, not as a request error (section 6.4).

### Option B: narrow continuation capability

The request mints a short-lived capability bound to (company, source run, target issue, workspace id, workspace generation, responsible user). `assertTaskWorkspaceExecutionAccess` would accept that capability in place of a target-bound run, for the duration of the eager reopen.

Rejected because:

- It moves the reopen into the source run's HTTP request. The rebuild then runs with the source request's git auth context and responsible user, which is the boundary the guard is meant to keep.
- It adds a second way to pass the guard. Every future caller of `assertTaskWorkspaceExecutionAccess` (repository acquisition, task workspace tools, environment runtime) would have to decide whether to honor it.
- It still needs a successor run to do the actual work, so it adds a capability without removing the successor.

Option A is the smaller native fix. It reuses the run that has to exist anyway.

## 3. Scope of the change

### 3.1 Workspace binding classification

The route stops deciding from `getClosedIssueExecutionWorkspace`. That helper returns `null` both when the issue has no binding and when the recorded workspace row is missing, so the missing case would fall through to ordinary comment admission. A new route-local helper, `classifyIssueExecutionWorkspaceBinding(issue)`, reads the persisted `issues.execution_workspace_id` first and returns one of:

| Kind | Condition |
|---|---|
| `none` | `executionWorkspaceId` is null. |
| `missing` | `executionWorkspaceId` is set, but no row with that id exists in the company. |
| `closed_isolated` | The row exists, `mode = isolated_workspace`, and the status is closed (`archived` or `cleanup_failed`). Carries the workspace id and its lifecycle generation. |
| `open_or_shared` | The row exists and is active, or is not an isolated workspace. |

`getClosedIssueExecutionWorkspace` becomes a thin wrapper that returns the workspace only for `closed_isolated`, so the PATCH and checkout callers keep their behavior.

### 3.2 Cross-task candidate

```
crossTaskCandidate =
  req.actor.type === "agent"
  && req.actor.runId != null
  && (effectiveResumeRequested === true || effectiveReopenRequested === true)
  && runBindsIssueForWorkspaceExecution(db, req.actor, companyId, issue.id) === false
```

`runBindsIssueForWorkspaceExecution` lives in `task-workspace-access.ts` next to the guard. It reads the run with `taskRepositoryRunColumns`, the same projection the guard uses. It returns `true` or `false`, and throws the guard's 403 for a missing run or a run owned by another agent. The guard itself does not change. The predicate only lets the route choose the deferred path *before* calling the guard, so an unbound request never reaches it and there is no catch-and-retry on 403.

What a candidate gets, by binding kind:

| Binding kind | Candidate | Not a candidate |
|---|---|---|
| `none` | Today's path. No workspace to reopen; the comment and resume follow the ordinary rules. | Today's path. |
| `missing` | 409 `This issue is linked to a closed workspace that cannot be reopened.` Zero writes. | Today's path (unchanged). |
| `closed_isolated` | Deferred path (section 5). | Today's eager reopen. |
| `open_or_shared` | Today's path. No reopen is needed. | Today's path. |

So the change applies only to candidates whose binding is `missing` or `closed_isolated`. Board and user actors, agents whose run is bound to the target, and agents without a run id are not candidates. An `agent_jwt` without a run id is still refused by the guard on the eager path, as today.

### 3.3 Order in the comments route

```
auth and company access → issue load and comment read access
  → R0 replay lookup (section 6.2)
  → existing pre-reopen gates (D0)
  → candidate and binding classification (3.1, 3.2)
  → deferred transaction (section 5) or today's path
```

R0 sits before the binding classification and before every gate that can change after a commit (pause holds, blockers, resume intent, cross-issue cap, the source run's status, the feature setting). A committed request therefore stays replayable after the successor restores the workspace, after the source run ends, after a pause is added, and after the setting is turned off.

## 4. Request contract

### 4.1 Request id and digest

A cross-task candidate must carry `clientRequestId` (a client-generated UUID, already in the comment body schema). Today it is honored only for user actors. If it is missing, the route returns `422 Cross-task continuation requires a clientRequestId for safe retries` before any write. It uses the same wording as the chat path at `routes/issues.ts:18294`.

The comment unique index `issue_comments_client_request_uq (issue_id, author_user_id, client_request_id)` does not cover agents, because `author_user_id` is NULL for them. Add a partial unique index:

```
issue_comments_agent_client_request_uq
  ON issue_comments (company_id, issue_id, author_agent_id, client_request_id)
  WHERE author_agent_id IS NOT NULL AND client_request_id IS NOT NULL
```

The route sets `clientRequestId` on the comment only on the deferred path. Other agent comments keep sending `undefined`. So an agent comment row with a `clientRequestId` exists only when the deferred path committed it.

The route also computes `requestDigest`: SHA-256 over the canonical JSON of `{ issueId, body, resume, reopen, interrupt, attachmentIds (sorted) }`. It is stored in the intent payload (4.2), not in a new column. Replay compares it (6.2).

### 4.2 Durable continuation intent

The successor starts from an `agent_wakeup_requests` row written inside the same transaction as the comment. It does not come from the post-response, fire-and-forget `heartbeat.wakeup(...)` loop at the end of the route. The row is an intent, not a runnable heartbeat: `heartbeat/queue.ts` (the comment above `dispatchPendingNativeStatusWakeups`) says a bare row must go through the scheduler's policy, workspace, concurrency and responsible-user checks. Section 6.4 names the consumer.

The row follows the shape of the native status committer's intents (`native-runtime/status-decision-committer.ts`):

| Column | Value |
|---|---|
| `agentId` | The target's `assigneeAgentId`, read under the locks (section 5). |
| `source` | `automation` |
| `triggerDetail` | `system` |
| `reason` | `issue_reopened_via_comment`. The existing reason, so the run-dispatch terminal-issue rule treats it as a trusted resume. |
| `status` | `queued` |
| `requestedByActorType` | `system` |
| `requestedByActorId` | `cross-task-continuation-committer` |
| `idempotencyKey` | `issue_cross_task_continuation:<targetIssueId>:<commentId>` |
| `runId` | null until the consumer links it. |

`payload`:

```
{
  issueId, taskId: issueId, commentId,
  reopenedFrom, mutation: "comment", resumeIntent: true, followUpRequested: true,
  _paperclipWakeContext: {
    issueId, taskId: issueId,
    wakeReason: "issue_reopened_via_comment",
    wakeCommentId: commentId,
    source: "cross_task_continuation",
  },
  crossTaskContinuation: {
    requestedByAgentId, sourceRunId, sourceIssueId,
    workspaceId, workspaceGeneration,
    expectedAssigneeAgentId, expectedResponsibleUserId,
    requestDigest,
  },
}
```

Provenance and trust:

- The real requester is the agent and its source run. They are recorded on the comment (`authorAgentId`, `runId`) and in `crossTaskContinuation`. The `system` requester type only names the producer, the same way the status committer does. It grants nothing.
- The comment keeps the `sourceTrust` from `sourceTrustForActorWrite`. The successor reads the comment through `wakeCommentId`, with that trust. The intent does not copy or raise it.
- The responsible user is not copied from the source run. `_paperclipWakeContext` has no `responsibleUserId`, so `resolveResponsibleUserIdForRunSeed` falls back to the target issue's context, because the wake comment author is an agent. `expectedResponsibleUserId` is the target's value read under the locks, and the consumer refuses delivery if it changed (6.4).
- `crossTaskContinuation` is audit and fixture data only. No code path may read it as authorization. The successor's authority comes from its own binding to the target (6.4).

#### Two identity domains: intent and dispatch receipt

The intent and the consumer's dispatch receipt are two different `agent_wakeup_requests` rows. Today the consumer passes the intent's own `idempotencyKey` to `enqueueWakeup` (`queue.ts:4949`), and every receipt that `enqueueWakeup` writes copies `opts.idempotencyKey`: the admitted path (`queue.ts:4307–4321`), the skipped receipt (`queue.ts:2452–2465`) and the deferred follow-up receipt (`queue.ts:4021–4029`). A single unique index over one shared key would therefore reject the dispatch receipt. This producer gives each row its own key and its own index:

| Row | Written by | `requestedByActorId` | `idempotencyKey` |
|---|---|---|---|
| Intent | D8, in the route transaction | `cross-task-continuation-committer` | `issue_cross_task_continuation:<targetIssueId>:<commentId>` |
| Dispatch receipt | `enqueueWakeup`, called by the consumer (6.4) | `cross-task-continuation-dispatch:<intentId>` | `cross-task-continuation-dispatch:<intentId>` |

The two prefixes do not overlap, so neither index can match the other row. (The LIKE patterns below escape `_`, because `_` is a LIKE wildcard.)

```
-- one intent per (target, comment)
agent_wakeup_requests_cross_task_continuation_intent_uq
  ON agent_wakeup_requests (company_id, idempotency_key)
  WHERE idempotency_key LIKE 'issue\_cross\_task\_continuation:%'

-- at most one dispatch receipt per intent, in any status
agent_wakeup_requests_cross_task_continuation_dispatch_uq
  ON agent_wakeup_requests (company_id, idempotency_key)
  WHERE idempotency_key LIKE 'cross-task-continuation-dispatch:%'
```

The dispatch index has no status filter on purpose. One intent gets one dispatch receipt for its whole life, whether that receipt ends up admitted (linked to a run), `skipped`, or `deferred_issue_execution`. A retry never writes a second receipt; it finds the first one (6.4). This is the backstop that keeps two concurrent sweeps from creating two successors.

The receipt and the run are inserted in the same `enqueueWakeup` transaction (`queue.ts:4307` and `queue.ts:4398` use the same `tx`). So a unique violation on the receipt also rolls back the run. The implementation confirms this with fixture K6; if any receipt-writing branch of `enqueueWakeup` inserts the run outside that transaction, or writes more than one receipt per call, the implementation stops and reports rather than relaxing the index The same applies if the deferred-release path promotes a `deferred_issue_execution` receipt by inserting a new row with its key instead of updating that row (fixture K8).

The key `cross-task-continuation-dispatch:` does not start with any prefix that `enqueueWakeup` treats specially today (`execution-reconciliation:`, `chat-inbound:`, `case-handoff:`, `task-retry:` and the other checks in `queue.ts`). The implementation PR lists those prefix checks to show it.

## 5. Ordering, locks and atomicity

### 5.1 Lock order

Every existing writer of a workspace's lifecycle takes the advisory lifecycle lock first and reads the issue and workspace rows after it. Examples: the reopen helper (`execution-workspaces.ts`, the transaction that calls `acquireExecutionWorkspaceLifecycleLock(tx, input.workspaceId)` and then selects the bound issue), terminal compaction, the fenced workspace writers, and the plugin workspace paths. The deferred transaction uses the same order:

1. `acquireExecutionWorkspaceLifecycleLock(tx, workspaceId)` on the route's own transaction. This is `pg_advisory_xact_lock`, so it is held until that transaction commits or rolls back. The route must not use `withExecutionWorkspaceLifecycleLock`: it opens a dedicated connection and its own transaction, so its lock would be released before D9 and could make the route wait on itself across two connections.
2. `SELECT ... FROM issues WHERE id = target FOR UPDATE`.
3. `SELECT ... FROM execution_workspaces WHERE id = workspaceId FOR UPDATE`.

The advisory lock is not a row lock. The two `FOR UPDATE` reads are what stop writers that do not take the advisory lock. Writers that change `issues.execution_workspace_id` lock the issue row by updating it, so they wait for D9, or the deferred transaction waits for them and then sees the new value at D4.

The implementation PR must list every writer of `issues.execution_workspace_id` and every caller of the lifecycle lock, and show that none takes the issue row lock before the lifecycle lock. If one does, the implementation stops and reports, rather than inventing a new order. A deadlock that PostgreSQL detects anyway rolls back with no writes and maps to 409 `Issue continuation conflicted with a concurrent workspace change; retry`. The client retries with the same `clientRequestId`.

### 5.2 Steps

| Step | Action | On failure |
|---|---|---|
| D0 | All existing pre-reopen gates, in their current order: comment access, `assertAgentIssueMutationAllowed`, `assertExplicitResumeIntentAllowed` (pause hold, cancelled, blockers, assignee/override/mutate), unresolved-blocker check, `assertCrossIssueInfluenceWithinRunCap`. No change. R0 has already run. | Today's refusal response. No writes. |
| D1 | Candidate and binding classification (3.1, 3.2). `missing` → refuse. `closed_isolated` → continue if `clientRequestId` is present and `enableCrossTaskDeferredContinuation` is on. Setting off → today's eager path and its 403. | 422 without `clientRequestId`. 409 for `missing`. No writes. |
| D2 | `BEGIN`. Lifecycle lock, issue `FOR UPDATE`, workspace `FOR UPDATE` (5.1). | Rollback. |
| D3 | Replay re-check under the locks: the R0 lookup again. A concurrent duplicate that committed while this request waited is found here and goes to 6.2. | — |
| D4 | Re-check every D0 gate against the locked rows and current tables: status still resume-capable, no active pause hold, no unresolved blockers, assignee unchanged from D0, the source run still `running` and still owned by the actor agent, responsible user unchanged, `executionRunId` null or terminal, no active `checkoutRunId` from another run. The cross-issue cap counts this request once. | Rollback. 409 with the same refusal text as D0. |
| D5 | Binding re-check: the locked issue's `executionWorkspaceId` still equals the classified id; the locked workspace row exists, is still `isolated_workspace`, still closed, and its lifecycle generation equals the classified generation. Nothing is written to the workspace. | Rollback. 409 `This issue is linked to a closed workspace that cannot be reopened.` |
| D6 | Insert the comment (`svc.addComment(..., tx)`) with `clientRequestId`, `runId = source run`, `sourceTrust` from `sourceTrustForActorWrite`. | Rollback. |
| D7 | `svc.update(target, { status: "todo" }, tx)` and the `issue.updated` activity row (existing details, plus `crossTaskContinuation: true`). | Rollback. |
| D8 | Insert the intent (4.2). | A unique conflict maps to the 6.2 replay after rollback. Any other error → rollback. |
| D9 | `COMMIT`. Then publish activity and live events, and notify the consumer (6.4). | A notify failure does not lose the intent (6.4 recovery). |

Properties:

- **Refusal atomicity.** Every refusal before D9 leaves no comment, no status change, no intent and no workspace change. The deferred path never sets the reopen-pending flag and never rebuilds anything. So `guardReopenedWorkspaceConsumption` is not installed, and an archived workspace cannot leak.
- **No partial success.** The comment, the status change and the intent commit together. Today the status update, the comment insert and the wakeup are three separate effects.
- **No I/O under the locks.** The transaction holds no lock across filesystem or network work.
- **Execution policy fields.** `executionPolicy`, `executionState` (stage, participants, `lastDecisionOutcome`, `changesRequestedCount`, `returnAssignee`, decisions), `assigneeAgentId`, `responsibleUserId` and review limits are not written. The deferred path only changes `status` to `todo`, the same as today's resume. A null review limit still means the default of three.

## 6. Idempotency, lost responses and delivery

### 6.1 Concurrent requests

Two requests with the same `clientRequestId` both miss R0, then serialize on the lifecycle lock at D2. The second finds the committed comment at D3 and replays. The partial unique indexes (4.1, 4.2) are the backstop if the lock is ever bypassed; a unique violation maps to replay, never to a second row.

Two requests with *different* `clientRequestId`s for the same closed target also serialize at D2. The second one then sees the target in `todo`, its workspace still `archived`, and a pending intent (`queued` or `claimed`, or linked to a run that is not terminal) from `cross-task-continuation-committer` for the same agent and target. It does not fall back to the ordinary comment path, which would send a second, fire-and-forget wake. It stays on the deferred path:

- D4 accepts `todo` only in this case (a pending continuation intent exists for this agent and target).
- D6 inserts its comment with its own `clientRequestId`. D7 writes nothing.
- D8 inserts its own intent with its own idempotency key, `status = coalesced`, and `payload.coalescedIntoWakeupRequestId` set to the pending intent. The consumer selects only `queued` and `claimed` rows, so a coalesced row is never dispatched.

Exactly one successor runs. The successor sees both comments, because both are on the target after its admission. Each request keeps its own replayable receipt.

### 6.2 Replay (R0 and D3)

R0 runs when the actor is an agent and the body has a `clientRequestId`. It needs only the checks that run before it: authentication, company access, and comment read access on the issue. It looks up the comment by `(company, issue, author_agent_id = actor.agentId, client_request_id)`, then the intent by `issue_cross_task_continuation:<issueId>:<commentId>`. This key only ever matches the intent row; the dispatch receipt has its own key (4.2). The `runId` in the replay comes from the intent, which the consumer links.

- **No comment.** The request is fresh and continues to D0.
- **Comment and intent, same digest.** `201` with the original comment, `replayed: true`, and `continuation: { wakeupRequestId, status, runId, coalescedIntoWakeupRequestId? }` read from the intent now. No gate is re-checked, because the original admission already committed. Nothing is written, including activity.
- **Comment and intent, different digest.** `409 This clientRequestId was already used for a different request`. Nothing is written. The client must use a new id for a new request.
- **Comment without an intent.** This cannot happen, because the comment and the intent commit together. The route returns 500 and logs it as an invariant breach. It never re-admits.

R0 does not depend on the binding kind, the workspace status, pause holds, blockers, the cap, the source run, or the feature setting. So a lost-response retry still replays after the successor has restored the workspace (binding kind `open_or_shared`), after the source run ended, after a new pause hold was added, and after the setting was turned off.

### 6.3 Lost response

If the client loses the response, it retries with the same `clientRequestId` and the same body. If the first request committed, the retry replays (6.2). If it is still in flight, the retry waits at D2 and replays at D3. If it rolled back, the retry is a fresh request and goes through all gates again. No new read endpoint is added. The existing comments read already returns `clientRequestId`, and the replay response carries the intent's current status.

### 6.4 Consumer and delivery-time revalidation

**Owner.** The consumer is `dispatchPendingNativeStatusWakeups` in `services/heartbeat/queue.ts`. It already bridges durable intents into the scheduler through `enqueueWakeup`, and it already recovers crashes. It is extended, not copied:

- The candidate selector accepts `requestedByActorId IN ('native-status-committer', 'cross-task-continuation-committer')`, still with `requestedByActorType = system`, `status IN (queued, claimed)` and `runId IS NULL`.
- Each producer has its own dispatch actor id: `cross-task-continuation-dispatch:<intentId>` for this producer. For this producer the consumer also passes `idempotencyKey: "cross-task-continuation-dispatch:<intentId>"` to `enqueueWakeup`, not the intent's key (4.2). The status-committer branch keeps passing its intent key, unchanged.
- For this producer, `existingDispatch` is looked up by `(company_id, idempotency_key = dispatch key)`, which the dispatch index makes unique. The existing recovery then applies unchanged: a receipt with a `runId` → intent `coalesced` with that `runId`; a `deferred_issue_execution` receipt → intent `coalesced` (the receipt is now the pending work, as for status intents); a `skipped` receipt → intent `skipped` with the receipt's error.
- For this producer, a stale reclaim is fenced on the old claim time: the claim update adds `claimed_at = <candidate.claimedAt>` to its `WHERE`. Two sweeps that both read the same stale claim cannot both win it. If both still reach `enqueueWakeup` (for example because one sweep's claim is older than `staleClaimMs` again), the dispatch index rejects the second receipt, its transaction rolls back with its run, and the catch path treats that unique violation as "already dispatched": it runs the `existingDispatch` recovery instead of requeueing the intent.
- An `enqueueWakeup` failure other than that unique violation rolls back its own transaction, so no receipt exists, and the intent is requeued as today. The retry inserts the receipt for the first time.
- For this producer, the `contextSnapshot` passed to `enqueueWakeup` uses `source: "cross_task_continuation"` and `crossTaskContinuationIntentId`, not the status-decision values. `issueId` and `taskId` are the target, as today.
- The other code that matches `native-status-committer` (`chat-control-recovery-stop.ts`, `recovery/service.ts`, `native-runtime/native-child-completion-delivery.ts`) is not changed. The implementation shows that none of them needs the new producer.

**Successor identity.** `enqueueWakeup` creates the run with `contextSnapshot.issueId = target`. `runRetainsIssueIdentity` accepts that, so the successor passes `assertTaskWorkspaceExecutionAccess` for the target. If the native path also sets `nativeIssueId`, it is the target.

**Revalidation.** Before `enqueueWakeup`, the sweep already skips an intent whose target is gone, `done` or `cancelled`, or has a different assignee. For this producer it also skips with error `cross_task_continuation_gate_changed` when:

- the target is not `todo`, `in_progress`, or `blocked` with resolved blockers;
- the assignee is not `expectedAssigneeAgentId`, or the responsible user is not `expectedResponsibleUserId`;
- the target's `executionWorkspaceId` is not `workspaceId`.

After that, `enqueueWakeup` applies the normal run-dispatch policy (pause holds, dependency readiness, concurrency). A deferred dispatch receipt makes the intent `coalesced`, as for status intents. A skip leaves the comment in place and changes nothing else.

**Notify and recovery.** After D9 the route calls `heartbeat.dispatchPendingNativeStatusWakeups({ companyId })` and logs any error. The response is already decided by then. If notify does not happen, the existing calls deliver the intent: the startup recovery sweep (`heartbeat/recovery.ts`) and the sweeps after native run finalization in the company (`heartbeat/runtime-execution.ts`), which include the source run's own finalization. Crash windows:

| Window | What persists | Recovery |
|---|---|---|
| K1: after D9, before notify | Intent `queued` | Next sweep claims and dispatches it. One run. |
| K2: after claim, before `enqueueWakeup` | Intent `claimed` | After `staleClaimMs` the next sweep reclaims it. One run. |
| K3: after `enqueueWakeup` created the dispatch row and run, before the intent is linked | Dispatch receipt with key `cross-task-continuation-dispatch:<intentId>`, linked to the run; intent `claimed`, `runId` null | Next sweep finds `existingDispatch` by the dispatch key, marks the intent `coalesced` with that `runId`. No second run. If that sweep had instead called `enqueueWakeup`, the dispatch index would reject it. |
| K6: two sweeps reclaim the same stale `claimed` intent | Intent `claimed` | The claim fence lets one win. If both reach `enqueueWakeup`, one receipt and one run commit; the other rolls back on the dispatch index and recovers through `existingDispatch`. One run. |
| K8: `enqueueWakeup` wrote a `skipped` or `deferred_issue_execution` receipt, then the process stopped before the intent was updated | Receipt with the dispatch key; intent `claimed` | Next sweep finds it and sets the intent `skipped` or `coalesced`. No second receipt. A deferred receipt is released later by the existing deferred-release path, which must update that same row. |

**Workspace restore.** The successor's workspace preparation restores the archived workspace through `ensurePersistedExecutionWorkspaceAvailable` under its own identity. If the rebuild fails, the run fails through the existing workspace-preparation failure path. The issue then gets the existing execution blocker with `workspaceRepairRequired`, and the source task is not touched. A target-bound resume gets the same outcome today when the rebuild fails.

Implementation must confirm with a fixture that the target-bound successor reaches `shouldRestoreExistingWorkspace` for an archived `git_worktree` workspace. That means `reuse_existing` with the archived workspace id as `requestedExecutionWorkspaceId`, as `services/heartbeat/workspaces.ts` computes it. If the target's recorded preference does not lead there, the successor would realize a fresh workspace. In that case the implementation stops and reports back. It must not quietly switch strategy, because a fresh workspace would lose the archived branch state.

## 7. Workspace cases

| Target binding at D1/D5 | Cross-task request result | Successor run |
|---|---|---|
| `closed_isolated` (`archived` or `cleanup_failed`) | Deferred path. Comment, `todo` and intent commit. Workspace untouched. | Restores the workspace under its own identity. |
| `open_or_shared`, active (already reopened, or never closed) | Today's path. No reopen is needed. | Uses the active workspace. |
| `none` (no binding) | Today's path. No change. | Normal. |
| `missing` (binding set, row gone) | 409 `This issue is linked to a closed workspace that cannot be reopened.` No writes. | None. |
| Unbound or rebound between D1 and D5, or generation changed | 409, same text. Rollback, no writes. | None. |
| Plugin provider retired (`workspaceProviderRetired`) | 409, same text. No writes. | None. |
| Rebuild fails | Not known at request time. | 6.4: the run fails, the issue gets `workspaceRepairRequired`, the source task is untouched. |
| Shared (non-isolated) workspace | `open_or_shared`. Today's path, no change. | Normal. |

The cross-task request never returns `rebuild_failed`, because it never rebuilds.

## 8. Refusals with no side effects

Each of these must leave no comment, no status change, no intent and no workspace change. Each is a fixture in section 10.

| Case | Expected response |
|---|---|
| Actor without comment access or `issue:mutate` on another agent's issue | 403, today's text |
| Cross-company issue id | 404 or 403, today's text, before any lock |
| Active subtree pause hold | 409 `Issue follow-up blocked by active subtree pause hold` |
| Unresolved blockers | 409 `Issue follow-up blocked by unresolved blockers` |
| Cancelled target without resume intent | 409, today's text |
| Cross-issue cap exceeded | today's cap refusal |
| Missing `clientRequestId` on the deferred path | 422 |
| Gate changed between D0 and D4 (assignee changed, pause hold added, blocker added, another run took execution) | 409 with the matching refusal text |
| Incompatible active work: `executionRunId` or `checkoutRunId` held by a live run | 409 `Issue has active execution` (new refusal text) |
| Workspace not reopenable, binding `missing`, or binding changed before D5 | 409 `This issue is linked to a closed workspace that cannot be reopened.` |
| Reused `clientRequestId` with a different digest | 409 `This clientRequestId was already used for a different request` |
| Deadlock detected between D2 and D9 | 409 `Issue continuation conflicted with a concurrent workspace change; retry` |
| Source run not `running` or not owned by the actor | 403 `Task workspace run identity is unavailable` (the guard text, from the predicate) |

## 9. PATCH and checkout routes

The PATCH route (status change on a closed issue) and the checkout route call the same reopen helper.

- **Checkout** is execution. A checkout by a run bound to another task is already refused by checkout ownership. This plan does not change checkout. A cross-task actor must use the comment path.
- **PATCH** with a status change on a closed target from a cross-task agent run hits the same 403. This plan does not add a deferred PATCH path. Resume must be requested by comment with `resume: true`, which is the documented entry. The PATCH route keeps its 403 unchanged, and its fixture asserts no side effects.

The cross-task agent therefore has one entry point. That keeps the idempotency and audit contract in one place.

## 10. Test matrix

All tests run against real PostgreSQL through the existing route integration harness. Workspace tests use a real archived `git_worktree` fixture. Every refusal and race fixture asserts zero new comments, zero new intents, an unchanged issue row and an unchanged workspace row, unless it says otherwise.

Regression (the diagnosed case):

- **R1.** Agent X is the assignee of a closed target T, whose isolated workspace is archived. X has a running run bound to source task S. X posts a comment with `resume: true` and a `clientRequestId`. The request returns 201. The comment, `todo` and the intent commit in one transaction. T's workspace row is unchanged and stays `archived`, with no reopen-pending flag. `executionState` is byte-identical before and after. `assertTaskWorkspaceExecutionAccess` is never called with the source run for T (asserted with a spy).
- **R2.** The consumer claims the intent and `enqueueWakeup` creates a run whose issue identity is T. Workspace preparation restores the archived workspace under that run. `assertTaskWorkspaceExecutionAccess` passes with the successor run. T's workspace is `active`, on the original branch. The run's responsible user is T's, not the source run's.
- **R3.** R1 with the deployed shape: same assignee, source run with `contextSnapshot.issueId = S`, `nativeIssueId = null`, `executionIdentityRunId` = the source run.

Refusals: one test per row of section 8.

Binding classification:

- **M1.** T's `executionWorkspaceId` points to a deleted row. A cross-task candidate gets 409 with zero effects. A board actor on the same issue keeps today's behavior.
- **M2.** T has no binding (`none`). A cross-task candidate takes today's path; the fixture records today's response and asserts it is unchanged.
- **M3.** Between D1 and D5, another transaction sets T's `executionWorkspaceId` to null. The request gets 409 with zero effects.

Locks:

- **L1.** A concurrent writer rebinds T to another workspace, or bumps the workspace generation, while the deferred transaction is between D5 and D9 (barrier in the transaction). The writer blocks until D9, and then sees `todo` and the unchanged workspace. A second run in the opposite order: the writer commits first, and the deferred request gets 409 at D5.
- **L2.** A concurrent eager reopen by a T-bound run waits on the lifecycle lock held by the deferred transaction until D9, then finds the workspace still closed and reopens it. No deadlock, and still one successor (the T-bound run already is one; the consumer skips the intent if the gates changed, or coalesces it).
- **L3.** The route never calls `withExecutionWorkspaceLifecycleLock` on this path (asserted with a spy).

Idempotency and replay:

- **I1.** The same request is sent twice in sequence. The second gets `replayed: true`, with the same comment id and the same intent id. Row counts do not change.
- **I2.** The same request is sent twice concurrently (two connections, barrier before D2). Exactly one comment and one intent. One response is the original and the other is the replay.
- **I3.** Two different `clientRequestId`s concurrently. Two comments, one `queued` intent, one `coalesced` intent pointing to it, exactly one successor run. Each request replays its own receipt.
- **I4.** Lost response: commit, drop the response, retry. The retry replays.
- **I5.** A fault injected after D6 and before D9. Nothing persists, and a retry succeeds as a fresh request.
- **I6.** Lost response, then the successor restores the workspace, then retry. The retry replays, with the intent's `runId`.
- **I7.** Lost response, then the source run ends, then retry. The retry replays.
- **I8.** Lost response, then a pause hold is added on T, then retry. The retry replays. It is not refused by the pause gate.
- **I9.** Lost response, then the feature setting is turned off, then retry. The retry replays.
- **I10.** Same `clientRequestId`, different body. 409 with zero effects; the original receipt is unchanged.

Delivery and crashes:

- **V1.** A pause hold is added between commit and dispatch. No run starts; the intent ends `coalesced` to a deferred dispatch receipt, or `skipped`, according to the existing pause rule.
- **V2.** The assignee or the responsible user changes between commit and dispatch. The intent is `skipped` with `cross_task_continuation_gate_changed`.
- **V3.** The rebuild fails in the successor run. The run fails, T gets `workspaceRepairRequired`, and S is untouched.
- **V4.** The target-bound path is unchanged: an agent run bound to T posts `resume: true` and still reopens eagerly, as today.
- **V5.** Board and user actors are unchanged: they still reopen eagerly.
- **K1.** Commit, then the process stops before notify. The startup sweep delivers exactly one target-bound run.
- **K2.** The sweep claims the intent, then the process stops before `enqueueWakeup`. After `staleClaimMs` the next sweep delivers exactly one run.
- **K3.** `enqueueWakeup` creates the dispatch row and the run, then the process stops before the intent is linked. The next sweep links the intent to that run and creates no second run.
- **K4.** A status-committer intent and a continuation intent are pending for different issues. One sweep delivers both, each with its own context `source`. The status-committer dispatch still carries its intent key, as today.

Intent and dispatch identity (real PostgreSQL with the implementation's migration applied, not a hand-written schema):

- **K5.** End to end: the route commits the intent; the consumer calls `enqueueWakeup` with the dispatch key; the dispatch receipt and the run commit; the intent is linked (`coalesced`, `runId` set). Assert one intent row with the intent key, one receipt row with `cross-task-continuation-dispatch:<intentId>`, one run with `contextSnapshot.issueId = T`, and no unique violation in the log. This is R2 with the migration installed.
- **K6.** Concurrent stale reclaim: an intent is `claimed` with an old `claimedAt`. Two sweeps on two connections, with a barrier right before `enqueueWakeup`. Exactly one receipt and one run commit. The other call's transaction rolls back (no orphan run row), and that sweep leaves the intent linked to the winner's run, not requeued. A variant drops the claim fence to show that the dispatch index alone still allows one run.
- **K7.** K3 with the migration installed: inject a stop after the `enqueueWakeup` transaction commits and before the intent update. The next sweep links the intent to the existing run through the dispatch key and inserts no receipt.
- **K8.** Skip and defer receipts: (a) the target got a pause hold after commit, so `enqueueWakeup` writes a `skipped` or `deferred_issue_execution` receipt with the dispatch key; the intent becomes `skipped` or `coalesced`. A further sweep does nothing. (b) For the deferred case, release the hold: the existing deferred-release path promotes that same receipt to a run. Assert no second row with the dispatch key and exactly one run. (c) Inject a stop between the receipt and the intent update; the next sweep recovers it without a second receipt (crash window K8 in 6.4).
- **K9.** Replay after dispatch: after K5, the lost-response retry (6.2) finds the intent by its intent key, not the receipt, and returns the intent's `runId`.

Guard invariants:

- **G1.** `runRetainsIssueIdentity` and `assertTaskWorkspaceExecutionAccess` have no diff in this change (checked in review).
- **G2.** A cross-task agent PATCH on T still gets 403 with no side effects.

## 11. Schema, API and docs to update in the implementation

- `packages/db`: three partial unique indexes in one migration: the agent comment `clientRequestId` index (4.1), and the intent and dispatch indexes on `agent_wakeup_requests` (4.2). No new columns.
- `packages/shared`: the comment create response adds optional `replayed?: boolean` and `continuation?: { wakeupRequestId, status, runId, coalescedIntoWakeupRequestId? }`. The validator documents that `clientRequestId` is required for cross-task continuation.
- `server/src/routes/issues.ts`: the R0 replay lookup, `classifyIssueExecutionWorkspaceBinding`, and the deferred branch in the comments route. `getClosedIssueExecutionWorkspace` becomes a wrapper; the PATCH and checkout routes are otherwise unchanged.
- `server/src/services/task-workspace-access.ts`: the `runBindsIssueForWorkspaceExecution` predicate only.
- `server/src/services/heartbeat/queue.ts`: `dispatchPendingNativeStatusWakeups` accepts the `cross-task-continuation-committer` producer. For that producer: the dispatch actor id and the separate dispatch idempotency key, the `existingDispatch` lookup by dispatch key, the claim fence on `claimedAt`, mapping a dispatch-index unique violation to `existingDispatch` recovery, the context `source`, and revalidation (6.4). The status-committer branch keeps its current key and behavior. No new consumer or sweep.
- Docs: the C1 continuation section of the agent-facing API docs must say that cross-task resume needs `clientRequestId`, that the workspace reopens when the successor starts, and how to reconcile a lost response. Update the access and feature maps where the comment route is listed.

## 12. Rollout and rollback

- The migration only adds indexes. It is compatible with the running build, because no current code writes agent `clientRequestId` values, the `issue_cross_task_continuation:` key, or the `cross-task-continuation-dispatch:` key. A build without the consumer change ignores `cross-task-continuation-committer` rows, so the consumer change ships in the same release as the deferred branch.
- Before the indexes are created, check for duplicates (expected none) with a read-only query, one per index. If any exist, stop and report. Do not delete rows.
- The deferred branch ships behind an instance experimental setting, `enableCrossTaskDeferredContinuation`, default off, in the same release. With it off, behavior is exactly today's, including the 403.
- Ops enables it after deployment. Acceptance is a disposable fixture task pair in a test company: R1 to R3 and V3 are repeated in that company. A production business task is not used for acceptance.
- Rollback: turn the setting off. Requests already committed keep their intents, which the consumer still delivers, and R0 still replays them. The indexes can stay, because they are harmless with the setting off.
- Merging this plan, or the implementation, does not resume any blocked business task. Resuming the C1 case is separate delivery work: after deployment and acceptance, the CTO's run re-sends its scheduling-request comment with a `clientRequestId`, under the existing task gates.

## 13. Out of scope

- Changing `runRetainsIssueIdentity`, `assertTaskWorkspaceExecutionAccess` or any other execution guard.
- A same-agent blanket workspace permission, a Board proxy, a scheduler, or a host fallback.
- The `parentId` default for scheduling requests created inside a run. The diagnosis explains it, and team rules handle it separately.
- Production resume, recovery resolve, workspace deletion, database edits, deployment or restart.
