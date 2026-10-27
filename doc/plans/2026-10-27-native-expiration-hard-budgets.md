# Native hard budgets for the Git expiration inspection round

Status: proposal for independent review. Issue: [#53](https://github.com/phenix3443/paperclip/issues/53).
Implementation: [#54](https://github.com/phenix3443/paperclip/issues/54), which starts only after this plan is approved and merged.
This document authorizes no implementation, installation, deployment, `.env` edit,
service restart, production dry-run, cleanup or live expiration. The public host
`start` stays disabled.

Background: [ai-team#483](https://github.com/phenix3443/ai-team/issues/483) and the approved
[one-round design](https://github.com/phenix3443/ai-team/blob/main/docs/paperclip/expiration-one-round-design.md).
Native prerequisite: PR [#48](https://github.com/phenix3443/paperclip/pull/48), approved head
`260a68963fdf4d93fa11c0a6bedb993c9b69cb0b`, merge `9030ac4c1ba8da1f0a6e75f6fb71f64ac5d24f45`.

## Problem

`inspectGitExpirationRound` (PR #48) is the fixed native entry that the host runs
for one read-only inspection round. The host can enforce limits on the whole
process: wall clock, memory, tasks, CPU, scratch and evidence size. It cannot see
inside the process. Some approved budgets apply to a single row, a single walk or
a single Git child, so only the native code can enforce them.

The current native code does not enforce them:

- The `allocatedBytes` walker has no entry cap. Only an abort stops it.
- A row has no deadline of its own. Each Git command has its own timeout, and
  one helper allows 120 s for a single command.
- `maxRows` counts inspected rows. The round selects and records a full page of
  keys before it checks `maxRows`, so it can persist more selected keys than the
  budget allows.
- No DB statement timeout, connection cap, Git child cap or combined output cap
  is set for the round.
- An abort can release the advisory locks while a Git child still runs.

A host wrapper must not copy native algorithms to close these gaps. This plan puts
each budget at the single owner that can enforce it, and makes the fixed CLI report
enough for the host to verify the result.

## Approved budgets (unchanged)

This plan does not relax or raise any value. A new value needs a new reviewed design.

| Budget | Value | Enforced by |
| --- | --- | --- |
| Round wall clock | 600 s | Host (`RuntimeMaxSec=600`, independent stop timer). Native deadline is an additional lower bound. |
| Stop drain | 15 s | Host (`TimeoutStopSec=15`, cgroup `SIGKILL`). Native drains inside it. |
| Per-row time | 60 s | Native |
| Walker entries | 100,000 per row | Native |
| DB statement | 10 s | Native (session parameter) |
| DB lock acquisition | nonblocking | Native (already `pg_try_advisory_xact_lock`) |
| Selected rows | 10,000 | Native |
| Full pages | 200, plus one exhaustion query | Native |
| DB connections | 4 | Native |
| Concurrent Git children | 1 | Native |
| Child output | 16 MiB per child, stdout and stderr combined | Native |
| Evidence | 64 MiB | Host (hard). Native stops early with a reserve for the terminal record. |
| Scratch | 256 MiB | Host (hard quota on the `TMPDIR` filesystem). Native classifies quota errors. |
| Memory, tasks, CPU | `MemoryMax=512M`, `TasksMax=32`, `CPUQuota=50%` | Host |

Rule for both sides: a constraint that the owner cannot prove ends the round
`partial`. A cap hit never becomes a row rejection followed by `complete`.

## Verified gaps in the current source

Read at `develop` `df7e23e51db05036a5a58db40e30fb6f8166ca00` on 2026-10-27.
Paths are relative to the repository root.

| # | Location | Observation | Consequence |
| --- | --- | --- | --- |
| G1 | `server/src/services/git-workspace-expiration-inspection.ts:18` `allocatedBytes` | Recursive walk. `fs.readdir` loads a whole directory listing. No entry count. | One worktree with many files can use the full round. |
| G2 | `server/src/services/workspace-compaction.ts:129` `findRegenerableWorkspaceDirs`; `git-workspace-restoration.ts:153` `assertReproducibleBaseGitStorage` walk; `git-workspace-restoration.ts` `assertEmptyRefs` | Three more unbounded walks inside one row. `findRegenerableWorkspaceDirs` swallows every `readdir` error with `.catch(() => [])`. | A budget or abort error thrown inside that `readdir` would be lost. |
| G3 | `server/src/services/git-expiration-round.ts:123` `inspectRow` | No row deadline. Commands use 60 s (`gitCacheCommand`), 120 s (`hasCommitsMissingUpstream`) and 10 s without a signal (`stockGitFiles`). | A row can take many minutes. |
| G4 | `git-expiration-round.ts:204–226` | Page `limit(pageSize)` does not depend on the remaining budget. `page_selected` records all keys. `maxRows` is checked per inspected row. | Selected and persisted keys can exceed the budget by up to one page. |
| G5 | `git-expiration-round.ts:10` `GIT_EXPIRATION_ROUND_SESSION_PARAMETERS` | No `statement_timeout`. `createDb` gets explicit options, so `DATABASE_CONNECT_TIMEOUT_SECONDS` is not read and the driver default connect timeout (30 s) applies. | A blocked statement or connect waits until the round deadline. |
| G6 | `packages/db/src/client.ts` `withDedicatedDbConnection` | Each call opens a new client. Dedicated clients use application name `paperclip-workspace-finalization-lock`. No count of open clients. | The round uses pool 2 + source 1 + lifecycle 1 = 4 today, but nothing enforces it. Tests cannot attribute dedicated backends to the round by name. |
| G7 | `git-workspace-restoration.ts:112`, `:127`, `:235`; `workspace-compaction.ts:53` | `execFile` `maxBuffer` applies to stdout and stderr separately. | One child can buffer 32 MiB. |
| G8 | All `execFile` call sites above | With `signal`, the promise rejects before the child exits. Checked with Node v26.12.1: abort at 200 ms rejected at 207 ms, and the child closed at 2010 ms. | The `finally` that removes the scratch directory, the end of the lifecycle transaction and the source lock release can run while Git still reads the worktree or writes scratch. |
| G9 | `git-expiration-round.ts:181` `cancel` | On abort, the round calls `terminateDbConnections` at once. | Advisory locks are released before Git children and walks drain. |
| G10 | `git-expiration-round.ts:106` `gitExpirationRoundFailure` | PostgreSQL `57014` (`query_canceled`, also used for `statement_timeout`) is a `PostgresError`, so it is classified `database_error`. | A statement budget hit is reported as a database failure, not `resource_limit`. |
| G11 | `git-workspace-restoration.ts:133` `verifyRemoteGitCommit` | Any fetch error becomes `GitCacheRestorationFailure`, which `gitExpirationSkipReason` maps to the rejection `upstream_commit_unverified`. | A scratch quota error (`ENOSPC`, `EDQUOT`) becomes a normal rejection, and the round can still be `complete`. |
| G12 | `workspace-compaction.ts:44` `runGitRead` | No `GIT_OPTIONAL_LOCKS=0` and no `GIT_TERMINAL_PROMPT=0`. The commands it runs (`check-ignore`, `ls-files`) do not write the index today. | The read-only guarantee depends on the command list, not on the runner. |
| G13 | `server/src/git-expiration-round-cli.ts:62–63` | `--max-rows` and `--deadline-seconds` accept up to 999,999,999. No deadline when the flag is absent. | The fixed CLI accepts values above the approved budget. |

G7–G12 are additional native gaps inside the approved budgets. Issue #53 asked to
identify them. None of them needs a budget change.

## Design

### Ownership

The native round owns per-row, per-walk, per-child and per-query budgets, the
order of drain and lock release, and the durable partial outcome. The host owns
the process envelope (600 s, 15 s stop, memory, tasks, CPU), the hard evidence and
scratch quotas, and the verification of the native report. The host does not
reimplement selection, eligibility, proof or walks.

### One inspection budget context

Add `server/src/services/git-expiration-budget.ts`. It exports the fixed budget
values and an `InspectionBudget` ledger with:

- the round signal and the current row signal;
- a per-row entry counter for all walks;
- a Git child gate (one slot) and a registry of running children;
- counters for DB clients, selected rows and full pages;
- peak values for the final evidence.

The round installs the ledger with `AsyncLocalStorage` around each row, in the
same way `withIsolatedRepositorySourceLock` already tracks held source locks.
Shared helpers read the ledger when it exists. Without a ledger (live expiration,
compaction, every other caller) they keep their current behavior. This avoids a
new parameter through every shared signature and keeps the live-path tests
unchanged.

A budget hit throws `GitExpirationBudgetExceeded` with a `budget` name. The class
is recognized by `gitExpirationRoundFailure` before any other rule, so it always
maps to `resource_limit` with that name as the row reason.

### Selection: selected rows and pages

Replace the inspected-row check in the page loop:

1. `selectionCap = min(maxRows ?? 10_000, 10_000)`. `maxRows` above 10,000 is an
   invariant error (`invalid_row_budget`). `pageSize` above 50 is an invariant error.
2. Each page query uses `limit(min(pageSize, selectionCap - selected))`. A page
   whose length equals that limit is a full page.
3. Record `page_selected` with the keys before any row of the page is inspected,
   as today. The round never persists a selected key beyond `selectionCap`.
4. When `selected == selectionCap` or `fullPages == 200`, run one exhaustion query
   with the same filter, cursor and bound and `limit(1)`. Record
   `{ type: "selection_exhaustion_checked", more: boolean }`. Do not record the key.
5. If `more` is false, the selection is exhausted. If `more` is true, the round
   stops `partial` with stop reason `row_budget` after it inspects the selected
   rows. A short or empty page ends the selection as today.

`complete` still needs `exhausted`, no stop reason and `inspected == selected`.
`maxRows` now means selected rows. The documentation changes with it.

### Per-row deadline

`inspectRow` gets `rowSignal = AbortSignal.any([roundSignal, AbortSignal.timeout(60_000)])`.
The deadline covers the whole row: source lock, lifecycle transaction, eligibility,
proof, walks and the trash checks. Helpers already accept `signal`, so the row
signal reaches them. The ledger gives each Git child
`timeout = min(command timeout, row time left)`, so the 120 s helper cannot outlive
the row.

When the row deadline fires:

1. The row drains (see "Drain before lock release").
2. The round records `row_inspected` with outcome `resource_limit` and reason
   `row_deadline`.
3. The round stops `partial` with stop reason `resource_limit`.

A row deadline is not an abort of the round. The round signal stays the source of
`aborted` and `deadline` stop reasons.

### Walker entry budget

Add one walk primitive in the budget module: `walkEntries(root, visit, signal)`.
It uses `fs.opendir` so that a large directory is read in batches, and it calls
`ledger.countEntry()` before it handles each entry. The 100,000th entry is
allowed. The next one throws `GitExpirationBudgetExceeded("walker_entries")`.

The counter is per row and covers every walk in the row:

- `allocatedBytes` (G1);
- `findRegenerableWorkspaceDirs` and its `collect` (G2);
- the `assertReproducibleBaseGitStorage` walk and `assertEmptyRefs` (G2);
- the single-directory `readdir` calls in `assertReproducibleBaseGitStorage` and
  `assertReproducibleGitFiles`.

`findRegenerableWorkspaceDirs` keeps `.catch(() => [])` only for filesystem errors.
It rethrows `GitExpirationBudgetExceeded` and abort errors. Without a ledger, the
primitive counts nothing and the walks behave as today, except that `allocatedBytes`
reads directories in batches.

### DB statement, connect and connection budget

- Add `statement_timeout: "10000"` to the round session parameters. This also
  bounds lock waits inside a statement. Advisory locks stay try-only.
- Pass `connectTimeoutSeconds: 10` to `createDb`.
- Statement timeouts are classified at every query site (G10). See
  "Database error classification" below.
- Add an optional `dedicatedApplicationName` to the `createDb` options. The round
  sets it to its own application name, so every round backend carries it. Default
  behavior is unchanged for other callers.
- The ledger counts open round clients: pool (`maxConnections: 2`) plus open
  dedicated clients. Opening a dedicated client when the count would exceed 4 throws
  `GitExpirationBudgetExceeded("db_connections")` before the client connects.
  `withDedicatedDbConnection` gets a small hook for this; without a ledger it does
  nothing.

### Database error classification

One function, `classifyRoundError(error)`, replaces the direct `database_error`
assignments. It returns the first match in this order:

1. Round cancellation: `options.signal` aborted gives `aborted`; the round
   deadline gives `deadline`. This comes first because an abort ends the pool and
   the in-flight query then fails with a `CONNECTION_*` error.
2. `GitExpirationBudgetExceeded` anywhere in the cause chain: `resource_limit`
   with its budget name.
3. A `PostgresError` with SQLSTATE `57014` and the server message
   `canceling statement due to statement timeout`: `resource_limit` with budget
   `statement_timeout`. The round never cancels a backend itself, so another
   `57014` (for example `canceling statement due to user request` from an
   operator) stays `database_error`.
4. Any other `PostgresError`, `DrizzleQueryError` or `CONNECTION_*` error:
   `database_error`.
5. Anything else: `null`. The caller keeps its current handling.

Each catch uses it:

| Catch | Today | New result | Report |
| --- | --- | --- | --- |
| Upper-bound clock query | `stopReason() ?? "database_error"` | Stop reason from the classifier | `budgetHit` scope `round` on `statement_timeout` |
| Page query | `stopReason() ?? "database_error"` | Stop reason from the classifier | Same |
| Exhaustion query (new) | n/a | Stop reason from the classifier; `exhaustionChecked: false`, `exhausted: false` | Same |
| `inspectRow` catch (source lock, lifecycle lock, eligibility, proof) | `gitExpirationRoundFailure`; `database` is rethrown | Rules 2 and 3 give a `row_inspected` record with outcome `resource_limit` and the budget as reason; rule 4 rethrows as today | `budgetHit` scope `row` |
| Round catch around `inspectRow` | `stopReason() ?? "database_error"` | Classifier again, so a rethrown error cannot skip rules 1–3 | Scope `row` |

A classifier result of `resource_limit` stops the round `partial` with stop reason
`resource_limit`. `gitExpirationRoundFailure` delegates to rules 2–4 so the
existing row reasons stay in one place.

### Git child runner

Add `runBoundedGit(args, options)` in the budget module. Every Git child of the
inspection goes through it: `gitCacheCommand`, `verifyRemoteGitCommit`,
`hasCommitsMissingUpstream`, `stockGitFiles` and `runGitRead`. Without a ledger
these call sites keep their current `execFile` behavior.

With a ledger the runner:

1. Takes the one Git slot. A request while the slot is taken is an invariant error,
   because the inspection is sequential. It does not wait or queue.
2. Spawns with `detached: true`, so the child and its helpers (for example
   `git-remote-https`, `index-pack`) share one process group.
3. Sets `GIT_OPTIONAL_LOCKS=0` and `GIT_TERMINAL_PROMPT=0` for every command (G12).
4. Counts stdout and stderr bytes together. At more than 16 MiB it kills the group
   and throws `GitExpirationBudgetExceeded("git_output")` (G7).
5. On timeout, abort or output cap, sends `SIGTERM` to the group, then `SIGKILL`
   after 2 s.
6. Settles only after the whole group is gone (G8), not at the leader `close`
   event. See "Process group lifetime" below. The scratch directory `finally`
   blocks of the helpers run after that.
7. Passes `GIT_CONFIG_COUNT` entries `gc.auto=0`, `maintenance.auto=false` and
   `core.fsmonitor=false`. These stop Git from starting detached maintenance or
   an fsmonitor daemon, which call `setsid` and leave the group.
8. Classifies `ENOSPC` or `EDQUOT` from spawn or filesystem errors, and stderr that
   reports "No space left on device" or "Disk quota exceeded", as
   `GitExpirationBudgetExceeded("scratch")` (G11). `verifyRemoteGitCommit` passes
   this error through and does not wrap it in `GitCacheRestorationFailure`.

#### Process group lifetime

A leader `close` event only proves that the leader exited and its stdio closed. A
helper in the same group can keep running with its stdio redirected. The runner
therefore tracks the group, not the leader:

1. The group id is the leader pid (`detached: true`). The registry entry holds it
   from spawn until the group is proven empty.
2. Proof is `process.kill(-pgid, 0)` failing with `ESRCH`. Success or `EPERM`
   means the group may still have members. The runner probes every 50 ms with an
   unref'd timer.
3. At leader `close` the runner probes once. If the group is empty, it settles
   with the command result.
4. If members remain after the leader closed, the command result is not used. The
   runner sends `SIGTERM` to the group at once, starts the 2 s `SIGKILL` timer, and
   keeps probing. When the group is gone it rejects with
   `GitExpirationBudgetExceeded("git_group_survivor")`, so the row ends
   `resource_limit` and the round ends `partial`.
5. On timeout, abort or output cap, the same timer starts at that moment. The
   runner still waits for the leader `close` and for `ESRCH`.
6. The registry entry is removed only after `ESRCH`. Until then the runner promise
   stays pending, so the helper `finally` that removes scratch has not run, and the
   row's transaction callbacks have not returned (see "Drain before lock release").

The probe fails safe. A killed member is a zombie until its new parent reaps it,
and a zombie still counts as a member. If the pgid is reused by an unrelated new
group after the old one ended, the probe reports "alive". Both cases make the
runner wait longer, never release early. A process that calls `setsid` on its own
leaves the group and the native proof. Step 7 above prevents the known Git cases.
For anything else the host cgroup is the envelope, and the host checks that the
unit cgroup is empty after the round (ai-team#483).

### Drain before lock release

The lock order stays source, then lifecycle. Release must follow drain.

#### Who owns what

`inspectRow` returns two promises instead of one value:

- `outcome` settles when the row result is known. That is when the work phase
  returns or throws, or when the row signal aborts (row deadline, budget hit or
  round abort), whichever comes first.
- `released` settles when the whole lock chain has unwound.

The lock chain is one promise and owns everything that protects the row:

```
withIsolatedRepositorySourceLock          source dedicated client, source tx, source keepalive
  withDedicatedDbConnection               lifecycle dedicated client
    connection.transaction                lifecycle tx
      withWorkspaceLockKeepalive          lifecycle keepalive (new)
        try { work(tx) }                  eligibility, proof, walks, Git runners, scratch finally blocks
        finally { await ledger.drain() }  waits until the Git registry is empty and work has settled
```

- `work` awaits every runner and walk, and each helper removes its scratch in its
  own `finally` after its runner settles. So `work` settles only after all its
  groups are gone and its scratch is removed.
- `ledger.drain()` also waits until the registry is empty. This guards against a
  runner that was started but not awaited.
- The lifecycle transaction gets the same keepalive as the source transaction.
  Without it, a server `idle_in_transaction_session_timeout` could end the
  lifecycle backend while the callback waits for drain. Both keepalives stop only
  when their `work` returns, so they keep running while drain is pending.
- No finalizer on this chain runs before `work` and `drain` have settled: the
  transaction commit or rollback, `withDedicatedDbConnection` ending its client,
  and the source transaction end all come after the callback returns.

The round owns the pool (clock, page and exhaustion queries) and the journal. The
pool holds no advisory lock.

#### Normal path

1. Row work ends. `outcome` gives the row result.
2. The round waits for `released`, bounded by 5 s from the moment `outcome`
   settled.
3. `released` settles in time. The round records `row_inspected` and goes on or
   stops as the row result says.

On success the groups are already gone when `work` returns, so `released` takes
only the commit and the client ends.

#### Row deadline, budget hit and round abort

- Row deadline: `rowSignal = AbortSignal.any([roundSignal, AbortSignal.timeout(60_000)])`
  fires. `outcome` gives `resource_limit` `row_deadline`.
- Budget hit: the ledger aborts the row signal with the `GitExpirationBudgetExceeded`
  error and `work` throws it. `outcome` gives `resource_limit` with the budget.
- Round abort or round deadline: the round signal aborts the row signal. The round
  ends the pool at once (no locks on it). It does not call
  `terminateDbConnections`, which would also end the dedicated clients (G9).
  `outcome` gives the round stop reason. As today, no `row_inspected` is recorded
  for this row.

When both apply, the round stop reason wins over the row result, as
`signal.throwIfAborted()` does today.

In each case the runners send `SIGTERM`, then `SIGKILL` after 2 s, and wait for
`ESRCH`. A walk checks the signal at every entry. A statement in flight in the
lifecycle transaction keeps running until it ends or hits `statement_timeout`.
Then `work` settles, drain finishes, and the chain releases the locks in order.

#### Drain not finished in 5 s

Examples: a helper in uninterruptible sleep, a walk blocked in a filesystem call,
or a lifecycle statement that needs up to 10 s.

1. The round stops waiting for `released`. It does not cancel, end or detach
   anything on the lock chain, so both transactions, both dedicated clients, both
   keepalives, the pending runners and their scratch stay as they are.
2. It sets `summary.drainIncomplete = true` and `summary.undrainedRow = key`.
3. For a row deadline or a budget hit it records `row_inspected` with outcome
   `resource_limit`. For a round abort it records no row.
4. It writes `round_finished` with status `partial`. This is the terminal record,
   written within the 5 s bound plus one journal write.
5. Its `finally` ends only the pool. It skips the dedicated clients when
   `drainIncomplete` is true.
6. It returns the summary and passes the pending `released` promise to the caller
   through a new option, `onUndrainedRow(released)`.

The fixed CLI then:

1. writes the stdout summary and closes the journal;
2. keeps its `SIGTERM` and `SIGINT` handlers installed, so a stop signal does not
   end the process by default action;
3. awaits `released` with no time limit, then exits 3.

So the process keeps both locks until one of two things happens:

- The drain finishes later. The chain releases the locks in order, and the CLI
  exits 3. The journal already ends with `round_finished` `partial`, which is the
  correct final record. No record is added.
- The host ends the process. On a round abort the host is already stopping the
  unit, and `TimeoutStopSec=15` sends `SIGKILL` to the whole cgroup. On a row
  deadline or budget hit alone, nothing stops the round early, and the host's
  `RuntimeMaxSec=600` does it. This stays inside the approved 600 s round budget.
  The locks end when the process dies, together with the group.

Time on a host stop: 2 s kill grace inside the 5 s bound, then one journal write.
This fits the 15 s stop window. A lifecycle statement that needs the full 10 s
makes the round report `drainIncomplete` even though it finishes later. That is
safe: the locks stay held, and the chain releases them after the statement ends.

The native code never releases a lock before drain while the process runs.

### Evidence budget

The host keeps the hard 64 MiB limit. The CLI file journal also counts its bytes.
It refuses a non-terminal event that would leave less than 64 KiB below 64 MiB and
throws `GitExpirationBudgetExceeded("evidence")` before it writes any byte. The
round's `record` recognizes this error: it does not set `evidenceLost`, it stops the
round `partial` with stop reason `resource_limit` and `budgetHit.budget = "evidence"`.
Terminal records (`round_finished`, `round_committed`) may use the reserve. If even
that record fails, the existing `evidence_lost` path applies. A host-side write limit (`RLIMIT_FSIZE` or a quota)
makes the write fail; the native code treats `EFBIG`, `ENOSPC` and `EDQUOT` from the
journal like any other lost record.

### Durable partial outcome and report

- Stop reasons do not change. Budget hits use `resource_limit` or `row_budget`.
- `round_started` gets `budgets`: the fixed values from the table above, and
  `scratchDir` (`os.tmpdir()`), so the host can compare them with its manifest.
- `round_finished` and the stdout summary get:
  - `budgetHit: { budget, scope: "row" | "round", limit, observed } | null`;
  - `peaks: { rowMs, rowEntries, childOutputBytes, dbClients, gitChildren, journalBytes }`;
  - `fullPages` and `exhaustionChecked`;
  - `drainIncomplete` and `undrainedRow` (the key, or `null`).
- New row reasons under `resource_limit`: `row_deadline`, `walker_entries`,
  `git_output`, `git_group_survivor`, `scratch`, `statement_timeout`, `db_connections`. Existing reasons
  stay (`git_timeout`, `git_output_limit`, helper budgets).
- `readGitExpirationRoundJournal` keeps its rules. It ignores the new event type
  because it reads only the first, the second-to-last and the last record.

### Fixed CLI contract

- `--max-rows` accepts 1 to 10,000. A larger value exits 2 before the database opens.
- `--deadline-seconds` accepts 1 to 600. A larger value exits 2. Without the flag,
  the native deadline is 600 s. The host timer stays authoritative.
- No flag or environment variable changes a budget. Budgets are constants in the
  budget module.
- Exit codes are unchanged: 0 complete, 3 partial, 2 usage, 1 failure.
- With `drainIncomplete`, the CLI writes the summary and closes the journal, then
  waits for the lock chain as described in "Drain not finished in 5 s".
- The host reads exit code first, then the stdout summary, then the journal, as
  `docs/deploy/git-expiration-round.md` already requires. The host checks that
  `budgets` equals its approved manifest and that `budgetHit`, `peaks` and
  `drainIncomplete` agree with its own cgroup and quota evidence. A mismatch or a
  missing field fails closed on the host side.

### Changes outside the round module

| Module | Change | Behavior without a ledger |
| --- | --- | --- |
| `packages/db/src/client.ts` | `dedicatedApplicationName` option; client-count hook in `withDedicatedDbConnection` | Unchanged |
| `git-workspace-restoration.ts` | Git calls go through `runBoundedGit`; walks use `walkEntries`; scratch errors pass through | Unchanged, except batched directory reads |
| `workspace-compaction.ts` | `runGitRead` and `collect` use the shared primitives; budget and abort errors are not swallowed | Unchanged |
| `git-workspace-expiration-inspection.ts` | `allocatedBytes` uses `walkEntries` | Unchanged count of bytes |

Live expiration and compaction never install a ledger. Their existing tests run
unchanged and prove the absent state.

## Out of scope

- Hardlink-unique `(dev, ino)` byte totals and apparent bytes from the design's
  evidence section. They are evidence fields, not budgets. They belong to a
  separate issue.
- Host packaging, systemd units, quotas and the stop executable (ai-team#483).
- Any change to eligibility, cursor, upper bound, lock keys or completion rules.

## Boundary tests

All tests use embedded Postgres, temporary directories and synthetic repositories.
They run through `inspectGitExpirationRound` or `runGitExpirationRoundCli`, not
only through extracted helpers. A fake clock or injected timers control time.

| Area | Cases | Pass criterion |
| --- | --- | --- |
| Walker | 99,999, 100,000 and 100,001 entries in one candidate row; a large flat directory; entries split across the worktree walk and the base storage walk | 100,000 completes; 100,001 gives `resource_limit` `walker_entries`, round `partial`; never `rejected` |
| Row deadline | A row stalls in a Git child, in a walk and in a DB statement; controllable clock at 59.9 s and 60 s | `row_deadline`; locks held until drain; no child left; round `partial` |
| Selection | 0, 1, 49, 50, 51, 9,999, 10,000 and 10,001 rows; `maxRows` 1, 50, 51; tied timestamps | No `page_selected` key beyond the cap; exactly one `limit(1)` exhaustion query at the cap; 10,000 rows with no more gives `complete`; 10,001 gives `row_budget`; `--max-rows 10001` exits 2 |
| Full pages | Page size 1 in the library with 200 and 201 rows | 200 full pages then one exhaustion query |
| Statement | Real server `57014` at each site: clock query (a test seam replaces the SQL with `select pg_sleep(11)`), page query and exhaustion query (a test session holds `ACCESS EXCLUSIVE` on `execution_workspaces`), source and lifecycle lock queries and eligibility (a test session holds a conflicting table lock); a `57014` from `pg_cancel_backend` by a test session | Each timeout ends within 10 s plus margin; round `partial`, stop reason `resource_limit`, `budgetHit.budget = "statement_timeout"` with scope `round` for clock, page and exhaustion and `row` for row queries; the row query cases record `row_inspected` `resource_limit`; never `database_error`. The user-cancel case stays `database_error`. An abort during a page query gives `aborted`, not `database_error` |
| Connections | Count `pg_stat_activity` by the round application name during a row | Peak ≤ 4; a forced fifth client throws `db_connections` before connecting |
| Git children | Two concurrent requests in a test seam; child that writes 16 MiB + 1 byte split over stdout and stderr | Invariant error; `git_output`; group killed |
| Drain | Abort, row deadline and budget hit during remote proof fetch, during a walk and during a DB statement; child that ignores `SIGTERM` | Lifecycle and source advisory locks (checked in `pg_locks` from a test session) are still held while the group runs; released only after `ESRCH`; no process of the group remains; scratch removed after the group is gone |
| Group survivor | A fake `git` first on `PATH` starts a helper with stdio redirected to `/dev/null` that ignores `SIGTERM` and keeps a file open in scratch, then exits 0 | Runner still pending after leader `close`; both locks held and scratch present until the helper is killed at +2 s; then `ESRCH`, scratch removed, locks released; row `resource_limit` `git_group_survivor`; round `partial` |
| Drain bound | Public `inspectGitExpirationRound` with a test seam whose group probe never returns `ESRCH`; once each for row deadline, budget hit and round abort | The call returns within the stop instant + 5 s + one journal write; journal ends with `round_finished` `partial`, `drainIncomplete: true`, `undrainedRow` set; `row_inspected` present for deadline and budget hit, absent for abort; both advisory locks and both dedicated backends still present after return; pool ended |
| Drain bound, process | The same seam in a child process that runs the round through the CLI entry, then receives `SIGTERM` | Stdout summary and journal written; process does not exit on `SIGTERM`; both locks held until the test sends `SIGKILL`; locks gone after the process ends |
| Lifecycle keepalive | Server `idle_in_transaction_session_timeout` of 2 s and a drain held for 6 s | Lifecycle and source backends survive; locks held |
| Scratch | Fetch into a directory that returns `ENOSPC` | `resource_limit` `scratch`, not `upstream_commit_unverified` |
| Evidence | Journal near 64 MiB minus reserve; write that fails with `EFBIG` | `partial` with `budgetHit.budget = "evidence"`; `evidence_lost` and exit 3 on write failure |
| CLI | `--deadline-seconds 601`; absent deadline | Exit 2; default 600 s recorded in `round_started` |
| Report | Normal complete round; each budget hit | `budgets`, `peaks`, `budgetHit`, `fullPages`, `exhaustionChecked` present in the summary and the journal |
| Live path | Existing `git-workspace-expiration*.test.ts`, compaction tests, `git-expiration-auth-fallback.test.ts` | Pass unchanged |
| Read-only | Existing source scan and mutation traps from PR #48 | Still zero writes, moves, deletes and lock files |

## Delivery

Issue #54 implements this plan. The plan covers more than one class of guarantee:
resource caps, cancellation and drain, and the CLI report. If the implementation
grows beyond about 400 lines of core logic, split it into PRs in this order:

1. Budget module, Git child runner with group proof, drain ownership and the
   undrained hold (G7, G8, G9, G11, G12).
2. Walker entry budget and per-row deadline (G1, G2, G3).
3. Selection cap, DB budgets and error classification, CLI contract and report
   (G4, G5, G6, G10, G13).

Each slice gets its own independent review. The host slice (ai-team#483) starts
only after all native slices merge.
