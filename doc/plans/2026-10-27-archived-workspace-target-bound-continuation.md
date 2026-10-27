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

The cross-task request does not touch the workspace. In one database transaction it saves the comment, moves the target to `todo`, and writes a durable wakeup request bound to the target task. The successor run that the dispatcher starts for that request has the target as its `nativeIssueId`. During its normal workspace preparation (`services/heartbeat/workspace-preparation.ts`, `ensurePersistedExecutionWorkspaceAvailable` under `shouldRestoreExistingWorkspace`) it restores the archived workspace with its own identity. `assertTaskWorkspaceExecutionAccess` then passes, because the run really is bound to the target.

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

The change applies only to the "cross-task explicit continuation" case, defined in code as:

```
crossTaskContinuation =
  closedExecutionWorkspace != null
  && req.actor.type === "agent"
  && req.actor.runId != null
  && effectiveResumeRequested === true (or effectiveReopenRequested === true for agents)
  && !runRetainsIssueIdentity(actorRun, issue.id)
```

`actorRun` is read with `taskRepositoryRunColumns`, the same projection the guard uses. Every other caller keeps today's eager reopen:

- a board or user actor,
- an agent whose run is bound to the target,
- an agent without a run id. `agent_jwt` without a run id is still refused by the guard, so that path does not change.

A shared predicate `runBindsIssueForWorkspaceExecution(db, actor, companyId, issueId)` lives in `task-workspace-access.ts` next to the guard. It returns `true`, `false`, or throws for a missing or foreign run, using the same rules. The guard itself does not change. The predicate only lets the route choose the deferred path *before* calling the guard. Then the route never sends an unbound request into it, and it does not need a catch-and-retry on 403.

## 4. Request contract

### 4.1 Request id

A cross-task continuation must carry `clientRequestId` (a client-generated UUID, already in the comment body schema). Today it is honored only for user actors. If it is missing, the route returns `422 Cross-task continuation requires a clientRequestId for safe retries` before any write. It uses the same wording as the chat path at `routes/issues.ts:18294`.

The comment unique index `issue_comments_client_request_uq (issue_id, author_user_id, client_request_id)` does not cover agents, because `author_user_id` is NULL for them. Add a partial unique index:

```
issue_comments_agent_client_request_uq
  ON issue_comments (company_id, issue_id, author_agent_id, client_request_id)
  WHERE author_agent_id IS NOT NULL AND client_request_id IS NOT NULL
```

The route sets `clientRequestId` on the comment for this path only. Other agent comments keep sending `undefined`, so their behavior does not change.

### 4.2 Durable wakeup request

The successor is an `agent_wakeup_requests` row written inside the same transaction as the comment. It does not come from the post-response, fire-and-forget `heartbeat.wakeup(...)` loop at the end of the route. Fields:

- `agentId`: the target's `assigneeAgentId` as read under the lock (section 5).
- `reason`: `issue_reopened_via_comment`. It keeps the existing reason so the run-dispatch policy (`modules/run-dispatch/domain/policy.js` terminal-issue rule) treats it as a trusted resume.
- `payload`: `{ issueId: target, commentId, reopenedFrom, mutation: "comment", resumeIntent: true, followUpRequested: true, crossTaskContinuation: { sourceRunId, sourceIssueId, workspaceId, workspaceGeneration } }`.
- `idempotencyKey`: `issue_cross_task_continuation:<targetIssueId>:<commentId>`.

Add a partial unique index, the same pattern as the existing `task-retry:%` and `issue_review_path_lost:%` indexes:

```
agent_wakeup_requests_cross_task_continuation_idempotency_uq
  ON agent_wakeup_requests (company_id, idempotency_key)
  WHERE idempotency_key LIKE 'issue_cross_task_continuation:%'
```

The dispatcher must create the successor run with `nativeIssueId = target`. `crossTaskContinuation` is an audit and fixture field only. The successor's authority comes from its own target binding, not from this payload, and no code path may read it as authorization.

## 5. Ordering, locks and atomicity

The deferred path runs in one transaction. The order is:

| Step | Action | On failure |
|---|---|---|
| D0 | All existing pre-reopen gates, in their current order: comment access, `assertAgentIssueMutationAllowed`, `assertExplicitResumeIntentAllowed` (pause hold, cancelled, blockers, assignee/override/mutate), unresolved-blocker check, `assertCrossIssueInfluenceWithinRunCap`. No change. | Today's refusal response. No writes. |
| D1 | `runBindsIssueForWorkspaceExecution` returns false and `clientRequestId` is present. | 422 if `clientRequestId` is missing. No writes. |
| D2 | `BEGIN`. `SELECT ... FOR UPDATE` on the target issue row. | Rollback. |
| D3 | Replay check: look up the comment by `(company, issue, author_agent_id, client_request_id)`. If it exists, go to section 6.2. | — |
| D4 | Re-check every gate from D0 against the locked row and current tables: status still resume-capable, no active pause hold, no unresolved blockers, assignee unchanged from D0, the source run still `running` and still owned by the actor agent, responsible user unchanged, `executionRunId` null or terminal, no active `checkoutRunId` from another run. The cross-issue cap counts this request once. | Rollback. 409 with the same refusal text as D0. No comment, no wakeup, no workspace change. |
| D5 | Lock the execution workspace row (`withExecutionWorkspaceLifecycleLock` order: issue then workspace, same as the reopen helper). Confirm it is still `isolated_workspace`, still bound to the issue, and record its lifecycle generation. It must be closed (`archived` or `cleanup_failed`) or already active. Do not change it. | `not_reopenable` → rollback, today's 409 text. |
| D6 | Insert the comment (`svc.addComment(..., tx)`) with `clientRequestId`, `runId = source run`, `sourceTrust` from `sourceTrustForActorWrite`. | Rollback. |
| D7 | `svc.update(target, { status: "todo" }, tx)` and the `issue.updated` activity row (existing details, plus `crossTaskContinuation: true`). | Rollback. |
| D8 | Insert the wakeup request (section 4.2). | Unique conflict cannot happen on first insert, because D3 holds the issue lock. Any error → rollback. |
| D9 | `COMMIT`. After commit: publish activity and live events, and notify the dispatcher. The existing post-commit publication lists are reused. | A notify failure does not lose the wakeup, because the dispatcher's request sweep picks up a pending durable row. |

Properties:

- **Refusal atomicity.** Every refusal before D9 leaves no comment, no status change, no wakeup and no workspace change. The deferred path never sets the reopen-pending flag and never rebuilds anything. So `guardReopenedWorkspaceConsumption` is not installed, and an archived workspace cannot leak.
- **No partial success.** The comment, the status change and the wakeup commit together. Today the status update, the comment insert and the wakeup are three separate effects.
- **Lock order.** Issue row, then workspace row. This is the order the reopen helper and the terminal reaper already use. No new lock is held across I/O.
- **Execution policy fields.** `executionPolicy`, `executionState` (stage, participants, `lastDecisionOutcome`, `changesRequestedCount`, `returnAssignee`, decisions), `assigneeAgentId`, `responsibleUserId` and review limits are not written. The deferred path only changes `status` to `todo`, the same as today's resume. A null review limit still means the default of three.

## 6. Idempotency and lost responses

### 6.1 Duplicate concurrent requests

Two requests with the same `clientRequestId` serialize on the issue lock at D2. The second one finds the comment at D3 and replays (6.2). The partial unique indexes (4.1, 4.2) are the backstop if the lock is ever bypassed. A unique violation maps to replay, never to a second row.

Two requests with *different* `clientRequestId`s for the same closed target: the first moves the target to `todo` and commits. The second re-checks at D4 and sees `todo`, which is not closed. It falls out of the deferred path and is handled as an ordinary comment on an open issue: it saves the comment and wakes the assignee through the normal coalescing rules. It must not create a second successor. The implementation has to show (fixture I3) that the open-issue wake coalesces into the pending wakeup request for the same agent and issue. If the current coalescing does not do that, the deferred branch also handles this second request: it saves the comment and writes no new wakeup while a pending `issue_cross_task_continuation:` request exists for the target.

### 6.2 Replay

When D3 finds the comment, the route returns `201` with the original comment and the original wakeup request id, and does nothing else. It does not re-check gates, because the original admission already committed. It does not write activity. The replay response body is the same shape as the first response, plus `replayed: true`.

### 6.3 Lost response

If the client loses the response, it retries with the same `clientRequestId`. If the first request committed, the retry replays (6.2). If it did not commit, the retry is a fresh request and goes through all gates again. The client can also reconcile without retrying: `GET /issues/:id/comments` filtered by its agent and the `clientRequestId`, plus the issue's wakeup request for the idempotency key. The plan does not add a new read endpoint. The existing comments read already returns `clientRequestId`.

### 6.4 Delivery-time revalidation

The successor run must not trust the admission. When the dispatcher claims the wakeup request, the existing run-dispatch policy re-checks pause holds, dependency readiness, assignee, and the terminal-issue rule. Two additions:

- If the target is no longer `todo`, `in_progress` or `blocked` with resolved blockers, or if the assignee changed, the request is marked `skipped` with reason `cross_task_continuation_gate_changed`. The comment stays, and nothing else changes.
- The successor's workspace preparation restores the archived workspace through `ensurePersistedExecutionWorkspaceAvailable` under its own identity. If the rebuild fails, the run fails through the existing workspace-preparation failure path. The issue then gets the existing execution blocker with `workspaceRepairRequired`, and the source task is not touched. This is the same outcome a target-bound resume gets today when the rebuild fails.

Implementation must confirm with a fixture that the target-bound successor reaches `shouldRestoreExistingWorkspace` for an archived `git_worktree` workspace. That means `reuse_existing` with the archived workspace id as `requestedExecutionWorkspaceId`, as `services/heartbeat/workspaces.ts` computes it. If the target's recorded preference does not lead there, the successor would realize a fresh workspace. In that case the implementation stops and reports back. It must not quietly switch strategy, because a fresh workspace would lose the archived branch state.

## 7. Workspace cases

| Target workspace at D5 | Cross-task request result | Successor run |
|---|---|---|
| `archived` or `cleanup_failed`, isolated, bound | Deferred path. Comment, `todo` and wakeup commit. Workspace untouched. | Restores the workspace under its own identity. |
| `active` (already reopened, or never closed) | No reopen is needed, so today's route does not call the helper (`closedExecutionWorkspace` is null). No change. | Uses the active workspace. |
| Missing row, or no longer bound to the issue | 409 `This issue is linked to a closed workspace that cannot be reopened.` No writes. | None. |
| Plugin provider retired (`workspaceProviderRetired`) | 409, same text. No writes. | None. |
| Rebuild fails | Not known at request time. | Section 6.4: the run fails, the issue gets `workspaceRepairRequired`, the source task is untouched. |
| Shared (non-isolated) workspace | Not a closed isolated workspace. Today's path, no change. | Normal. |

The cross-task request never returns `rebuild_failed`, because it never rebuilds.

## 8. Refusals with no side effects

Each of these must leave no comment, no status change, no wakeup request and no workspace change. Each is a fixture in section 10.

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
| Workspace not reopenable | 409, today's text |
| Source run not `running` or not owned by the actor | 403 `Task workspace run identity is unavailable` (the guard text, from the predicate) |

## 9. PATCH and checkout routes

The PATCH route (status change on a closed issue) and the checkout route call the same reopen helper.

- **Checkout** is execution. A checkout by a run bound to another task is already refused by checkout ownership. This plan does not change checkout. A cross-task actor must use the comment path.
- **PATCH** with a status change on a closed target from a cross-task agent run hits the same 403. This plan does not add a deferred PATCH path. Resume must be requested by comment with `resume: true`, which is the documented entry. The PATCH route keeps its 403 unchanged, and its fixture asserts no side effects.

The cross-task agent therefore has one entry point. That keeps the idempotency and audit contract in one place.

## 10. Test matrix

All tests run against real PostgreSQL through the existing route integration harness. Workspace tests use a real archived `git_worktree` fixture.

Regression (the diagnosed case):

- **R1.** Agent X is the assignee of a closed target T, whose isolated workspace is archived. X has a running run bound to source task S. X posts a comment with `resume: true` and a `clientRequestId`. The request returns 201. The comment, `todo` and the wakeup request commit in one transaction. T's workspace row is unchanged and stays `archived`, with no reopen-pending flag. `executionState` is byte-identical before and after. `assertTaskWorkspaceExecutionAccess` is never called with the source run for T (asserted with a spy).
- **R2.** The dispatcher claims the wakeup request and creates a run with `nativeIssueId = T`. Workspace preparation restores the archived workspace under that run. `assertTaskWorkspaceExecutionAccess` passes with the successor run. T's workspace is `active`, on the original branch.
- **R3.** R1 with the deployed shape: same assignee, source run with `contextSnapshot.issueId = S`, `nativeIssueId = null`, `executionIdentityRunId` = the source run.

Refusals (each asserts zero new comments, zero wakeup requests, unchanged issue row, unchanged workspace row): one test per row of section 8.

Idempotency:

- **I1.** The same request is sent twice in sequence. The second gets `replayed: true`, with the same comment id and the same wakeup request id. Row counts do not change.
- **I2.** The same request is sent twice concurrently (two connections, barrier before D2). Exactly one comment and one wakeup request. One response is the original and the other is the replay.
- **I3.** Two different `clientRequestId`s concurrently. One deferred admission, one ordinary open-issue comment, exactly one successor run.
- **I4.** Lost response: commit, drop the response, retry. The retry replays.
- **I5.** A fault injected after D6 (comment insert) and before D9. Nothing persists, and a retry succeeds as a fresh request.

Delivery:

- **V1.** A pause hold is added between commit and dispatch. The request is `skipped` with reason `cross_task_continuation_gate_changed`, and no run starts.
- **V2.** The assignee changes between commit and dispatch. The request is skipped.
- **V3.** The rebuild fails in the successor run. The run fails, T gets `workspaceRepairRequired`, and S is untouched.
- **V4.** The target-bound path is unchanged: an agent run bound to T posts `resume: true` and still reopens eagerly, as today.
- **V5.** Board and user actors are unchanged: they still reopen eagerly.

Guard invariants:

- **G1.** `runRetainsIssueIdentity` and `assertTaskWorkspaceExecutionAccess` have no diff in this change (checked in review).
- **G2.** A cross-task agent PATCH on T still gets 403 with no side effects.

## 11. Schema, API and docs to update in the implementation

- `packages/db`: two partial unique indexes (4.1, 4.2), in one migration. No new columns.
- `packages/shared`: the comment create response adds an optional `replayed?: boolean` and `continuationWakeupRequestId?: string`. The validator documents that `clientRequestId` is required for cross-task continuation.
- `server/src/routes/issues.ts`: the deferred branch in the comments route. Other routes are unchanged.
- `server/src/services/task-workspace-access.ts`: the `runBindsIssueForWorkspaceExecution` predicate only.
- Run-dispatch: delivery revalidation and the skip reason (6.4).
- Docs: the C1 continuation section of the agent-facing API docs must say that cross-task resume needs `clientRequestId`, that the workspace reopens when the successor starts, and how to reconcile a lost response. Update the access and feature maps where the comment route is listed.

## 12. Rollout and rollback

- The migration only adds indexes. It is compatible with the running build, because no current code writes agent `clientRequestId` values or the `issue_cross_task_continuation:` key.
- Before the indexes are created, check for duplicates (expected none) with a read-only query. If any exist, stop and report. Do not delete rows.
- The deferred branch ships behind an instance experimental setting, `enableCrossTaskDeferredContinuation`, default off, in the same release. With it off, behavior is exactly today's, including the 403.
- Ops enables it after deployment. Acceptance is a disposable fixture task pair in a test company: R1 to R3 and V3 are repeated in that company. A production business task is not used for acceptance.
- Rollback: turn the setting off. Requests already committed keep their wakeup rows, which the dispatcher still delivers normally. The indexes can stay, because they are harmless with the setting off.
- Merging this plan, or the implementation, does not resume any blocked business task. Resuming the C1 case is separate delivery work: after deployment and acceptance, the CTO's run re-sends its scheduling-request comment with a `clientRequestId`, under the existing task gates.

## 13. Out of scope

- Changing `runRetainsIssueIdentity`, `assertTaskWorkspaceExecutionAccess` or any other execution guard.
- A same-agent blanket workspace permission, a Board proxy, a scheduler, or a host fallback.
- The `parentId` default for scheduling requests created inside a run. The diagnosis explains it, and team rules handle it separately.
- Production resume, recovery resolve, workspace deletion, database edits, deployment or restart.
