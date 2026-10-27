# Authorized target-bound continuation for archived workspaces

Status: design plan for phenix3443/paperclip#64, amended by phenix3443/paperclip#73. No runtime code changes in this document.

Source references were read at `develop` `17a63c1ae53fb204c84da2584ff601bd64ef9c97`. The diagnosis is the independently reviewed Paperclip report revision `7a310afd-aa9d-41b4-878c-cbbc6264626a`. It was made against the deployed build `6d74176932f9`. Runtime IDs and local paths stay in that report and are not repeated here.

### Amendment history

- **Original plan.** Reviewed and merged by #66 at `cd34e2a0be2e3443da74d2f8a54d36a352bc1e7e`. That revision stays the record of the original approval.
- **Amendment for #73.** Source references for the amendment were read at `develop` `ef2f4565b43215fcaf97ace1fec74a2fb566b0ee`. The original plan assumed that the successor's normal workspace preparation restores an archived `git_worktree` workspace (old 6.4, "Workspace restore"). That is false. `resolveExecutionWorkspaceReuseRequestForIssue` (`services/heartbeat/workspaces.ts`) reports an `archived` row as not available, so `selectHeartbeatEnvironment` passes no reusable workspace, `prepareHeartbeatWorkspace` builds no restore callback, and `provisionExecutionWorkspaceForFreshnessDecision` throws `inherited_workspace_reuse_unavailable`. The implementation for #65 stopped at the plan's stop-and-report condition. Its draft #69 at `8ba4cd4e451fe5c4063c9a96bfb2ce4e0979ce42` reproduces this in `server/src/services/heartbeat/workspace-preparation.test.ts`, test "does not restore an archived git_worktree for a target-bound successor run (deferred continuation premise R2)", with a real `git_worktree` and PostgreSQL. That test is reported evidence of the defect. It is not acceptance of a fix.
- **What the amendment changes.** The successor reopens its own closed workspace before ordinary preparation, through the existing `reopenClosedIsolatedExecutionWorkspaceForIssue` and its locks (new section 6.5). The amendment also corrects the claim that a rebuild failure produces `workspaceRepairRequired` (6.5.5), classifies the service's `rebuild_failed` results by two facts, whether a rebuild call was made and whether the failure bookkeeping committed, and states what the generation fence does and does not cover (6.5.3, 6.5.4), states the decided narrowing of #73's "no duplicate rebuild": an explicit exception for a fault window that the optional fence cannot cover (6.5.4, P1, option (a)), specifies both lock orders against an eager reopen (6.5.6), narrows the route's deferred path to the cases the successor can reopen (3.1, section 7), and revises R2, K5, V3 and L2 (section 10). The other sections are unchanged unless they are marked "(amended by #73)".

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

The cross-task request does not touch the workspace. In one database transaction it saves the comment, moves the target to `todo`, and writes a durable continuation intent bound to the target task. The native intent consumer turns it into a successor run whose issue identity is the target (section 6.4). (Amended by #73.) Before its normal workspace preparation, the successor reopens the closed workspace with its own identity, through the existing `reopenClosedIsolatedExecutionWorkspaceForIssue` (section 6.5). `assertTaskWorkspaceExecutionAccess` then passes, because the run really is bound to the target. Normal preparation then reuses the reopened, active workspace through `shouldRestoreExistingWorkspace`.

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

(Amended by #73.) `closed_isolated` also carries the row's `strategyType` and `providerType`. It uses the status test of the reopen service (`isClosedExecutionWorkspaceStatus`: `archived` or `cleanup_failed`), not the shared `isClosedIsolatedExecutionWorkspace`, which also accepts a set `closedAt`. So the route and the successor agree on what "closed" means. The deferred path admits only a `closed_isolated` row with `strategyType = git_worktree` and a non-plugin provider (`providerType` is not `plugin`). These are the rows that the successor can reopen (6.5). For a cross-task candidate, every other closed isolated row (a plugin provider, a retired provider, or another isolated strategy) gets 409 `This issue is linked to a closed workspace that cannot be reopened.` with zero writes, at D1 and again at D5. Non-candidates keep today's eager path for these rows.

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
| `closed_isolated`, `git_worktree`, not plugin | Deferred path (section 5). | Today's eager reopen. |
| `closed_isolated`, any other strategy or provider (amended by #73) | 409 `This issue is linked to a closed workspace that cannot be reopened.` Zero writes. | Today's eager reopen. |
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
| D5 | Binding re-check: the locked issue's `executionWorkspaceId` still equals the classified id; the locked workspace row exists, is still `isolated_workspace`, still closed, still `git_worktree` with a non-plugin provider (amended by #73), and its lifecycle generation equals the classified generation. Nothing is written to the workspace. | Rollback. 409 `This issue is linked to a closed workspace that cannot be reopened.` |
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

**Workspace restore (amended by #73).** The original text said that the successor's normal preparation restores the archived workspace, and that a rebuild failure gives the issue `workspaceRepairRequired`. Both statements are false for an archived `git_worktree` (see "Amendment history"). Section 6.5 replaces them.

### 6.5 Successor workspace reopening (amended by #73)

#### 6.5.1 Where it runs and who owns it

A new step, `reopenTargetBoundSuccessorWorkspace`, runs in the heartbeat run setup (`services/heartbeat.ts`). It runs after the run's issue context and responsible user are resolved, and before `prepareHeartbeatTaskContext`, `selectHeartbeatEnvironment` and `prepareHeartbeatWorkspace` read the stored workspace status. It runs at most once per run attempt.

- **Owner of the reopen.** The step does not rebuild anything itself. It calls the existing `executionWorkspacesSvc.reopenClosedIsolatedExecutionWorkspaceForIssue` (`services/execution-workspaces.ts`). That service already owns the closed-row checks, the isolated repository source lock, the lifecycle lock, the in-lock revalidation, the rebuild, the failure bookkeeping and the reopen activity rows. No second reopen implementation is added.
- **Identity.** The step passes the successor's own identity. It does not pass any value of the source run or the source request:
  - `authorizationActor`: `{ type: "agent", agentId: run.agentId, companyId, source: "agent_jwt", runId: run.id, onBehalfOfUserId: responsibleUserId }`, with `local-board` mapped to null. This is the same shape as `workspaceAuthorizationActor` in `selectHeartbeatEnvironment`.
  - `actor`: `{ agentId: run.agentId, actorType: "agent" }`.
  - `issue`: the target, read from the database, not from the intent payload.
  - Git auth: the service already builds `createGitRemoteAuthProvider(db, companyId, { issueId: target })`, so the remote credentials are the target's.
- **Continuation into ordinary restore.** After a successful reopen the row is `active`. The run setup then continues unchanged. `selectHeartbeatEnvironment` reads the row again with `getStoredById`, finds it `active`, and passes it as `reusableExistingExecutionWorkspace`. `resolveExecutionWorkspaceReuseProvisioningPolicy` sets `shouldRestoreExistingWorkspace`, and `prepareHeartbeatWorkspace` reuses the active row and its branch through the existing restore callback. `assertTaskWorkspaceExecutionAccess` in `selectHeartbeatEnvironment` runs with the successor run, as today.
- **No nesting.** The step completes and releases every lock before `prepareHeartbeatWorkspace` starts. `prepareHeartbeatWorkspace` takes the isolated repository source lock again on its own. The step holds no database transaction open across the service call.

#### 6.5.2 Eligibility

The step reopens only for a run that is the dispatch of a committed cross-task continuation intent. Every check reads persisted rows. Nothing in the run context or the intent payload grants authority by itself. The checks run in this order. The first check that fails decides the result.

| # | Check | If it fails |
|---|---|---|
| E0 | The run is not an external-provider run (`heartbeatExternalProvider` is null), has no persisted native execution input yet (it is not a same-run resume), and has no `fresh_isolated_workspace` request. | Not eligible. The step does nothing. The run continues as today. |
| E1 | Successor identity. `run.wakeupRequestId` names an `agent_wakeup_requests` row in the run's company whose `idempotencyKey` is `cross-task-continuation-dispatch:<intentId>` and whose `requestedByActorId` is the same string. The intent row `<intentId>` exists in the same company, has `requestedByActorType = system`, `requestedByActorId = cross-task-continuation-committer`, and an `idempotencyKey` that starts with `issue_cross_task_continuation:<targetIssueId>:`. A `source: "cross_task_continuation"` value in the run context without such a receipt is not enough. | Not eligible. The step does nothing. The run continues as today. An archived row then fails as today with `inherited_workspace_reuse_unavailable`. |
| E2 | Target identity. The run's issue identity (`runRetainsIssueIdentity(run, target)`) is the intent's `payload.issueId`. The run's `companyId` is the target's. The run's `agentId` is the target's current `assigneeAgentId` and the intent's `expectedAssigneeAgentId`. | Fail closed (6.5.5). No reopen. |
| E3 | Responsible user. The run's resolved responsible user, the target's current responsible user, and the intent's `expectedResponsibleUserId` are the same. | Fail closed. No reopen. |
| E4 | Binding. The target's `executionWorkspaceId` is the intent's `workspaceId`. | Fail closed. No reopen. This covers a missing binding and a rebind. |
| E5 | Workspace row. The row exists in the company, `mode = isolated_workspace`, `strategyType = git_worktree`, and `providerType` is not `plugin`. | Fail closed. No reopen. This covers a missing row, a plugin provider, a retired provider, and a shared or other non-isolated workspace. |
| E6 | Status. The status is `archived` or `cleanup_failed`. | If the status is `active`, the step does nothing and the run continues to ordinary restore. Another reopen already restored it (6.5.6). Any other status fails closed. |
| E7 | Generation. The row's lifecycle generation equals the intent's `workspaceGeneration`. | Fail closed. No reopen. A generation change means that another writer touched the closed row after the commit, for example a failed reopen whose bookkeeping committed (6.5.4) or an expiration round. A failure whose bookkeeping did not commit does not change the generation. |

E4 to E7 are first read without locks to decide whether to call the service. They are checked again inside the service under its locks (6.5.3), and the in-lock result decides.

`archived` versus `cleanup_failed`: both are closed for this step, and both are reopened through the service, which treats them the same (`isClosedExecutionWorkspaceStatus`). Today `resolveExecutionWorkspaceReuseRequestForIssue` treats only `archived` as unavailable, so ordinary preparation would try to restore a `cleanup_failed` row in place, without the lifecycle lock and without the closed-row checks. For an eligible successor, the step reopens the `cleanup_failed` row first, so ordinary preparation only sees an `active` row. Runs that are not eligible keep today's behavior for both statuses. This plan does not change that behavior.

A projectless target is out of scope. If the queue's dispatch-time check (`isUnrunnableWorktreeCombo` in `heartbeat/queue.ts`) blocks the dispatch because no reusable workspace is available, the intent ends as that dispatch outcome. No successor runs, and nothing is reopened.

#### 6.5.3 Locks and revalidation inside the service

The service already does these steps. The amendment uses them as they are and adds one optional fence. The service is not one locked rebuild: phase B runs before the lifecycle lock, and only phase C runs under it.

1. **Phase A, no lock.** It checks that the target's `executionWorkspaceId` is the workspace, that the row is `isolated_workspace`, and that the actor can read the issue. Then it calls `assertTaskWorkspaceExecutionAccess` with the successor actor.
2. **Phase B, source lock only.** It takes the isolated repository source lock (`withIsolatedRepositorySourceLock`, keyed by the row's `sourceIssueId`, on a dedicated connection). A row without `sourceIssueId` runs phase B with no lock at all. Inside it, it reads the row again and refuses with `not_reopenable` if `sourceIssueId` changed. For a non-plugin `git_worktree` row it then prepares the rebuild source, still outside the lifecycle lock and outside any transaction: it reads the Git cache restoration recipe (`readGitCacheRestoration`), restores the cache base (`restoreGitCacheBase`) or resolves the recorded source, prepares the managed project source (`ensureManagedProjectWorkspace`) when no base is available, and records the copy identity. Each of these four steps can return `rebuild_failed` at once. Phase B never writes the workspace row and never changes its generation. Its effects are on the file system only (a restored cache base, a managed project checkout).
3. **Phase C, lifecycle lock.** It opens one transaction and takes the lifecycle lock (`acquireExecutionWorkspaceLifecycleLock`). Under that lock it reads the issue again (still bound to this workspace and readable), reads the row again, and calls `assertTaskWorkspaceExecutionAccess` again. If the row is no longer closed, it returns `{ ok: true, reopened: false }` and rebuilds nothing. It compares the row and the project source with the phase B snapshot and returns `not_reopenable` if they changed. It recovers Git cache expiration locks (`recoverGitCacheExpirationLocks`); a failure there returns `rebuild_failed` with no write. Then, inside one `try` whose errors become `rebuildError`, it reads the assignee and project trust policy, refuses if the trust policy is unavailable or denied, checks copy-only provisioning, and only then calls `ensurePersistedExecutionWorkspaceAvailable` (the rebuild). After the `try` it writes the row in the same transaction: on `rebuildError` the failure bookkeeping (notify, row update, `reopen_failed` activity), otherwise `active` (notify, row update, `reopened` activity). Any error thrown in phase C outside that `try`, including during either write, rolls the transaction back, and the transaction's `.catch` returns `rebuild_failed`.
   Two writes during the rebuild do not belong to that transaction. `persistContentsRestoredAt` updates `metadata.gitCacheRestoration.contentsRestoredAt` through the outer `db`, so it commits on its own when the row has a recipe with saved contents and those contents are restored. The operation recorder is created on the outer `db` (`workspaceOperationService(db)`), so operation records that the rebuild writes are not rolled back either. The worktree that the rebuild creates on disk is never rolled back.
4. **New, optional input: `expectedClosedGeneration`.** When it is set, the service checks it at two points, and only while the row is closed: in phase B right after the source-lock re-read, before any rebuild-source preparation; and in phase C right after the "no longer closed" check, before the snapshot comparison. If the row's lifecycle generation differs, it returns `{ ok: false, code: "not_reopenable" }` and writes nothing. The phase C check decides; the phase B check only avoids repeating phase B work after a committed failure (F3, 6.5.4) by another caller, which is visible by then because that caller wrote it inside its own source lock. A row without `sourceIssueId` has no source lock, so its phase B check can race and only the phase C check is reliable. The successor step passes the intent's `workspaceGeneration`. The existing callers (the comment, PATCH and checkout routes) do not pass it, so their behavior does not change.

Terms used below: a **rebuild** is a call to `ensurePersistedExecutionWorkspaceAvailable` made by this service in phase C, whatever its result. Calls made by `prepareHeartbeatWorkspace` during ordinary restore are not counted as rebuilds.

The step does not install the route's `guardReopenedWorkspaceConsumption`. That guard keeps the reopen-pending flag from leaking while a route moves a terminal issue out of the terminal state. The successor's target is already `todo` or later, because D7 committed that before the intent. So the terminal reaper clears the flag on its next pass, as for any non-terminal issue. If the target becomes terminal again before the run consumes the workspace, the step calls the existing `clearReopenPendingConsumptionForUnconsumedReopen` with the generation that the reopen returned, and the run fails closed.

#### 6.5.4 Result mapping

| Service result | Successor run |
|---|---|
| `ok`, `reopened: true` | Continue to ordinary restore of the active row. |
| `ok`, `reopened: false` (already active) | Continue to ordinary restore of the active row. No rebuild. |
| `not_reopenable` (binding changed, source changed, generation changed, row gone) | Fail closed (6.5.5). Nothing was written to the row. |
| `rebuild_failed`, any kind | Fail closed (6.5.5). See the kinds below. |
| Thrown 403 from `assertTaskWorkspaceExecutionAccess` in phase A | Fail closed. This is the guard's normal refusal, not a new path. A 403 thrown inside the phase C transaction is caught by the service, rolled back, and returned as `rebuild_failed`: kind F1 below if it was thrown before the `rebuildError` `try`, kind F3 if it was thrown inside it (for example by the copy identity checks during the rebuild). |

The service returns the same code for every `rebuild_failed`. The step does not tell them apart: all fail closed the same way, and V3 is the same. They differ in two facts, which the fixtures check separately: whether a rebuild call was made, and whether the failure bookkeeping committed. Three kinds follow from the base revision:

| Kind | Where it comes from (base revision) | Rebuild call | Row after the call | File system after the call | Activity |
|---|---|---|---|---|---|
| **F1, failed before any rebuild call, nothing committed** | Phase B: recipe read, cache base restore, managed source preparation, copy identity. Phase C: `recoverGitCacheExpirationLocks`, and any throw in phase C before the `rebuildError` `try` (an in-lock 403, a failed re-read), which rolls the transaction back. | None | Byte-identical: status, `cleanupReason`, `cleanupEligibleAt` (still set if it was, so the cleanup reaper keeps its schedule), metadata, generation `g`. | Phase B effects only (a restored cache base, a managed project checkout). No worktree at the row's `cwd`. | None. A server log line for a rolled-back transaction. |
| **F2, rebuild call made, bookkeeping not committed** | Phase C, after the rebuild call returned or threw: a throw in notify, in the row update or in `logActivity`, on either the success branch or the `rebuildError` branch. The transaction rolls back and the `.catch` returns `rebuild_failed`. The `!activeRow` return on the success branch belongs here too (nothing written). | One | Status, `cleanupReason`, `cleanupEligibleAt` and generation `g` unchanged. Metadata unchanged except `gitCacheRestoration.contentsRestoredAt`, which `persistContentsRestoredAt` may have committed through the outer `db` (6.5.3). Operation records written by the recorder stay. | Whatever the rebuild left: a complete worktree on the recorded branch (if the rebuild succeeded), a partial one, or none. Not rolled back. | None. |
| **F3, bookkeeping committed** | Phase C, the `rebuildError` branch committed. Its cause is either the rebuild call (it threw or returned null) or a refusal inside the same `try` before the call: assignee or project trust policy unavailable, trust denied, or a copy-only provisioning check that threw. | One, or none for a refusal before the call | Still closed. `cleanupReason` is the reopen-failed reason, `cleanupEligibleAt` is null, generation `g + 1`, `gitCacheExpiration` removed from metadata. | Whatever the rebuild left, if it ran. | One `execution_workspace.reopen_failed`. |

So "F3" does not imply a rebuild call, and "no committed bookkeeping" (F1, F2) does not imply that no rebuild ran.

What the generation fence covers. The fence compares the closed row's generation with `g`. Only a committed write raises it: the success write (which also leaves the row `active`, so a later caller returns `reopened: false` before the fence) or the F3 bookkeeping. So:

- After a success or an F3 failure, a later fenced call makes no rebuild call.
- After F1 or F2 the row is still closed with generation `g`. A later fenced call passes the fence and makes its own rebuild call. After F1 nobody has made a rebuild call yet, so that call is the first. After F2 it is the second rebuild call on that row. It runs `ensurePersistedExecutionWorkspaceAvailable` against whatever F2 left on disk: if the worktree directory exists, the function takes its existing-directory path (it validates the linked worktree and its branch and reuses it, the same path that ordinary restore takes for an active row on every run, or throws, for example `git_worktree_not_reusable`, for a directory that is not a valid linked worktree on the recorded branch, which the second caller then records as F3); if no directory exists, it creates the worktree.

Raising the generation on every failure, or recording F2 outside the rolled-back transaction, would change the eager callers' failure behavior, which is outside this amendment.

**P1, decided: option (a). The F2 window and "no duplicate rebuild".** #73 asked for "no duplicate rebuild" in L2. The optional fence cannot give that for F2: an eager call that rebuilds and then fails to commit leaves no committed trace that the fence can read, so the successor makes a second rebuild call (L2g: 1 / 1). The CTO accepted option (a) against revision `f3860d74d7fdc45d4edb807913c5a771ec77cecd`, and #73's final contract states it. The contract is:

- A later fenced successor makes no rebuild call after a committed success or committed F3 bookkeeping for the intent's generation. The successor makes at most one rebuild call per intent.
- F2 is an explicit fault-window exception, not a normal-race guarantee. If an eager rebuild call succeeds on disk and a later database write in the same transaction rolls back, the successor may make one more rebuild call (eager / successor `1 / 1`). F2 needs a database error after the rebuild inside the same transaction.
- Rebuild calls are counted per caller and kept apart from ordinary restore calls of `ensurePersistedExecutionWorkspaceAvailable` (from `prepareHeartbeatWorkspace`). Counts never fold the successor's second service rebuild call in F2 into ordinary restore.
- When the eager rebuild succeeded, the successor's call takes the existing-directory path and reuses the same worktree directory (same inode; L2g). F2 can also leave a partial or absent directory. Then the successor's call keeps today's validation: it throws for an invalid directory (recorded as F3) or creates the worktree when none exists. The step fails closed on any failure (6.5.5). Nothing trusts a partial directory.
- Existing eager callers are unchanged. This amendment adds no committed marker before the rebuild call and no F2 bookkeeping outside the transaction. It does not change guards, real failure reporting, cleanup or reaper behavior, or retry bounds. Option (b), covering the window with such a marker or out-of-transaction bookkeeping, is outside this delivery and needs its own plan and review if it is ever wanted.

L2g is a required acceptance fixture (section 10).

#### 6.5.5 Failure path (V3)

"Fail closed" means that the step throws a setup error with a fixed message, `Cross-task continuation could not reopen the target workspace`, followed by the service's own message. The service messages are already free of repository URLs, host paths and Git output. The error is not a `WorkspaceValidationFailure` and not a Git scan error. So it does not enter the bounded transient retry in `heartbeat/retries.ts`, which retries `workspace_validation_failed`.

The existing propagation path, as read at the amendment's base revision:

1. The outer catch in the run setup (`services/heartbeat.ts`) calls `runCompletion.failRunSetup`.
2. `failRunSetup` (`services/heartbeat/run-completion.ts`) sets the run to `failed` with `errorCode = setup_failed` and `resultJson.executionRecovery = { kind: "bootstrap", providerWorkStarted: false }`. It marks the dispatch receipt `failed`, and calls `releaseIssueExecutionAndPromote` and `handleIssueReviewPathDisposition`.
3. The stranded-issue sweep (`reconcileStrandedAssignedIssues`, `services/recovery/service.ts`) then handles the target. Two lanes are possible, depending on the target's status when the run failed:
   - `in_progress`: `classifyContinuationFailure` classifies `setup_failed` as `non_retryable`, so the sweep calls `escalateStrandedAssignedIssue` at once. The target becomes `blocked` with the "Continuation failed" notice.
   - `todo`: the sweep queues one `issue_assignment_recovery` run. That run is not a successor (its wakeup row is not a dispatch receipt), so the step does not reopen. It fails as any non-successor run on a closed row fails today. When `didAutomaticRecoveryFail(latestRun, "assignment_recovery")` is true, the sweep calls `escalateStrandedAssignedIssue`, and the target becomes `blocked` with the "No live execution path" notice.
4. In both lanes the result is a `blocked` target with the stranded recovery action and notice. This does **not** set `workspaceRepairRequired`. `getExecutionBlocker` (`services/execution-blocker.ts`) sets that flag only for a recovery action whose cause is an execution-reconciliation cause and whose evidence is `workspaceRestoreFailure = restore_unsafe_archive`, the legacy workspace restore recovery schema, or an unreconciled native export. A local `git_worktree` reopen failure produces none of these. This plan does not add a new blocker kind and does not write `workspaceRepairRequired`.

Retry and repair:

- At most one service call, and so at most one rebuild call by the successor, runs per intent: the successor's single call. The assignment-recovery retry does not call the service, because it is not eligible. A later sweep does not either. This holds for all three kinds of `rebuild_failed`. It does not count rebuild calls by eager callers (6.5.6, P1).
- Repair uses the existing paths. A person or an agent fixes the cause (for example a remote or a credential) and then asks for continuation again: an eager reopen by a target-bound actor, or a new cross-task comment, which commits a new intent with the row's current generation (`g + 1` after F3, `g` after F1 or F2).
  - After F3 the row is closed and retryable, because the failed reopen cleared `cleanupEligibleAt`.
  - After F1 the row is exactly as it was before the call. Its `cleanupEligibleAt` may still be set, so the cleanup reaper may run its normal round before the repair and raise the generation. A repair after that round sees the row as the reaper left it, as today. This plan does not change the reaper and does not clear `cleanupEligibleAt` for F1 or F2.
  - After F2 the row is as after F1, except for a possibly committed `contentsRestoredAt`, and a worktree may exist on disk at the row's `cwd`. The repair's rebuild call takes the existing-directory path (6.5.4). What a cleanup round does with that worktree before the repair is today's behavior; this plan does not change it, and the fixtures do not run the reaper in that window.
- The source task is untouched. Its status, comments, `executionState`, runs and workspace do not change. The source run is not used in any authorization of the successor.

The implementation must confirm both lanes with fixtures (V3a, V3b). If the sweep does neither (for example it re-dispatches without a bound, or leaves the target in `todo` with no live path and no escalation), the implementation stops and reports. It must not add a new retry loop or a new blocker kind.

#### 6.5.6 Concurrency with an eager reopen (L2)

An eager reopen is any call to `reopenClosedIsolatedExecutionWorkspaceForIssue` without the fence: the comment, PATCH or checkout route used by a board user or by a run that is bound to the target. Every participant takes locks in this global order, and none takes them in another order:

1. the isolated repository source lock (the service, and later `prepareHeartbeatWorkspace`);
2. the lifecycle lock (the service, and the deferred route transaction at D2);
3. the issue and workspace rows (the deferred route takes them `FOR UPDATE`; the service reads them and then updates the workspace row).

The deferred route transaction takes 2 and 3, never 1. The service takes 1, then 2, then 3. The successor step and `prepareHeartbeatWorkspace` run one after the other and never hold locks at the same time (6.5.1). So no participant waits for a lock while it holds a lock that comes later in the order, and there is no wait cycle.

The two orders:

- **Successor first.** The step holds the source lock and then the lifecycle lock, and rebuilds. The eager reopen waits at the source lock, or at the lifecycle lock if the row has no `sourceIssueId`. The step commits `active` with generation `g + 1`. The eager reopen then reads the row under its own locks, finds it not closed, and returns `reopened: false`. The route treats that as `already-open` and does not install its consumption guard. One rebuild.
- **Eager first.** The successor step waits. The eager reopen commits `active`. The step finds the row not closed under the lock and returns `reopened: false`. The run continues to ordinary restore. One rebuild. The fence is not checked, because the row is no longer closed.
- **Eager first, and its failure is committed (F3).** The row stays closed with generation `g + 1`. The step's fence (`expectedClosedGeneration = g`) does not match. If the step was already waiting at the source lock, its phase B check stops it before any rebuild-source preparation; otherwise the unlocked E7 pre-check stops it before the service call. The phase C check is the backstop. The service returns `not_reopenable` and the run fails closed (6.5.5). No second rebuild of a row that just failed.
- **Eager first, and it fails before any rebuild call (F1).** The row is unchanged at generation `g`. The fence matches, so the step makes the intent's single attempt. If the cause persists, the step also gets F1 and fails closed. If the cause is gone, the step reopens the row. Either way the eager call made no rebuild call, so there is at most one rebuild call in total.
- **Eager first, it makes the rebuild call, and its transaction then rolls back (F2).** The row is still closed at generation `g`, and the eager rebuild's worktree may be on disk. The fence matches, so the step makes the intent's single attempt, and its rebuild call is the second one on the row (1 / 1). That call runs on the directory that F2 left (6.5.4). The fence cannot prevent it: nothing that the fence reads was committed. This is the F2 fault-window exception of P1, option (a) (6.5.4).
- **Rebind or generation change while the step waits.** The in-lock issue read no longer finds the binding, or the fence does not match. The service returns `not_reopenable` and writes nothing. The new binding is not touched. Phase B work that the step did before it reached the lifecycle lock (a restored cache base) stays on disk, as for any eager call that loses the same race today.

No duplicate successor: the dispatch index (4.2) allows one dispatch receipt per intent, so one intent has at most one run. If a target-bound run holds the target's execution when the intent is dispatched, `enqueueWakeup` writes a `deferred_issue_execution` receipt, and the existing release path promotes that same receipt to a run later (K8). That run is still the intent's only run, and it finds the row active.

Branch state: the reopen rebuilds the worktree on the recorded `branchName` from the retained branch or from the recorded Git cache restoration. The fixtures check that the branch and its head commit after the reopen are the ones recorded before the archive, in both orders.

#### 6.5.7 Setting and rollback

The step is not gated by `enableCrossTaskDeferredContinuation`. It acts only on a run that is the dispatch of a committed intent (E1), and an intent exists only if the setting was on when the request committed. With the setting off from the start, no intent exists and the step never reopens anything. If the setting is turned off later, intents that are already committed are still delivered (section 12), and their successors still reopen. If the successor step were gated too, those successors would fail with `inherited_workspace_reuse_unavailable` instead. The setting stays default off.

## 7. Workspace cases

| Target binding at D1/D5 | Cross-task request result | Successor run |
|---|---|---|
This table is amended by #73. The successor column follows section 6.5.

| Target binding | Cross-task request result | Successor run |
|---|---|---|
| `closed_isolated`, `git_worktree`, not plugin, `archived` | Deferred path. Comment, `todo` and intent commit. Workspace untouched. | The step reopens the row through the service under the successor's identity, then ordinary restore reuses it. |
| Same, `cleanup_failed` | Deferred path, as above. | Same as `archived`: the service reopens it first. Ordinary preparation does not restore the `cleanup_failed` row in place. |
| `closed_isolated` with a plugin provider (retired or not) or another isolated strategy | 409 `This issue is linked to a closed workspace that cannot be reopened.` No writes. | None. |
| `open_or_shared`, active (already reopened, or never closed) | Today's path. No reopen is needed. | Uses the active workspace. |
| `none` (no binding) | Today's path. No change. | Normal. |
| `missing` (binding set, row gone) | 409, same text. No writes. | None. |
| Unbound or rebound between D1 and D5, or generation changed | 409, same text. Rollback, no writes. | None. |
| Unbound, rebound, row gone, or generation changed after commit and before the step | Already committed. | E4, E5 or E7 fails, or the in-lock check returns `not_reopenable`. No rebuild. Fail closed (6.5.5). |
| Already reopened by an eager reopen after commit | Already committed. | E6 sees `active`, or the service returns `reopened: false`. No rebuild. Ordinary restore. |
| Rebuild fails, its preparation fails, or its bookkeeping rolls back | Not known at request time. | `rebuild_failed`, kind F1, F2 or F3 (6.5.4). Fail closed (6.5.5): the run fails with `setup_failed`, and the target becomes `blocked` through the stranded-issue sweep. No `workspaceRepairRequired`. The source task is untouched. |
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
| Workspace not reopenable, binding `missing`, binding changed before D5, or a closed isolated row that is not a non-plugin `git_worktree` (amended by #73) | 409 `This issue is linked to a closed workspace that cannot be reopened.` |
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
- **R2 (amended by #73).** Fixture: a real `git_worktree` workspace for T with a commit on its branch that is not merged, archived through the real cleanup (`cleanupExecutionWorkspaceArtifacts`, which removes the worktree directory and keeps the branch), and the row set to `archived`. The consumer claims the intent, and `enqueueWakeup` creates a run whose issue identity is T, with the dispatch receipt as its `wakeupRequestId`. The successor step calls `reopenClosedIsolatedExecutionWorkspaceForIssue` once, with `authorizationActor.runId` = the successor run and `expectedClosedGeneration` = the intent's generation. The service rebuilds the worktree and returns `reopened: true`. Then `selectHeartbeatEnvironment` passes the active row as reusable, `shouldRestoreExistingWorkspace` is true, and `prepareHeartbeatWorkspace` reuses it without throwing. Assert: the row is `active` with generation `g + 1`; the worktree exists on the recorded `branchName` and its head is the commit made before the archive; one `execution_workspace.reopened` activity row with T's issue id; `assertTaskWorkspaceExecutionAccess` was called only with the successor run for T, never with the source run (spy); the run's responsible user is T's, not the source run's.
- **R2-P (present reproduction, kept as a negative control).** The #69 test at `8ba4cd4e451fe5c4063c9a96bfb2ce4e0979ce42` showed that ordinary preparation alone fails with `inherited_workspace_reuse_unavailable` and leaves the row `archived`. With the amendment this stays true for a run that is not eligible (E1 fails). The fixture keeps that assertion for a run whose `wakeupRequestId` is not a dispatch receipt. It is not the acceptance test for the fix. R2 is.
- **R2-C.** R2 with the row set to `cleanup_failed` instead of `archived`. The service reopens it. Ordinary preparation does not restore the `cleanup_failed` row in place (spy: the restore callback sees an `active` row).
- **R3.** R1 with the deployed shape: same assignee, source run with `contextSnapshot.issueId = S`, `nativeIssueId = null`, `executionIdentityRunId` = the source run.

Refusals: one test per row of section 8.

Binding classification:

- **M1.** T's `executionWorkspaceId` points to a deleted row. A cross-task candidate gets 409 with zero effects. A board actor on the same issue keeps today's behavior.
- **M2.** T has no binding (`none`). A cross-task candidate takes today's path; the fixture records today's response and asserts it is unchanged.
- **M3.** Between D1 and D5, another transaction sets T's `executionWorkspaceId` to null. The request gets 409 with zero effects.

Locks:

- **L1.** A concurrent writer rebinds T to another workspace, or bumps the workspace generation, while the deferred transaction is between D5 and D9 (barrier in the transaction). The writer blocks until D9, and then sees `todo` and the unchanged workspace. A second run in the opposite order: the writer commits first, and the deferred request gets 409 at D5.
- **L2 (amended by #73).** Real PostgreSQL, a real archived `git_worktree` as in R2, two connections, and two barriers inside the service: one right after the source lock is taken (before phase B) and one right after the lifecycle lock is taken (phase C). "Rebuild" is a call to `ensurePersistedExecutionWorkspaceAvailable` made inside `reopenClosedIsolatedExecutionWorkspaceForIssue` (6.5.3), counted per caller; calls from `prepareHeartbeatWorkspace` are not counted. Counts cover the window from the first participant's start until the successor run has finished workspace preparation or has failed setup.
  - Every variant asserts: no deadlock (both calls finish within the test timeout, and no PostgreSQL deadlock error); at most one run per intent (one row with the dispatch key); the successor step calls the service at most once and makes at most one rebuild call; no rebuild call after a committed success or a committed failure (F3) of the same generation; a `not_reopenable` result writes nothing.
  - Each variant also asserts the rows in the table below. F1, F2 and F3 are the kinds of `rebuild_failed` (6.5.4). "Rebuilds" counts rebuild calls, whatever their result. Branch and head "as recorded" means the branch and head commit recorded before the archive, as in R2. "Unchanged" means the row's status, `cleanupReason`, `cleanupEligibleAt`, generation and `branchName` are byte-identical to before the variant.

| Variant | Eager result | Step result | Rebuilds (eager / step) | `reopened` rows | `reopen_failed` rows | Row at the end | Branch and head |
|---|---|---|---|---|---|---|---|
| L2a | `already-open` | `reopened: true` | 0 / 1 | 1 (step) | 0 | `active`, `g + 1` | as recorded |
| L2b | `reopened` | `reopened: false` | 1 / 0 | 1 (eager) | 0 | `active`, `g + 1` | as recorded |
| L2c-F3 | `rebuild_failed`, F3 | `not_reopenable` | 1 / 0 | 0 | 1 (eager) | closed, reopen-failed reason, `cleanupEligibleAt` null, `g + 1` | branch kept, no worktree |
| L2c-F1 | `rebuild_failed`, F1 | `rebuild_failed`, F1 | 0 / 0 | 0 | 0 | unchanged, `g` | branch kept, no worktree |
| L2d | none | `not_reopenable` | – / 0 | 0 | 0 | both rows unchanged; T bound to the new workspace (or null) | branch kept, no worktree |
| L2e | `reopened` | not called (E6 `active`) | 1 / 0 | 1 (eager) | 0 | `active`, `g + 1` | as recorded |
| L2f-1 | none | `reopened: true` | – / 1 | 1 (step) | 0 | `active`, `g + 1` | as recorded |
| L2f-2 | `reopened` (by the holding run) | not called (E6 `active`) | 1 / 0 | 1 (eager) | 0 | `active`, `g + 1` | as recorded |
| L2g-activity, L2g-update (P1 (a), F2 exception) | `rebuild_failed`, F2 | `reopened: true` | 1 / 1 | 1 (step) | 0 | `active`, `g + 1` | as recorded |

  - **L2a, successor first.** The successor step holds the lifecycle barrier. The eager reopen (a board comment with `resume: true` on T) starts and waits at the source lock. Release the barrier. The eager call then runs phase B with the row `active`, so it prepares no cache base, and returns `already-open` and installs no consumption guard. If the eager call returns an error instead of `already-open` for a row that became active while it waited, the implementation stops and reports. It must not change the eager path to make the fixture pass.
  - **L2b, eager first.** The eager reopen holds the lifecycle barrier. The successor step starts and waits. Release. The step returns `reopened: false`, and the run continues to ordinary restore of the active row.
  - **L2c-F3, eager first and its rebuild fails with committed bookkeeping.** The eager reopen holds the lifecycle barrier; the step waits at the source lock. The fixture makes the eager rebuild call itself fail, so that the failure lands in the `rebuildError` branch and commits. The eager call makes one rebuild call; a trust refusal would give F3 with zero calls and is not this fixture. Use a real cause if one reaches that branch with the R2 fixture; otherwise make `ensurePersistedExecutionWorkspaceAvailable` throw for the eager call only. Release. The R2 row has a `sourceIssueId`, so the eager failure is committed inside the eager call's source lock and is visible when the step takes that lock. The step's phase B fence check returns `not_reopenable`: the step runs no cache restore, no managed source preparation and no rebuild (spies on `restoreGitCacheBase` and `ensureManagedProjectWorkspace`: zero calls from the step). The run fails closed (V3 path). A second sub-run starts the step only after the eager failure committed: the unlocked E7 pre-check fails and the step makes no service call.
  - **L2c-F1, eager first and it fails before any rebuild call.** The cause is one that persists for both calls and fails in phase B: the fixture writes a malformed Git cache restoration recipe into the row's metadata, so `readGitCacheRestoration` throws. The generation is not changed by that write. The eager call fails first; then the step runs. The fence matches (`g`), the step makes the intent's single attempt, fails the same way, and the run fails closed (V3 path). No rebuild by either caller.
  - **L2d, rebind while waiting.** While the step is held at the lifecycle barrier, another transaction sets T's `executionWorkspaceId` to another workspace (or null). The step returns `not_reopenable`. Neither workspace row is written by the step. No eager call takes part.
  - **L2e, deferred route against the service.** A deferred route transaction for T holds the lifecycle lock between D5 and D9, while an eager reopen for T has the source lock and waits for the lifecycle lock. The route commits. The eager reopen then finds the row still closed and reopens it. The intent is later dispatched to one run, whose step sees the row `active` at E6 and does not call the service.
  - **L2g, eager first, rebuild call made, then its transaction rolls back (F2; P1 option (a) exception). Required.** Real PostgreSQL and the archived `git_worktree` of R2. L2g runs in two required variants that differ only in the injected fault: **L2g-activity** makes `logActivity` throw for the eager call's `execution_workspace.reopened` row only; **L2g-update** makes the eager call's row update (`tx.update` on the success branch) throw instead. In both, the eager reopen holds the lifecycle barrier and the step waits at the source lock. The eager rebuild call runs for real and succeeds, so the worktree is on disk on the recorded branch. Then the injected fault throws, the eager transaction rolls back and the call returns `rebuild_failed`. Assert after the eager call: the row's status, `cleanupReason`, `cleanupEligibleAt` and generation `g` are unchanged; no `execution_workspace.reopened` or `reopen_failed` activity row; the rebuilt worktree directory exists. Record separately what committed outside the rolled-back transaction, and do not count it as rolled-back state: `metadata.gitCacheRestoration.contentsRestoredAt` (may differ from before only if the row has a recipe with saved contents) and the operation records written by the recorder for the eager call. Record the worktree directory's inode. Release. The step's fence matches `g`, and the step makes one rebuild call, which takes the existing-directory path. The step returns `reopened: true`. Assert after the step: eager / successor rebuild calls `1 / 1`, counted per caller and apart from ordinary restore calls; one `execution_workspace.reopened` row, from the step; no `reopen_failed` row; the row `active` with generation `g + 1`; the same worktree directory inode as after the eager call; the branch and head commit as recorded before the archive. The same-inode assertion applies only to this fixture, where the eager rebuild succeeded on disk. An F2 that leaves a partial or absent directory keeps today's validation in the step's rebuild call and the fail-closed V3 path (6.5.4, 6.5.5); L2g does not cover it and the implementation must not relax that validation to make it pass.
  - **L2f, a target-bound run holds T's execution.** A fixture run bound to T holds T's execution lock when the intent is dispatched, so `enqueueWakeup` writes a `deferred_issue_execution` receipt. The release path later promotes that same receipt to the intent's only run, and E1 accepts it because its `wakeupRequestId` is the dispatch receipt. **L2f-1:** the holding run does not touch the workspace; the promoted run's step reopens the row after promotion. **L2f-2:** while it holds execution, the holding run posts `resume: true` on T, which reopens the row eagerly; the promoted run's step sees the row `active` at E6 and does not call the service.
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
- **V3 (amended by #73).** The successor step's single service call returns `rebuild_failed`. V3 runs once for each kind F1, F2 and F3 (6.5.4):
  - **V3-F3, committed failure.** The rebuild call itself fails in phase C, as in L2c-F3 but in the step's own call. Assert one rebuild call, one `execution_workspace.reopen_failed` row, and the row closed with the reopen-failed `cleanupReason`, `cleanupEligibleAt` null and generation `g + 1`.
  - **V3-F1, failure before any rebuild call.** Phase B fails, as in L2c-F1. Assert zero rebuild calls, no `reopen_failed` row, and the row unchanged (status, `cleanupReason`, `cleanupEligibleAt` and generation `g` byte-identical to before the call).
  - **V3-F2, rebuild call made, bookkeeping rolled back.** In the step's own call the rebuild call succeeds, and then `logActivity` throws for the `execution_workspace.reopened` row, as in L2g but with no eager call. Assert one rebuild call, no activity row, the row still closed with status, `cleanupReason`, `cleanupEligibleAt` and generation `g` unchanged (metadata as in L2g), and the worktree directory on disk. This fixture has a single caller, so it does not depend on P1.
  - For every kind: the run is `failed` with `errorCode = setup_failed`, an error that starts with `Cross-task continuation could not reopen the target workspace`, and `executionRecovery.providerWorkStarted = false`; no bounded transient retry is scheduled. Then run the stranded-issue sweep. V3a and V3b each run with every kind:
  - **V3a.** T was `in_progress` when the run failed. One sweep moves T to `blocked` through `escalateStrandedAssignedIssue`, with the "Continuation failed" notice.
  - **V3b.** T was `todo` when the run failed. The first sweep queues one `issue_assignment_recovery` run. That run does not call the reopen service (spy), and it fails. The next sweep moves T to `blocked` with the "No live execution path" notice. V3b uses an `archived` row. For a `cleanup_failed` row the recovery run follows today's in-place behavior for non-successor runs, which this plan does not change. The fixture records that outcome and does not assert it as part of this contract.
  - In both: exactly one call to the reopen service in total; `getExecutionBlocker(T)` does not report `workspaceRepairRequired`; S's status, comments, `executionState`, runs and workspace are byte-identical before and after; a later sweep makes no further run or rebuild.
  - **V3-repair.** After V3a with V3-F3, fix the cause and post a board comment with `resume: true` on T. The eager reopen rebuilds the row, which is still closed and retryable. After V3a with V3-F1, remove the malformed recipe and do the same before any cleanup round: the eager reopen rebuilds the unchanged row. After V3a with V3-F2, remove the injected fault and do the same: the eager reopen's rebuild call takes the existing-directory path (same worktree inode) and the row becomes `active`, `g + 1`. That is a second rebuild call on the row, made by a new request after the intent's single attempt, which the contract allows. The fixture does not run the cleanup reaper between the failure and the repair; the reaper's behavior on that row is today's and is not part of this contract.
- **V4.** The target-bound path is unchanged: an agent run bound to T posts `resume: true` and still reopens eagerly, as today.
- **V5.** Board and user actors are unchanged: they still reopen eagerly.
- **K1.** Commit, then the process stops before notify. The startup sweep delivers exactly one target-bound run.
- **K2.** The sweep claims the intent, then the process stops before `enqueueWakeup`. After `staleClaimMs` the next sweep delivers exactly one run.
- **K3.** `enqueueWakeup` creates the dispatch row and the run, then the process stops before the intent is linked. The next sweep links the intent to that run and creates no second run.
- **K4.** A status-committer intent and a continuation intent are pending for different issues. One sweep delivers both, each with its own context `source`. The status-committer dispatch still carries its intent key, as today.

Intent and dispatch identity (real PostgreSQL with the implementation's migration applied, not a hand-written schema):

- **K5 (amended by #73).** End to end, with the archived `git_worktree` fixture of R2: the route commits the intent; the consumer calls `enqueueWakeup` with the dispatch key; the dispatch receipt and the run commit; the intent is linked (`coalesced`, `runId` set); the run starts, the successor step reopens the workspace, and ordinary preparation reuses it. Assert one intent row with the intent key, one receipt row with `cross-task-continuation-dispatch:<intentId>`, one run with `contextSnapshot.issueId = T` and that receipt as `wakeupRequestId`, no unique violation in the log, and every R2 assertion. This is R2 with the migration installed and the real route and consumer, not hand-written rows.
- **K6.** Concurrent stale reclaim: an intent is `claimed` with an old `claimedAt`. Two sweeps on two connections, with a barrier right before `enqueueWakeup`. Exactly one receipt and one run commit. The other call's transaction rolls back (no orphan run row), and that sweep leaves the intent linked to the winner's run, not requeued. A variant drops the claim fence to show that the dispatch index alone still allows one run.
- **K7.** K3 with the migration installed: inject a stop after the `enqueueWakeup` transaction commits and before the intent update. The next sweep links the intent to the existing run through the dispatch key and inserts no receipt.
- **K8.** Skip and defer receipts: (a) the target got a pause hold after commit, so `enqueueWakeup` writes a `skipped` or `deferred_issue_execution` receipt with the dispatch key; the intent becomes `skipped` or `coalesced`. A further sweep does nothing. (b) For the deferred case, release the hold: the existing deferred-release path promotes that same receipt to a run. Assert no second row with the dispatch key and exactly one run. (c) Inject a stop between the receipt and the intent update; the next sweep recovers it without a second receipt (crash window K8 in 6.4).
- **K9.** Replay after dispatch: after K5, the lost-response retry (6.2) finds the intent by its intent key, not the receipt, and returns the intent's `runId`.

Successor eligibility (added by #73; real PostgreSQL and the archived `git_worktree` fixture of R2). Each case that is not eligible or fails closed asserts zero calls to the reopen service or a `not_reopenable` result, no rebuild, and an unchanged workspace row, unless it says otherwise:

- **E1.** A run for T whose context has `source: "cross_task_continuation"` but whose `wakeupRequestId` is an ordinary wakeup row: not eligible. It fails as in R2-P.
- **E2.** A dispatch receipt whose intent names another issue, or an intent from another company: fail closed.
- **E3.** The assignee or the responsible user of T changed after the commit (the consumer's revalidation is bypassed in the fixture to reach the step): fail closed.
- **E4.** T's binding is cleared or points to another workspace: fail closed.
- **E5.** The row was deleted, or changed to a plugin provider or another strategy: fail closed.
- **E6.** The row is already `active`: no service call, ordinary restore.
- **E7.** The row's generation differs from the intent's: fail closed, with the in-lock fence result as well as the unlocked pre-check (a variant changes the generation while the step waits at the lock barrier).
- **E8.** The setting is turned off after the commit: the successor still reopens (6.5.7).
- **E9.** A same-run native resume and an external-provider run are not eligible (E0).

Guard invariants:

- **G1.** `runRetainsIssueIdentity` and `assertTaskWorkspaceExecutionAccess` have no diff in this change (checked in review). (Amended by #73.) The reopen service changes only by the optional `expectedClosedGeneration` input. Its existing checks, lock order and failure bookkeeping have no other diff.
- **G2.** A cross-task agent PATCH on T still gets 403 with no side effects.
- **G3 (added by #73).** The eager callers are unchanged: a board comment, a target-bound agent comment, a PATCH and a checkout on a closed T reopen exactly as before, and they do not pass the fence (V4, V5 and a spy on the service input).

## 11. Schema, API and docs to update in the implementation

- `packages/db`: three partial unique indexes in one migration: the agent comment `clientRequestId` index (4.1), and the intent and dispatch indexes on `agent_wakeup_requests` (4.2). No new columns.
- `packages/shared`: the comment create response adds optional `replayed?: boolean` and `continuation?: { wakeupRequestId, status, runId, coalescedIntoWakeupRequestId? }`. The validator documents that `clientRequestId` is required for cross-task continuation.
- `server/src/routes/issues.ts`: the R0 replay lookup, `classifyIssueExecutionWorkspaceBinding`, and the deferred branch in the comments route. `getClosedIssueExecutionWorkspace` becomes a wrapper; the PATCH and checkout routes are otherwise unchanged.
- `server/src/services/task-workspace-access.ts`: the `runBindsIssueForWorkspaceExecution` predicate only.
- `server/src/services/heartbeat/queue.ts`: `dispatchPendingNativeStatusWakeups` accepts the `cross-task-continuation-committer` producer. For that producer: the dispatch actor id and the separate dispatch idempotency key, the `existingDispatch` lookup by dispatch key, the claim fence on `claimedAt`, mapping a dispatch-index unique violation to `existingDispatch` recovery, the context `source`, and revalidation (6.4). The status-committer branch keeps its current key and behavior. No new consumer or sweep.
- (Added by #73.) `server/src/services/heartbeat.ts`: the `reopenTargetBoundSuccessorWorkspace` step in the run setup, with the eligibility checks of 6.5.2 and the result mapping of 6.5.4. It can live in its own module under `services/heartbeat/`. It does not change `prepareHeartbeatWorkspace`, `selectHeartbeatEnvironment`, `resolveExecutionWorkspaceReuseRequestForIssue` or the recovery sweep.
- (Added by #73.) `server/src/services/execution-workspaces.ts`: the optional `expectedClosedGeneration` input of `reopenClosedIsolatedExecutionWorkspaceForIssue`, checked under the lifecycle lock before the rebuild (6.5.3). No other change.
- (Added by #73.) `server/src/routes/issues.ts`: `classifyIssueExecutionWorkspaceBinding` carries `strategyType` and `providerType`, and the deferred path admits only a non-plugin `git_worktree` row (3.1).
- Docs: the C1 continuation section of the agent-facing API docs must say that cross-task resume needs `clientRequestId`, that the workspace reopens when the successor starts, and how to reconcile a lost response. Update the access and feature maps where the comment route is listed.

## 12. Rollout and rollback

- The migration only adds indexes. It is compatible with the running build, because no current code writes agent `clientRequestId` values, the `issue_cross_task_continuation:` key, or the `cross-task-continuation-dispatch:` key. A build without the consumer change ignores `cross-task-continuation-committer` rows, so the consumer change ships in the same release as the deferred branch.
- Before the indexes are created, check for duplicates (expected none) with a read-only query, one per index. If any exist, stop and report. Do not delete rows.
- The deferred branch ships behind an instance experimental setting, `enableCrossTaskDeferredContinuation`, default off, in the same release. With it off, behavior is exactly today's, including the 403.
- Ops enables it after deployment. Acceptance is a disposable fixture task pair in a test company: R1 to R3 and V3 are repeated in that company. A production business task is not used for acceptance.
- Rollback: turn the setting off. Requests already committed keep their intents, which the consumer still delivers, and R0 still replays them. The indexes can stay, because they are harmless with the setting off. (Amended by #73.) The successor step is not gated by the setting, so the successors of those intents still reopen their workspaces (6.5.7). The step and the service fence are inert when no intent exists. A code rollback that removes the step while intents are pending makes those successors fail with `inherited_workspace_reuse_unavailable` and go through the V3 path, so a code rollback should wait until no intent is `queued` or `claimed` and no dispatch receipt is deferred (a read-only query).
- Merging this plan, or the implementation, does not resume any blocked business task. Resuming the C1 case is separate delivery work: after deployment and acceptance, the CTO's run re-sends its scheduling-request comment with a `clientRequestId`, under the existing task gates.

## 13. Out of scope

- Changing `runRetainsIssueIdentity`, `assertTaskWorkspaceExecutionAccess` or any other execution guard.
- (Added by #73.) Reopening for runs that are not the dispatch of a committed intent, changing how ordinary preparation treats `archived` or `cleanup_failed` rows for those runs, reopening plugin or non-`git_worktree` workspaces on the deferred path, a new blocker kind, a new retry loop, or writing `workspaceRepairRequired`.
- A same-agent blanket workspace permission, a Board proxy, a scheduler, or a host fallback.
- The `parentId` default for scheduling requests created inside a run. The diagnosis explains it, and team rules handle it separately.
- Production resume, recovery resolve, workspace deletion, database edits, deployment or restart.
