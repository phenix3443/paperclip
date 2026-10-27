# C1 terminal parent resume 403: diagnosis and continuation plan

Status: diagnosis and plan for phenix3443/paperclip#75. No runtime code changes. The only code in this PR is a characterization test.

Evidence used:

- Paperclip ops diagnosis and its independent acceptance (read only, not repeated). Runtime IDs stay in those records.
- The deployed install metadata and service unit on the host (read only).
- `develop` source at `ef2f4565b`, and the isolated test `server/src/__tests__/terminal-parent-resume-403-characterization.test.ts` added by this PR.

The production request was not replayed.

## 1. Incident facts

These come from the native audit, the service journal and current task state.

| Fact | Value |
|---|---|
| Request | `POST /api/issues/{parent}/comments`, body starts with `调度请求:`, `resume: true` |
| Response | HTTP 403 at 2026-10-27T17:12:19Z. The body was not kept, and the journal line has no reason. |
| Actor | The CTO agent, in a Routine run bound to the capacity task, not to the parent |
| Cap audit | `issue.cross_issue_influence_observed`, 17:12:18.929Z, kind `comment`, count 1 of 20, `allowed: true`, mode `enforce` |
| Parent state | `done`, assigned to the same CTO agent, `executionRunId` and `checkoutRunId` null, no execution blocker |
| Parent workspace | `executionWorkspaceId` set. The row is `isolated_workspace` with status `archived`, closed at 10:36:16Z. |
| Effects | No comment, no status change, no queued or running successor |

## 2. Deployed version and source mapping

- Install metadata: `source: git`, `repo: phenix3443/paperclip`, `sha: fdbafff72d8fd6ae7f12eb5827631efc67d208f3`, installed 2026-10-27T15:51:33Z.
- The service started at 15:52:06Z, before the 403 at 17:12:19Z, so the request ran on `fdbafff72`.
- `git diff fdbafff72 ef2f4565b` is empty for the four files on this path: `server/src/routes/issues.ts`, `server/src/services/execution-workspaces.ts`, `server/src/services/task-workspace-access.ts` and `server/src/services/task-repository-acquisition.ts`. The fixture on `develop` therefore runs the deployed logic.
- The deployed `dist/services/task-workspace-access.js` contains the guard message `Task workspace run identity is unavailable`.
- The fix from #64 (draft PR #69, plan amendment PR #74) is not in `fdbafff72`.

## 3. Which branch refused the request

### 3.1 Gate order in the comment route

The comment route on `fdbafff72` runs these checks in order:

1. Comment access, `assertAgentIssueCommentAllowed`.
2. Board pause check (board actors only).
3. Closed issue mutation check for a non-assignee agent.
4. `assertExplicitResumeIntentAllowed`: resumable status, pause hold, blockers, and assignee or override.
5. Unresolved blocker check.
6. `assertCrossIssueInfluenceWithinRunCap`, which commits the cap audit row.
7. If the issue is bound to a closed isolated workspace, `reopenClosedIssueExecutionWorkspaceOrRespond`.
8. The comment insert, the move to `todo`, and the wake.

Steps 1 to 5 answer with their own error before step 6 runs, and step 6 commits the audit row in its own transaction. The production audit row has `allowed: true`, so the request passed steps 1 to 6. The comment was not written, so the refusal happened at step 7 or between steps 7 and 8.

### 3.2 Inside step 7

`reopenClosedIsolatedExecutionWorkspaceForIssue` calls `assertTaskWorkspaceExecutionAccess(db, req.actor, …)` before any rebuild. That guard loads `req.actor.runId` and throws `forbidden("Task workspace run identity is unavailable")` unless `runRetainsIssueIdentity(run, parent)` holds. A run retains an issue only through `nativeIssueId`, `contextSnapshot.issueId/taskId` or `issueId`.

The Routine run was bound to the capacity task. The cap counted the request as cross-issue, which shows the run's source issue was not the parent. The run identity check is the first check in that guard that depends on the run, so it fails before the later checks (responsible user, `issue:read`, copy identity, trust) can run. The helper itself answers 409 for the failures it handles (`not_reopenable`, rebuild failed). A 403 here can only come from a thrown `forbidden`.

### 3.3 Isolated reproduction

The characterization test drives the real route, gates and guard against embedded PostgreSQL with synthetic rows. Case M1 sets up the production shape: same agent, a source run bound to another task, a done parent, and an archived isolated `git_worktree` workspace. It returns:

```
403 {"error":"Task workspace run identity is unavailable"}
```

M1 also leaves exactly one `allowed: true` cap audit row and no other effect. That is the production signature.

Case M2 is the same request without a workspace binding. It returns 201, writes the comment, moves the parent to `todo` and queues a successor run bound to the parent. The closed workspace is the only difference between M1 and M2.

### 3.4 Conclusion and remaining uncertainty

- Root cause: an implementation defect in ordering. It is not a configuration mismatch and not an intended restriction on this request. Control-plane admission (this agent may ask for the parent to continue) is coupled to an eager filesystem reopen that only a run bound to the parent may perform. The guard is correct. The eager reopen inside a cross-task request is wrong. This is the same defect as #64, seen a second time.
- Missing evidence: the production response body was not captured. The branch is derived from persisted facts (audit row, workspace row, run binding) and reproduced under those conditions. It was not read from the original response. No other 403 branch fits those facts. To confirm directly, keep the response body the next time this happens. Do not replay the request just to see it.

## 4. Test matrix

All cases are in the characterization test and pass on `develop` `ef2f4565b`.

| Case | Setup | Current result | Cap audit | Effects |
|---|---|---|---|---|
| M1 | Same agent, source-bound run, done parent, archived workspace | 403 `Task workspace run identity is unavailable` | 1, allowed | none |
| M2 | As M1, no workspace binding | 201 | 1, allowed | comment, `todo`, queued successor bound to the parent |
| M3 | Run bound to the parent, archived workspace | 409 `Failed to rebuild the execution workspace` (the guard passes; the fixture has no repository) | 0 (same issue) | none, row stays archived |
| M4a | Parent assigned to another agent, archived workspace | 403 `Task workspace run identity is unavailable` | 1, allowed | none |
| M4b | Parent assigned to another agent, no workspace | 201 via `allow_visible_issue_write` (default open write policy) | 1, allowed | comment, `todo` |
| M5 | Actor company differs from the issue company | 404 `Issue not found` | 0 | none |
| M6 | Agent actor without a run | 403 `Cross-issue writes need a run to attribute them to…` | 0 | none |
| M7 | Active subtree pause hold on the parent | 409 `Issue follow-up blocked by active subtree pause hold` | 0 | none |
| M8 | `in_progress` parent with a live run, no closed workspace | 201 | 1 | comment |
| M9 | `in_review` parent | 409 `Issue is not resumable through comment follow-up intent` | 0 | status and execution state unchanged |

What the matrix shows:

- M4a and M4b: another agent's ownership is not denied by the guard. Today the guard refuses every cross-task resume on an archived workspace, including ones the access policy would admit. The access policy is the real ownership boundary (M4b). A fix must defer to that same decision and must not widen it. The protected write policy case (403 `Agent cannot request follow-up for another agent's issue`) is not in this fixture. #69 covers the non-assignee requester, and the implementation review should confirm the protected policy case there.
- M5, M6, M7 and M9 stay denied before the cap gate and before any workspace work. A fix must keep them denied with no effects.
- M3: a run bound to the parent passes the guard. The guard itself does not need to change.

## 5. Minimal fix

No new runtime design. The approved plan for #64 (merged in #66), with the amendment in #74, is the minimal fix for this incident:

- The cross-task request does not touch the workspace. In one transaction it saves the comment, moves the parent to `todo` and records a durable continuation intent bound to the parent.
- The successor run, bound to the parent, reopens the archived workspace under its own identity (#74, section 6.5). `assertTaskWorkspaceExecutionAccess` and `runRetainsIssueIdentity` stay unchanged.
- The path is behind the experimental setting `enableCrossTaskDeferredContinuation`, off by default. With the setting off, behavior is exactly today's (M1).

Draft #69 implements it. This plan adds these review conditions for #69:

1. M1 becomes 201 with exactly one comment and one intent only when the setting is on. With the setting off it stays M1.
2. M4a with the setting on admits exactly when M4b admits, through the same access decision. A protected write policy that denies M4b also denies M4a.
3. M5, M6, M7 and M9 keep their current status, body and absence of effects with the setting on.
4. The PATCH and checkout reopen paths keep their 403 for cross-task agents (#64 section 9, #69 case G2).

Options not chosen:

- Relaxing `runRetainsIssueIdentity` for the assignee lets a run bound to task A write task B's workspace. This is the boundary the guard protects.
- Adding comment or resume to the operator allowlist adds a privileged path for a defect that has a native fix, and it still needs a successor run.

## 6. Comment, successor and lost responses

A 201 proves the comment row. It does not prove a successor. In M2 the wake is enqueued after the response, and the test reads the run table separately to find the queued run bound to the parent. Callers must treat "comment written" and "successor queued or running" as two facts:

- Comment: `GET /api/issues/{parent}/comments`, matched on author agent, `createdByRunId` and the request marker line.
- Successor: the parent's `executionRunId`, or a queued or running run whose context issue is the parent. On #69, also the intent row named in the response.

Lost response handling:

- Today, on an archived workspace: a 403 commits only the cap audit row. A retry gets the same 403 and spends one more cap unit (cap 20 per run). It cannot duplicate a comment. Callers must not retry it. They read back once and record the block.
- Today, on a target without a closed workspace: agent comments have no request idempotency key. The route passes `clientRequestId` to the comment service only for user actors (`routes/issues.ts` comment insert). A retry after a lost 201 can write a second comment and a second wake request. Before retrying, read back comments by author, run and marker. Retry only if the comment is absent.
- After #69 with the setting on: the deferred path requires `clientRequestId`. A sequential retry with the same id and body replays (`replayed: true`, same comment and intent). The same id with a different body gets 409. Concurrent identical requests commit one comment and one intent (#69 cases I1, I2, I9, I10). Routines that send cross-task resumes must send a stable `clientRequestId` derived from the request task and parent.

## 7. Interim continuation without code changes

These steps need no new authority. CTO decides which to use.

- Handle the scheduling request on its own open task. It already exists as a `todo` task. Assigning it and working there does not reopen the parent's archived workspace, and it keeps the parent's history unchanged.
- Do not retry the cross-task resume comment on `fdbafff72`. It will give the same 403 (M1).
- The operator allowlist (`withdraw_interaction`, `restore_execution_recovery`, `enable_isolated_workspaces`) has no matching action, and none should be added for this.

This plan does not restore the original request or the source delivery.

## 8. Rollout, rollback and verification for the fix

Preconditions:

- #74 is approved and merged.
- #69 is independently reviewed at an exact SHA against #64 as amended plus section 5 of this plan.
- CI is green, including this characterization test. Its M1 and M4a expectations hold with the setting off.

Rollout:

1. Ops installs the exact merged `develop` SHA with the pinned git install and restarts the service. Record `install.json` `sha` and the service start time.
2. CTO enables `enableCrossTaskDeferredContinuation`.
3. Verify on the next real occurrence, or on one CTO-authorized synthetic request in a test company. Do not verify on the original parent. Record: a 201 with `continuation.wakeupRequestId`, one comment, the parent in `todo`, a successor run bound to the parent that reopens the workspace, and no change to unrelated tasks.

Rollback:

- First, turn the setting off. Cross-task resume on an archived workspace goes back to M1 (fail closed). Intents already committed are still served by the consumer.
- If needed, reinstall the previous pinned SHA from `install.json` `previous`. Intents committed by the newer build stay in the database. The older build does not consume them. Ops lists them for CTO, and they are not replayed automatically.

What is not claimed:

- The original 403 is not recovered and the source delivery is not resumed.
- No deployment, restart, permission change, lock or stage or count reset, or production task change was made.

## 9. Verification commands

```sh
pnpm --filter @paperclipai/plugin-sdk build   # once per fresh worktree
cd server && pnpm exec vitest run src/__tests__/terminal-parent-resume-403-characterization.test.ts
```

Result on `ef2f4565b` plus this test: 10 passed. Teardown can log `CONNECTION_ENDED` from background wake work after the database stops. This does not affect the assertions.
