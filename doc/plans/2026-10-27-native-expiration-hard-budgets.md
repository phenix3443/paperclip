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

1. The row drains (see below).
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
- `gitExpirationRoundFailure` maps SQLSTATE `57014` to `resource_limit` with reason
  `statement_timeout` (G10). The round does not use `pg_cancel_backend`; a closed
  connection after an abort gives a `CONNECTION_*` error, not `57014`.
- Add an optional `dedicatedApplicationName` to the `createDb` options. The round
  sets it to its own application name, so every round backend carries it. Default
  behavior is unchanged for other callers.
- The ledger counts open round clients: pool (`maxConnections: 2`) plus open
  dedicated clients. Opening a dedicated client when the count would exceed 4 throws
  `GitExpirationBudgetExceeded("db_connections")` before the client connects.
  `withDedicatedDbConnection` gets a small hook for this; without a ledger it does
  nothing.

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
5. On timeout or abort, sends `SIGTERM` to the group, then `SIGKILL` after 2 s.
6. Settles only after the child `close` event (G8). The scratch directory `finally`
   blocks run after that.
7. Classifies `ENOSPC` or `EDQUOT` from spawn or filesystem errors, and stderr that
   reports "No space left on device" or "Disk quota exceeded", as
   `GitExpirationBudgetExceeded("scratch")` (G11). `verifyRemoteGitCommit` passes
   this error through and does not wrap it in `GitCacheRestorationFailure`.

The child registry keeps every running group until `close`. Drain uses it.

### Drain before lock release

The lock order stays source, then lifecycle. Release must follow drain:

1. Row work ends (success, error, row deadline or round abort).
2. The ledger drains: every Git group is closed (step 5 above) and every walk
   promise has settled.
3. Scratch directories are removed.
4. The lifecycle transaction ends, then the source transaction ends. This releases
   the advisory locks.

Steps 2 and 3 run in a `finally` inside the lifecycle transaction callback, so no
error path can leave the transaction before the drain.

Today's `cancel` on round abort (G9) changes to: abort the signals, wait for the
drain with a 5 s bound, then call `terminateDbConnections`. A blocked statement
during this wait is still bounded by `statement_timeout`. If the drain does not
finish in 5 s (for example a child in uninterruptible sleep), the round keeps its
connections and locks open, records `drainIncomplete: true` in the terminal record,
and leaves the kill to the host `TimeoutStopSec`. The locks then end with the
process. The native code never releases a lock before the drain while it still
runs.

The 2 s kill grace plus the 5 s drain bound fit inside the host's 15 s stop window.

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
  - `drainIncomplete`.
- New row reasons under `resource_limit`: `row_deadline`, `walker_entries`,
  `git_output`, `scratch`, `statement_timeout`, `db_connections`. Existing reasons
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
| Statement | Blocked statement in page query and in eligibility (lock held by a test session) | Ends within 10 s; `resource_limit` `statement_timeout`; not `database_error` |
| Connections | Count `pg_stat_activity` by the round application name during a row | Peak ≤ 4; a forced fifth client throws `db_connections` before connecting |
| Git children | Two concurrent requests in a test seam; child that writes 16 MiB + 1 byte split over stdout and stderr | Invariant error; `git_output`; group killed |
| Drain | Abort during remote proof fetch, during a walk and during a DB statement; child that ignores `SIGTERM` | Lifecycle and source advisory locks are still held while the child runs; released after `close`; no process of the group remains; scratch removed after `close` |
| Drain bound | Child that does not exit after `SIGKILL` (simulated by a test seam) | `drainIncomplete: true`; connections not closed by the round before the bound |
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

1. Budget module, Git child runner and drain order (G7, G8, G9, G11, G12).
2. Walker entry budget and per-row deadline (G1, G2, G3).
3. Selection cap, DB budgets, CLI contract and report (G4, G5, G6, G10, G13).

Each slice gets its own independent review. The host slice (ai-team#483) starts
only after all native slices merge.
