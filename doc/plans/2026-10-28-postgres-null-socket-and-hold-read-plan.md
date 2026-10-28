# PostgreSQL null-socket crash and read-only hold verification

Date: 2026-10-28. Scope: offline investigation and a proposal for later approval.
Requirement: [fork issue #106](https://github.com/phenix3443/paperclip/issues/106).
This document authorizes no implementation, deployment, restart, permission change,
hold release, production fault injection, or business replay.

## Findings and evidence limits

The incident report supplied to #106 records an uncaught `TypeError` at
`Immediate.nextWrite`, `postgres/src/connection.js:255:22`, on Node v24.22.1.
The expression was `socket.write(chunk, fn)`. The controller exited with code 1.
The report identifies Paperclip commit
`fdbafff72d8fd6ae7f12eb5827631efc67d208f3` and postgres 3.4.9.
This investigation read the report; it did not repeat host recovery or query the
production tasks. Production run IDs and business outcomes stay in that report.

A disposable TCP fixture reproduces that exception on the published, unpatched
3.4.9 package, including on Node v24.22.1. It closes a reserved connection, waits
for the close callback, then submits another query. The query buffers a frame and
schedules a new Immediate while the socket is null. This is a verified path to
the exit point. It does **not** establish which path closed the production socket,
or prove that an Immediate scheduled before close escaped cancellation.

The same fixture with the repository's existing patch rejects the late query
with `CONNECTION_CLOSED` and exits normally. Live-connection negative controls
pass for both package variants. No new driver fix was created or applied to a
runtime installation.

There is a material unresolved discrepancy: the incident commit already contains
`patches/postgres@3.4.9.patch`. Its SHA-256 is
`ff4264722dcd40c9da222d7eae410139aee10aa549b1cf4685eeeaf7c21d7d18`,
identical to the patch at the investigation base. The incident commit also registers
that patch in `pnpm-workspace.yaml`. The report's package version
and unguarded `nextWrite` line cannot establish whether that patch was loaded:
the current patch intentionally leaves `nextWrite` unguarded. Both an installation
mismatch and a path outside its scope remain possible. Do not conclude that a
reinstall fixes the incident, or that the patch is absent, from this probe.

## Source and package baseline

All repository path references below refer to investigation base
`73e13844502b00fbc9fc91503021b65227873be8` unless otherwise stated.
The PR records the final document HEAD separately; a document cannot contain its
own Git commit hash.

| Item | Evidence read on 2026-10-28 |
| --- | --- |
| Dependency contract | `packages/db/package.json`: `postgres: ^3.4.9`; lock resolves 3.4.9 with patch hash `sryle6qd5qfmnxvoebal4gashi` |
| Published package | npm `postgres@3.4.9`; tarball SHA-256 `4964056ae6b672361557f738532a20ad29d54cff0b146cb66d67d7155d66761e`; npm SHA-1 `8e9a49cecb1b0e7d67a607f32a53ed54b3055271` |
| Local probe runtime | Linux, Node v26.12.1; separate npm-provided Node v24.22.1 for the incident-version comparison |
| Driver upstream | [`411429e7bd7a3d61155ca9a70a97c111823702ea`](https://github.com/porsager/postgres/commit/411429e7bd7a3d61155ca9a70a97c111823702ea); `src/connection.js` still calls `socket.write` without a null guard |
| Latest published GitHub release | [v3.4.9](https://github.com/porsager/postgres/releases/tag/v3.4.9), published 2026-04-05; no newer release returned by `releases/latest` |

Primary upstream evidence:

- [Driver connection source](https://github.com/porsager/postgres/blob/411429e7bd7a3d61155ca9a70a97c111823702ea/src/connection.js):
  `write` schedules `nextWrite`; `closed` cancels the recorded Immediate, removes
  socket listeners, nulls the socket, and notifies the pool. `terminate` also
  cancels its timer. Cancelling one timer does not prevent a later query from
  scheduling another timer. See the [Node timers contract](https://nodejs.org/api/timers.html#scheduling-timers).
- [Driver PR #1209](https://github.com/porsager/postgres/pull/1209), OPEN at head
  `a2588b3073b5bd125f0fb3b419bdc9f2e8524291`: proposes a null-write guard with
  query error settlement. Its author reports that simply returning false leaves
  a query hanging. This is author evidence, not a locally verified complete fix.
- [Driver PR #1215](https://github.com/porsager/postgres/pull/1215), OPEN at head
  `18cffe016927e01481b9e746587da789f4260a4c`: rejects queued and late transaction
  work after disconnect and protects replacement transactions. Its tests and
  reported multi-runtime results are upstream evidence, not tests run here.
- [Driver issue #1248](https://github.com/porsager/postgres/issues/1248) describes
  late transaction callbacks, automatic rollback on dead connections, and stale
  error state on reconnect. These are relevant hypotheses and regression cases;
  the report does not identify the production trigger in #106.
- Paperclip previously added a teardown patch in
  [PR #12227](https://github.com/paperclipai/paperclip/pull/12227), commit
  `6c7c0fd1f2426294887cbbe0f7fe703520bdcc0b`, then reverted it in
  [PR #12234](https://github.com/paperclipai/paperclip/pull/12234), commit
  `8ef39febd7132de5efb5d61549bd7d2c4b12a1b2`. The recorded reason was maintenance
  cost for a CI flake. Its broad null-socket guard is not the present patch.
- Paperclip later merged [PR #13643](https://github.com/paperclipai/paperclip/pull/13643),
  repository commit `685d4faba3715197fef85e7634f415b589f67812`. It supplies the
  current ESM/CommonJS patch and 12 real-PostgreSQL recovery cases in
  `packages/db/src/postgres-connection-recovery.test.ts`. The patch resets closed
  connection buffers/results and rejects late/queued reserved and transaction
  work. Those integration cases were inspected, not run in this investigation.

GitHub reads used host `gh`, including `gh pr view`, `gh api .../contents/...`,
release metadata and bounded commit/issue listings. Search results are not proof
that no other upstream work exists. No upstream PR was created for this plan.

## Disposable reproduction

The fixture uses loopback TCP and fake PostgreSQL startup/query replies. It has
no database URL, persistent database, production access, SQL writes, or external
business effect. `finally` closes the client and listener on normal paths; each
process has an outer timeout, which also bounds an uncaught crash or hang.
The small fake server tests driver lifecycle only; it cannot prove SQL atomicity,
real authentication, TLS, RST handling, or transaction isolation.

Save the following block as `$TMPDIR/probe.mjs`. It derives from the historical
#12227 fake-wire test, reduced to a standalone child process without Vitest.

```js
import net from 'node:net';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const postgres = (await import(pathToFileURL(process.argv[2]))).default;
const closeFirst = process.argv[3] !== 'live';
const sockets = new Set();
const auth = Buffer.from('5200000008000000005a0000000549', 'hex');
const reply = Buffer.from('3100000004320000000454000000060000430000000d53454c4543542030005a0000000549', 'hex');
const server = net.createServer(s => {
  sockets.add(s);
  let greeted = false;
  s.on('data', () => { s.write(greeted ? reply : auth); greeted = true; });
  s.on('error', () => {});
  s.on('close', () => sockets.delete(s));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let notifyClose;
const closed = new Promise(r => { notifyClose = r; });
const sql = postgres({ host: '127.0.0.1', port: server.address().port,
  user: 'probe', database: 'probe', max: 1, connect_timeout: 2,
  idle_timeout: 0, onclose: notifyClose });
try {
  const reserved = await sql.reserve();
  if (closeFirst) {
    for (const s of sockets) s.destroy();
    await closed;
  }
  const result = await reserved.unsafe('select 1').then(
    () => 'OK', e => e.code);
  console.log(result);
  assert.equal(result, closeFirst ? 'CONNECTION_CLOSED' : 'OK');
  await new Promise(r => setImmediate(() => setImmediate(r)));
  reserved.release();
} finally {
  await sql.end({ timeout: 1 });
  for (const s of sockets) s.destroy();
  await new Promise(r => server.close(r));
}
```

Fixture SHA-256 (the exact block, with a trailing newline):
`95954494ea5d673cf945fdc77e97ff1fb0ac965de7582b603ceeaf2fe91ac48c`.
Run from the reviewed repository checkout; use a fresh directory under `$TMPDIR`.
Patch only the extracted disposable copy, never the deployed package.

```sh
probe_dir=$(mktemp -d "$TMPDIR/postgres-probe.XXXXXX")
mkdir -p "$probe_dir/plain" "$probe_dir/current"
timeout 45 npm pack postgres@3.4.9 --pack-destination "$probe_dir" --json
tar -xzf "$probe_dir/postgres-3.4.9.tgz" -C "$probe_dir/plain"
tar -xzf "$probe_dir/postgres-3.4.9.tgz" -C "$probe_dir/current"
patch -s -d "$probe_dir/current/package" -p1 < patches/postgres@3.4.9.patch
# Execute each command separately; preserve the expected nonzero exit of plain/closed.
timeout 8 node "$TMPDIR/probe.mjs" "$probe_dir/plain/package/src/index.js" closed
timeout 8 node "$TMPDIR/probe.mjs" "$probe_dir/current/package/src/index.js" closed
timeout 8 node "$TMPDIR/probe.mjs" "$probe_dir/plain/package/src/index.js" live
timeout 8 node "$TMPDIR/probe.mjs" "$probe_dir/current/package/src/index.js" live
# Repeat closed cases with /cjs/src/index.js for CommonJS.
# Incident runtime comparison (npm caches Node outside the repository):
timeout 60 npm exec --yes --package=node@24.22.1 -- node --version
timeout 30 npm exec --yes --package=node@24.22.1 -- node "$TMPDIR/probe.mjs" "$probe_dir/plain/package/src/index.js" closed
timeout 30 npm exec --yes --package=node@24.22.1 -- node "$TMPDIR/probe.mjs" "$probe_dir/current/package/src/index.js" closed
# Repeat the two Node 24 commands with live instead of closed.
# After preserving results, remove only this disposable directory:
rm -rf -- "$probe_dir"
```

Observed results (one run per cell; no frequency claim):

| Node / format | Plain, closed then late query | Current patch, closed then late query | Live controls, plain / current |
| --- | --- | --- | --- |
| 26.12.1 / ESM | exit 1, null `write`, `Immediate.nextWrite` at 255:22 | exit 0, `CONNECTION_CLOSED` | exit 0 / 0, `OK` / `OK` |
| 26.12.1 / CommonJS | exit 1, same signature at 255:22 | exit 0, `CONNECTION_CLOSED` | not run |
| 24.22.1 / ESM | exit 1, same signature at 255:22 | exit 0, `CONNECTION_CLOSED` | exit 0 / 0, `OK` / `OK` |

npm printed an unrelated warning about the repository's `auto-install-peers`
configuration. No probe timed out. No full controller crash was induced.

## Ranked hypotheses and next evidence

1. **An unpatched package was loaded despite the source patch.** Prediction:
   the resolved ESM/CommonJS file hashes or patch hunks differ from a clean,
   lockfile-frozen build of the incident SHA. This remains unverified. A version
   string and the unchanged line 255 cannot distinguish the variants.
2. **A different lifecycle path bypasses the existing closed-scope checks.**
   Prediction: the exact installed files reproduce under an isolated close/error,
   queued write, listener, dedicated client, or shutdown interleaving even though
   the late-reservation probe passes. The present experiment does not cover it.
3. **Cluster stop or transport loss initiated the close.** Prediction: bounded
   incident-window lifecycle/transport evidence precedes the exception. The
   existing incident report does not establish that sequence. A normal network
   failure must still be a catchable connection error, not a controller crash.

A later authorized operator should first record the actual resolved driver file
paths and hashes from the controller's runtime/package layout, the lockfile and
patch hash used to build it, and whether ESM or CommonJS was loaded. Do not log
connection URLs, credentials, SQL parameters, or production run payloads. Compare
against an isolated frozen build at the exact incident SHA. Do not reinstall or
restart merely to collect this evidence. If exact files cannot be recovered,
retain the installation hypothesis as unknown.

## Relationship to graceful stop

[Fork PR #28](https://github.com/phenix3443/paperclip/pull/28), merge
`63dfd8b4915d8c67e56464ff5bf0f417aaca41e5`, bounds work drain and teardown,
removes inherited `NOTIFY_SOCKET`, suppresses embedded PostgreSQL restart during
shutdown, and uses `KillMode=mixed`. Its isolated systemd evidence supports those
specific lifecycle guarantees. [ai-team issue #407](https://github.com/phenix3443/ai-team/issues/407)
is the earlier shutdown investigation, not proof of this crash's resolution.

At the investigation base, `server/src/index.ts` closes the HTTP listener and
application services before closing database clients and stopping embedded
PostgreSQL. `closeDatabaseClients` ends the main, plugin migration and liveness
clients. `packages/db/src/client.ts` also owns registered/dedicated client cleanup.
These paths reduce shutdown exposure; they do not prevent an unexpected socket
close during normal operation, cancel a user callback, or prove all clients were
closed before the incident. Changing shutdown timeouts is not the proposed fix.

## Smallest safe follow-up and test contract

First resolve the installed-file discrepancy. If a frozen isolated build with the
existing patch covers the recovered scenario, propose restoring build/package
integrity through a separately reviewed release. Do not add a duplicate patch.
If the actual patched files still fail, add one minimized child-process regression
at the driver ownership seam before proposing an incremental change.

Prefer an upstream released fix only after comparing its exact diff and running
the same tests; no qualifying newer release was found in this investigation.
Otherwise extend the existing pinned pnpm patch under `packages/db` ownership in
a separate implementation PR. Re-evaluate driver PRs #1209 and #1215 together:
a null guard alone is insufficient. Do not replace the driver or add an
application-wide exception handler for this issue. ESM and CommonJS must agree;
the current patch does not cover the Cloudflare build, which needs its own
consumer/scope decision rather than an untested portability claim.

Required semantics for any later change:

- Close owns connection generation, timer/buffer invalidation and settlement.
  Reject each in-flight and queued operation exactly once with its connection
  error. Do not drop bytes while leaving a pending promise unresolved.
- Reject every later query through a disconnected reservation or transaction,
  including savepoints and automatic COMMIT/ROLLBACK. Its old callback can keep
  executing JavaScript, but must never write through a replacement session.
- Reconnection serves fresh work only. Preserve transaction failure; do not retry
  a failed transaction or an ambiguous COMMIT automatically. A lost response may
  hide a committed write; callers must reconcile existing durable state before
  any independently authorized replay.
- Clear stale results/error state without returning a closed reservation to the
  open pool. A stale `release()` must not release another caller's reservation.
- Preserve TLS/authentication, pool limits, backoff and bounded `end()` behavior.
  Connection diagnostics use content-free fields and existing log/trace gates.

Regression matrix for the later implementation:

| Case | Required observation |
| --- | --- |
| Fake-wire FIN, late reserve query; buffered write around close | exact error is caught; child survives; all promises settle within a deadline |
| RST/error then close; write accepted in between | no uncaught exception, hung query, stale buffer or busy reconnect loop |
| Lost backend during transaction/savepoint | failed transaction rejects; late statements/commit/rollback never reach a replacement session |
| Transaction/reservation queues with `max_pipeline=1` | all queued promises reject; fresh query succeeds |
| Pool slot reused before old callback/release resumes | replacement transaction keeps its ID and expected committed rows; old scope has no effects |
| Dedicated client and listener teardown; `end` with pending writes | bounded teardown; no orphan sockets or uncaught callback after shutdown |
| Healthy connections and failed connect/auth | existing behavior remains; no swallowed errors or auth/TLS weakening |

Reuse the existing 12 real-PostgreSQL cases rather than replacing them with the
fake server. Run them against unpatched and treatment packages in disposable
PostgreSQL, assert transaction IDs/rows, capture child exit and stderr, and add the
newly recovered incident scenario. Run on Node 24.22.1 and the supported CI matrix,
with ESM and CommonJS. This document does not claim those SQL-level tests passed.

## Hold terms and current read surfaces

An **active pause hold** is a persisted `issue_tree_holds` row with mode `pause`
and status `active`, rooted at a task and effective on its descendants. A
**recovery execution blocker** is a separate recovery/ownership projection. A
**cancel hold** retains tree-cancel/restore state; it is not the pause gate returned
by `getActivePauseHoldGate`. A **wake diagnostic** reports bounded past attempts.
None of these terms means all execution gates are clear. No new glossary or ADR
is needed: this proposal preserves these existing concepts.

Source inspection at the fixed base establishes:

| Surface | Authorization and meaning | Can prove current pause absence? |
| --- | --- | --- |
| `GET /api/issues/:id/tree-control/state` | `issue-tree-control.ts`: `assertBoard`, company visibility via `getAccessibleResource`, then `issue:read`; returns `{activePauseHold}` from the tree-control module | Only for its defined lookup, with traversal limits; agents are denied |
| `GET /api/issues/:id/tree-holds` | Board only; lists hold records rooted at the requested task with filters | Does not itself aggregate all inherited holds |
| Issue detail / heartbeat context | Existing issue/company/privacy authorization; recovery and dependency projections | No; `executionBlocker=null` is not a tree-pause assertion |
| `diagnostics/wakes` and `diagnostics/subtree` | Issue-read-authorized, bounded and visibility filtered; can show past `issue.tree_hold_wakeup_deferred` or `issue_tree_hold_active` | No; no recent event is not proof of current absence |
| Checkout, follow-up or reconciliation rejection | A mutating admission attempt can return a pause error | Do not use mutations as a diagnostic probe |

The incident report records eight Board-only 403 responses. No refused endpoint
was retried here. No existing **agent-authorized complete current pause-state
read** was found in the inspected route/service projections. This is a bounded
source conclusion, not a claim about every plugin or future version.

`server/src/services/issue-tree-control.ts:getActivePauseHoldGate` selects active
pause holds for the company and walks the task's parent chain, returning the
nearest matching root. It stops on cycles or at depth 100 and returns null after
exhaustion. It also returns null for a missing parent. Thus reusing that null as
an authoritative `clear` would introduce false negatives. Multiple holds at one
root are reduced to one representative; this is adequate for a gate, not a list
of all hold records. A new read must explicitly detect incomplete traversal.

## Minimal read capability proposal

Add one new, task-scoped read interface, for example
`GET /api/issues/:id/execution-hold-state`. Leave the Board tree-control read,
preview, create, resume, restore and release routes unchanged. This avoids
exposing Board-only reasons, release policy, members or hold identifiers by
removing a guard from an existing broad response.

The issue-tree-control module owns a pure diagnostic read. Its interface returns
only the effective **active ancestor pause** status and completeness; it hides
traversal and storage details. The route owns authentication and `issue:read`
authorization. Reuse existing access policy, including project/private-issue and
low-trust restrictions. Same-company membership alone is insufficient. No new
operator whitelist, Board token, recovery action or task mutation is needed.

Proposed response (contract to be finalized in the implementation review):

```json
{
  "issueId": "<authorized-task-id>",
  "scope": "active_pause_ancestors",
  "state": "held",
  "complete": true,
  "observedAt": "<snapshot-time>"
}
```

States are `held`, `clear`, `unknown`. `clear` requires a complete company-scoped
ancestor traversal ending at an actual root with no active pause at that read
snapshot. A hold found on the traversed chain proves `held`, even if other gates
are unknown. Cycles, depth limits, inconsistent/missing ancestors and bounded
query failure must never yield `clear`. Return `unknown`/`complete:false` for a
bounded incomplete result, or a normal 5xx when the read fails. Unauthorized or
missing tasks use the existing non-disclosing 404 behavior; unauthenticated
requests use the existing 401 behavior. The response is `Cache-Control: no-store`.

Use one bounded recursive read or a read-only consistent snapshot so a concurrent
reparent/resume cannot mix generations into a false `clear`. Keep all task and
hold reads company-scoped. An authorized child's hidden ancestor may affect the
boolean without exposing its ID, title, reason, count or policy. Expose no root or
hold identifiers in the minimal response. If access policy forbids even that
inherited-effect disclosure, return `unknown`; settle this policy in the later
security review. Do not add a reason/detail expansion by default.

The response is diagnostic evidence at `observedAt`, not permission to dispatch.
Existing dispatch rechecks still own authority. `clear` refers only to active
pause ancestors. It proves neither absence of cancel history nor clearance of
recovery, review, dependency, project/company pause, budget or lock gates. If an
operator needs a full hold-history inventory, that remains the Board interface
and a separate capability decision.

Implementation locations for a later authorized change:

- `server/src/services/issue-tree-control.ts`: bounded pure snapshot read; keep
  the mutation/admission gate behavior unchanged in this slice.
- `server/src/routes/issue-tree-control.ts`: new authorized read route, using
  current resource access and privacy checks before reading hold state.
- `packages/shared/src/types/issue.ts`, shared exports and API-path contracts:
  narrow diagnostic DTO; document it with the existing agent API documentation.
- Add a typed consumer only if required by the authorized delivery; no UI work,
  schema change, permission seed, general diagnostics framework or global issue
  response expansion is needed for this one-task read capability.
- Update affected feature/access map entries and run `node scripts/check-maps.mjs`
  when that future behavior changes. This document changes no mapped behavior.

Allow/deny and purity acceptance tests for that future interface:

| Fixture / actor | Expected result |
| --- | --- |
| Authorized same-company assignee, visible root or descendant | 200, own/inherited active pause reports `held`; complete empty chain reports `clear` |
| Authorized reader who is not the assignee | Follow existing `issue:read` result; no ownership-based expansion or restriction invented by this route |
| Other-company agent, private/project-hidden task, revoked grant | Existing non-disclosing denial; no hold data or existence oracle |
| Missing/unauthenticated/invalid credential | Existing 404/401 behavior; no query before authorization |
| Visible child under hidden ancestor with hold | Only coarse effective status, no ancestor/hold/reason metadata, subject to the policy above |
| Released pause, active cancel, nested/multiple active pause roots | Correct pause-only semantics; cancel never mislabeled; no count/detail leak |
| Cycle, chain beyond depth cap, missing ancestor, database failure | `unknown` or explicit failure; never `clear` |
| Concurrent hold creation/release/reparent | Response matches one consistent snapshot; no promise of future dispatch authority |
| Allowed and denied reads, repeated reads | No changes to holds, tasks, status versions, policies, history, locks, queues, recovery or audit mutation rows; no wake or dispatch |
| Agent attempts preview/create/resume/restore/release | Remain Board-only 403; no operator whitelist expansion |

Test the assembled route with the real access policy as well as the diagnostic
module. Set a 100-ancestor traversal limit and a 2-second query deadline; exceeding
either yields `unknown` or an explicit failure. Measure response latency on an
isolated representative company fixture before release, including the deepest
supported chain and many unrelated active holds. The read must use no background
polling. UI viewport/theme/screenshots are N/A because this proposal adds no UI. Snapshot domain tables and assert zero wake calls before/after both
allowed and denied requests. Avoid reusing issue-detail GET as the pure reader:
that route currently performs recovery revalidation, so an HTTP GET alone is not
proof that an implementation has no domain side effects.

## Later rollout, independent acceptance and rollback

The parent task must authorize any implementation separately. Split a driver
change and the read capability into separate reviewed PRs with their own tests.
A documentation approval approves neither. Do not run the following production
steps as part of this investigation.

1. Capture exact resolved package bytes and a minimized incident-path fixture.
   Gate the driver implementation on that evidence; retain unknowns if missing.
2. Build an isolated frozen-lock artifact at an independently approved full SHA.
   Verify the packaged patch and resolved ESM/CommonJS files, not just source or
   version metadata. Run the fake-wire and real-SQL matrix, bounded shutdown and
   fresh-connect controls. For the read slice run the full allow/deny/purity matrix.
3. In an approved disposable staging instance, inject transport/backend close,
   drive transaction and reservation reuse, prove caught errors, no partial or
   cross-transaction effects, no hanging promises, healthy fresh work and bounded
   shutdown. Preserve exit codes and failing controls; a retry does not erase a
   failure. Never inject these faults into the live controller.
4. Only after a separate release decision, ops deploys the approved artifact using
   the existing drain/release procedure. Preserve in-flight work, holds, review
   histories, counters and lock ownership. No manual business replays. Record
   build/package hashes and release/rollback SHA in the release task, not here.
5. An independent Coder checks the deployed package identity, startup/health,
   connection errors and controller restarts. For the read capability, use only
   authorized visible test tasks; denied requests remain denied and mutations
   remain Board-only. A short healthy window does not prove the race is gone.
   If a longer window is required, ops owns a bounded host observation job with
   explicit start/end and evidence; no Coder run waits across the window.
6. Roll back on a new uncaught connection exception, pending-query leak, unexpected
   transaction rows/IDs, reconnect failure, data leak, or read-induced mutation.
   Ops uses the prior known artifact through the existing approved release path;
   no dependency hot patch or permission edits. The read capability is additive
   and needs no migration rollback. Preserve diagnostic evidence and existing
   business gates. A driver rollback can restore the old defect, so reconcile
   uncertain commits and suspend affected new work through authorized controls
   rather than silently retrying it. Revalidate health and package hashes after
   rollback. The previous artifact and its limitations must be named before rollout.

## Document verification and open decisions

The investigation reproduced the published driver's crash and bounded the
existing patch's coverage, checked source history and primary upstream material,
and compared the current read surfaces. It did not establish the production
close trigger, installed-file integrity, SQL transaction safety of a new fix,
Cloudflare behavior, or any production hold's current state.

Before implementation: obtain runtime package identity evidence, select the
minimized missing scenario if any, and approve the coarse inherited-pause read
policy. No blanket claim that all holds are absent is permitted.

This is a documentation-only PR. The PR records actual repository check results,
independent review of its exact HEAD, and later merge SHA. Full typecheck/test/build
results must not be inferred from the standalone probes. The reviewer must merge
the approved documentation SHA into `develop`, verify the merged content, and
explicitly close #106 if it remains open. The execution worktree remains managed
by Paperclip; no manual deletion of it or changes to the primary checkout.


Local repository verification on 2026-10-28:

- PASS: `git diff --check`; embedded fixture SHA-256, referenced source paths and
  fenced-code balance checks. The standalone result matrix above ran against
  extracted npm packages and required no repository dependencies.
- BLOCKED: `timeout 90 pnpm -r typecheck`, exit 1: `TS2688 Cannot find type
  definition file for node`; workspace dependencies are not installed.
- BLOCKED: `timeout 90 pnpm test:run` and `timeout 90 pnpm build`, both exit 1:
  preflight cannot find `cli/node_modules/tsx/dist/cli.mjs`. Neither the test suite
  nor build reached execution. No assertion of a passing full suite is made.
- The documentation-only investigation did not install the full workspace or
  alter its dependency graph. CI results and the independent review remain
  delivery gates; environment failures above remain part of the evidence.
