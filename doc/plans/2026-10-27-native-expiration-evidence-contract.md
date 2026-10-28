# Native evidence contract for the Git expiration inspection round

Status: proposal for independent review. Issue: [#84](https://github.com/phenix3443/paperclip/issues/84).
Implementation: [#85](https://github.com/phenix3443/paperclip/issues/85), which starts only after this plan is approved and merged.
This document authorizes no implementation, installation, deployment, `.env` edit,
service restart, production dry-run, cleanup or live expiration. The public host
`start` stays disabled until all approved prerequisites and the original safety
gates are satisfied. Production authorization stays separate.

Background: [ai-team#484](https://github.com/phenix3443/ai-team/issues/484), its draft
consumer [ai-team#512](https://github.com/phenix3443/ai-team/pull/512) and the approved
[one-round design](https://github.com/phenix3443/ai-team/blob/ca5ae09a47ebd3e2cdc4fa3c4ca4974a84b53cb3/docs/paperclip/expiration-one-round-design.md)
("the design"). Native baseline: `2cb165cfd7c48473a92771881547814627403b6a`. This plan
does not close ai-team #484, #447 or #415.

## Problem

The design requires evidence that the native round does not produce today. The
host consumer (ai-team#484) cannot fill the gap by itself: the observations must be
made under the native source and lifecycle locks, at the moment the native code
inspects the row. A host copy of eligibility, proof, cursor or mutation logic is
forbidden.

Read at the baseline on 2026-10-27. `develop` `773d1cc4edd129816fce0d60f76c8159c6756cfe`
has no change in the files below. Paths are relative to the repository root.

| # | Design requirement | Baseline | Gap |
| --- | --- | --- | --- |
| E1 | Selected and current keys per row | `GitExpirationRoundRow.key` and `.current` (`server/src/services/git-expiration-round.ts:36–49`) | None. Kept as is. |
| E2 | HEAD, path, status, lifecycle generation and expiration metadata digests, before and after | Not reported. `inspectLockedGitExpirationCandidate` rereads the row (`git-workspace-expiration-inspection.ts:153`) but exposes only key and status. | Missing |
| E3 | Allocated and apparent bytes; distinct `(dev, ino)` totals apart from raw estimates | `candidateBytes` only: `allocatedBytes` sums `blocks * 512` per entry and counts each hardlink again (`git-workspace-expiration-inspection.ts:19–28`). | Missing |
| E4 | Measured expiration moves, archives and reclaimed bytes; entry-origin compaction, trash and archive counters | Not reported. A static source scan (`server/src/__tests__/git-expiration-round.test.ts:88`) proves only that two files do not name mutating adapters. | Missing. A zero written by the host would be synthetic. |
| E5 | Explicit unavailable, drift and error evidence | Rows that do not reach the lock carry `current.state = "not_read"`. Nothing else. | Missing |
| E6 | Stop partial on protected-path change, metadata or status write, and unexpected entry-origin effect | A DB write fails because sessions are read-only. A filesystem change is not detected. | Missing |

## Ownership and attribution

- **Native (this plan)** owns every observation of a selected row and of the round
  process. It makes them inside the existing source then lifecycle lock chain, with
  the existing read-only sessions, the existing Git child runner and the existing
  walk primitive. It also owns the entry mutation sentinel and the stop rules that
  use these observations.
- **Host (ai-team#484)** owns process exit and run record, systemd/cgroup evidence,
  filesystem free-space delta, server log attribution of concurrent maintenance
  (`compaction`, `compaction_trash`, `ordinary_archive` by the server,
  `external_or_unattributed_change`), restore, and reconciliation. It checks the
  native contract version and capabilities, and it does not recompute any native
  value.

Attribution boundaries in the native evidence:

- **Entry origin** means the round process. Native counters count only effects in
  that process. They say nothing about the running server.
- **Row protected state** is the set of paths and DB fields listed below for one
  row. A change found by before/after comparison has unknown origin. Native reports
  it as drift and does not attribute it.
- **Bytes** are estimates of the worktree tree of a candidate row. They are not
  reclaimed bytes, they exclude base storage (`expireBase=false`), and they are not
  a free-space delta.

## Contract identity and capabilities

All new fields belong to one contract:

```json
{ "name": "paperclip.git-expiration-evidence", "version": 1,
  "capabilities": ["row_keys.v1", "row_state.v1", "row_paths.v1", "row_head.v1",
    "row_bytes.v1", "round_bytes.v1", "entry_mutations.v1", "drift_stop.v1"] }
```

- `round_started`, `round_finished` and the stdout summary carry `evidenceContract`
  with this shape. A capability is listed only when the round actually produced
  it. `entry_mutations.v1` is listed only when the sentinel is installed (see
  below).
- `node server/dist/git-expiration-round-cli.js --print-evidence-contract` prints the
  object and exits 0. It reads no environment, opens no database, spawns no child
  and writes no file. The host `prepare` step can check the pinned native artifact
  with it before any approval.
- The consumer accepts only `name` equal to the value above, `version` equal to 1,
  and every capability it needs. A missing contract (older native artifact), a
  different version or a missing capability means the evidence is unavailable. The
  consumer then reports the round as not reconcilable and keeps `start` disabled.
  It never maps an absent field to zero.
- A later incompatible change increases `version`. A compatible addition adds a
  capability.

## Observation values

Every new observation is one of three tagged values. No other form is allowed.

```ts
type Observation<T> =
  | { state: "observed"; value: T }
  | { state: "unavailable"; reason: string }   // not attempted, for a known reason
  | { state: "error"; code: string };          // attempted and failed
```

- `reason` values: `row_not_locked`, `not_candidate`, `lock_busy`, `row_stopped`,
  `undrained`, `worktree_absent`, `rejected_before_walk`, `sentinel_not_installed`,
  `location_unresolved`, `invalid_metadata`, `checkout_budget`, `incomplete_measurement`.
- `code` values are sanitized: an errno name (`EACCES`, `ENOENT`, `ELOOP`), a Git
  exit (`git_exit_128`), `git_output`, `statement_timeout` or `invalid_output`.
  Messages, argv, URLs and environment never enter evidence.
- A digest is `sha256` hex of `"paperclip.git-expiration-evidence.v1\0" + field +
  "\0" + canonicalJson(value)`. `canonicalJson` sorts object keys recursively, has
  no whitespace, writes bigint values as decimal strings and keeps `null`. The
  field name gives domain separation. Absent values are reported with
  `present: false`, never as the digest of `null`.

## Requirement map

| Req | Native observation and source | Serialization | Consumer check | Fail-closed behavior |
| --- | --- | --- | --- | --- |
| E1 keys | Page row key (`page_selected`) and reread key under the lifecycle lock | `row_inspected.key`, `.current` (unchanged) | `row_keys.v1`; every key of `page_selected` has at most one `row_inspected` | Unchanged: key change gives rejection `workspace_changed` |
| E2 row state | Locked reread in the lifecycle transaction, before and after the row work; page snapshot as `selected` | `row_inspected.evidence.{selected,before,after}.row` | `row_state.v1` | Before/after change: stop `protected_state_changed`. Missing after for a locked, unstopped row: stop `evidence_unavailable` |
| E2 paths | `lstat` with `bigint: true` of the roles named by the native location seam `resolveProtectedLocations` for every row state, including the `checkout_container` directory with zero checkouts, fixed at before and reused for after, inside the lock chain; after `lstat` in phase B (after drain), after location set from phase B row + phase A identity | `evidence.{before,after}.paths`, `evidence.{before,after}.locationSet` | `row_paths.v1`; every required role present | Same as row state. An unresolved required role is `unavailable` and stops `evidence_unavailable`; an empty list is never an observed absence |
| E2 HEAD | One bounded Git child per side: `rev-parse --absolute-git-dir HEAD --symbolic-full-name HEAD` in the worktree; the after child runs in phase A, before drain | `evidence.{before,after}.head` | `row_head.v1` | Same as row state. Not started after a row stop: `unavailable` `row_stopped` |
| E3 row bytes | One extended walk of the candidate worktree (the existing walk, same entry budget) | `evidence.bytes`; `candidateBytes` unchanged | `row_bytes.v1` | Walk error keeps today's rejection, reports `error` and stops `evidence_unavailable`. Never zero for an unwalked tree |
| E3 round bytes | Sum of row values plus a round hardlink index | `round_finished.bytes`, stdout `bytes` | `round_bytes.v1`; `state` must be `observed` and `failedRows` 0 for full reconciliation | Index cap: stop `resource_limit` `hardlink_index`. A failed walk makes `state` `incomplete` and totals `unavailable` |
| E4 counters | Entry mutation sentinel at every native mutation site | `round_finished.entryMutations`, stdout `entryMutations` | `entry_mutations.v1`; all counts 0 and `reclaimedBytes` 0 | Any attempt: trap throws, stop `mutation_detected`, overrides every other reason |
| E5 | Tagged observations above; `drift` per row | `evidence.drift` | Consumer counts `unavailable`/`error` and shows them | See stop rules |
| E6 | Comparison of E2 before/after; sentinel | Stop reasons below | Consumer treats each as partial | Round partial, exit 3 |

## Per-row evidence

### Capture points

The lock chain from the hard-budget plan does not change. New steps are marked `+`.

```
withIsolatedRepositorySourceLock                         source lock (try-only)
  withDedicatedDbConnection → transaction                lifecycle tx
    withWorkspaceLockKeepalive
      try {
        pg_try_advisory_xact_lock(lifecycle)              unchanged
        reread row                                        unchanged
  +     before = observeBefore(tx, row)                   new hook, before eligibility
        eligibility, proof, walk (+ extended byte tally)  unchanged order
      } finally {
  +     afterIdentity = signal.aborted ? unavailable      phase A: children and reads that
                      : captureIdentity(row)              need the budget, before drain
        await budget.drain()                              unchanged (git-expiration-round.ts:208)
  +     afterRow, afterPaths, afterLocationSet            phase B: DB select + lstat only,
                      = observeAfter(tx, before, afterIdentity)  after drain, before lock release
      }
```

The after side has two phases with a hard split.

**Phase A, identity capture (before drain).** `captureIdentity` does every after step
that needs a Git child, a directory read through the shared budget, or a `realpath`:

1. The after HEAD read (one `runBoundedGit` child).
2. For a live row, the after anchor inputs: `verifiedWorktreeAdmin` of the absolute
   Git dir from step 1 (`realpath`), the checkout directory entries through
   `readBoundedDirectory`, and one bounded Git child per checkout for its branch and
   Git dir.

It runs only when `signal` is not aborted, and it checks `signal` again before each
child and each directory read. Every child goes through `runBoundedGit`, so the budget
`track`s it and the final `drain()` waits for it; `readBoundedDirectory` counts
entries in the same row budget. If the row stops before or during phase A (abort,
row deadline, entry budget, Git child or output cap), phase A starts nothing more and
its result is `unavailable` `row_stopped` for each part it did not finish. The row
keeps its native `resource_limit` or abort result. Phase A never reuses before values
as an after observation.

**Phase B, fixed reads (after drain).** `observeAfter` starts no child, reads no
directory and uses no budget:

1. Reread the row with one select in the lifecycle transaction.
2. `lstat` each role of the list fixed at `before` (same paths, same order).
3. Build the after location set (see Protected paths) only from the phase B row,
   pure native validators over its metadata, and the phase A identity. When the
   location set needs phase A identity that is `unavailable`, the after location set
   is `unavailable` `row_stopped`; it is not copied from before.

Because phase A ends before drain, a change to HEAD or a checkout after phase A is
still seen in phase B: the fixed roles include the admin `HEAD` and `index`, the
checkout container `<worktree>/<PROJECT_REPOSITORIES_DIR>`, each checkout's
`.git/HEAD` and `.git/index`, and the marker directories, and phase B `lstat`s them
after drain. A checkout added to or removed from the container after phase A
changes the container's `mtimeNs`/`ctimeNs` (and `nlink` when it stays added), so it
is drift `paths.checkout_container` even though the phase A checkout list is stale.

- `inspectLockedGitExpirationCandidate` gets an optional async `onLocked(current)`
  hook. It replaces the synchronous `observeCurrent` and runs at the same place,
  after the reread and before `isGitWorkspaceExpirationEligible`. The live expiration
  path does not pass it and is unchanged.
- The before observation runs for every row that gets both locks, also when the row
  is then rejected. Rejection paths run proof steps, so they need the same check.
- The before observation does the same reads in one pass (row reread, HEAD read,
  anchor, `lstat`; see Protected paths), right after the lock. The row signal is live at that point;
  if it is already aborted, `before` is `unavailable` `row_stopped`.
- Phase B runs also for a stopped row, while both locks are still held. It uses the
  lifecycle transaction (no new connection) and `lstat` (no child), so a stopped row
  still proves its fixed paths and row state; only its phase A parts are
  `unavailable` `row_stopped`.
  `statement_timeout` bounds the select. If the chain is not released within the
  existing 5 s drain bound, the round records the row with
  `after: unavailable "undrained"`, as it already records `drainIncomplete`.
- Rows that never take the locks (`not_candidate`, `missing_source_issue`,
  `lock_busy`) carry `before` and `after` as `unavailable` with the matching reason.
  `selected` is always observed, because the page row is in memory.

### Row state

Value of a row observation:

```ts
{ key: { updatedAt, id }, status, closedAtPresent: boolean,
  lifecycleGeneration: { present: boolean; value: number | null },
  digests: { status, protectedColumns, metadata, gitCacheExpiration, gitCacheRestoration } }
```

- `protectedColumns` covers `status`, `closedAt`, `cleanupEligibleAt`, `cwd`,
  `providerRef`, `updatedAt` and `metadata`. Any write to the row changes it.
- `gitCacheExpiration` and `gitCacheRestoration` digest the metadata keys of the same
  names, with `present: false` when absent. `lifecycleGeneration` is the raw number
  from `metadata.lifecycleGeneration`.
- `selected` uses the page row. A `selected` to `before` difference is the existing
  concurrent-change case. It stays a recorded drift signal with today's outcome
  (`workspace_changed` when the key differs), not a stop, as the design requires.

### Protected paths

A live row has no `gitCacheRestoration`, and `gitCacheExpirationLockLocations`
returns `[]` for every row without an owned, uncompleted expiration lock token
(`git-workspace-restoration.ts:423–432`). Neither can name the protected set alone.
The plan therefore adds one read-only native location seam. An empty list never
stands for an observed absence.

**Seam.** Two parts, both native:

1. `gitExpirationMarkerLocations(anchor)` in `git-workspace-restoration.ts`. It is
   the body of `gitCacheExpirationLockLocations` from line 431 on, extracted with no
   change: the same `index.lock`, `HEAD.lock` and `refs/heads/<branch>.lock` names,
   the same branch-name validation, and the same nested checkout rules. Its input is
   an anchor `{ sourcePath, worktreePath, worktreeAdmin, branchName, checkouts }`
   instead of the validated metadata. `gitCacheExpirationLockLocations` keeps its
   ownership gate (state, recipe, `lockToken`, `!completed`) and then calls the
   extracted function, so acquire and recover get the same list as today. The
   extraction gives no new acquire, recover or remove path.
2. `resolveProtectedLocations(workspace, signal)` in the new evidence module. It
   builds the anchor for every row state from the reread row and read-only reads,
   with no dependence on lock ownership. It calls the native validators that already
   exist (`readGitCacheRestoration`, `readGitCacheExpiration`,
   `recordedIsolatedRemoteSource`, and `managedSourcePaths`, which is exported with
   no change) and the worktree admin check that is extracted, with no change, from
   `git-workspace-expiration.ts:87–91` into `verifiedWorktreeAdmin(sourcePath, rawAdmin)`
   for both callers. It does not copy eligibility, proof or source-ownership logic:
   it names paths, it does not decide whether they are owned.

**Anchor per row state.**

| Anchor field | Pending row (`gitCacheExpiration` present) | Live row (no restoration) |
| --- | --- | --- |
| `worktreePath` | `gitCacheRestoration.worktreePath` | `cwd` (equal to `providerRef` when set) |
| `sourcePath` | `gitCacheRestoration.sourcePath` | `recordedIsolatedRemoteSource(workspace)` when recorded; else every path of `managedSourcePaths(workspace)` (two candidates), each as its own role |
| `worktreeAdmin` | `gitCacheExpiration.worktreeAdmin` (recorded and validated; independent of the worktree) | `verifiedWorktreeAdmin` of the absolute Git dir from the before HEAD read, which must resolve under one source candidate |
| `branchName` | `gitCacheRestoration.branchName` | `branchName` column |
| `checkouts` | `gitCacheRestoration.contents.checkouts` | Directory entries of `<worktree>/<PROJECT_REPOSITORIES_DIR>`, read with `readBoundedDirectory` (shared entry budget), at most `CHECKOUT_LIMIT` (50, `git-workspace-contents.ts:17`, exported with no change); branch and Git dir of each from one bounded Git child (`rev-parse --absolute-git-dir --symbolic-full-name HEAD`) under the child gate |
| Anchor inputs needing a child, a budgeted directory read or `realpath` | None: `readGitCacheRestoration`, `readGitCacheExpiration` and the trash rule are synchronous parsers of the row metadata | `worktreeAdmin` (HEAD read + `realpath`), `checkouts` (directory read + Git children); captured in phase A only |

A row that has an existing `gitCacheRestoration` but no expiration state uses the
live-row column. Its recorded `sourcePath` is added as one more `source` role.

The before observation runs in this order: row reread, HEAD read, anchor, then
`lstat` of every role. After splits the same steps into phase A (HEAD read and the
live anchor inputs, before drain) and phase B (row reread, `lstat` of the fixed
roles, location set, after drain); see capture points.

**Roles.** All roles are required. The list is fixed at `before` and reused for
`after`; phase B never adds or removes a role. The location set is the digest of the
anchor (`sourcePath` candidates, `worktreePath`, `worktreeAdmin`, `branchName`,
checkout names, branches and Git dirs). `before.locationSet` comes from the before
anchor. `after.locationSet` is built in phase B from:

- a pending row: the phase B row metadata only, through the same synchronous
  validators (no filesystem read);
- a live row: the phase B row columns (`cwd`, `providerRef`, `branchName`, recorded
  isolated source) plus the phase A identity (`worktreeAdmin`, checkout list with
  branches and Git dirs).

A different digest is drift `paths.locationSet`, so a changed admin path, source or
checkout branch is reported, not a silent new list. When phase A did not finish,
`after.locationSet` is `unavailable` `row_stopped`.

| Role | Path |
| --- | --- |
| `worktree`, `worktree_git_link` | `worktreePath`, `<worktreePath>/.git` |
| `source`, `source_git` | Each source path and its `.git` |
| `worktree_admin`, `gitdir_head`, `gitdir_index` | `worktreeAdmin`, and `HEAD` and `index` under it |
| `worktree_trash`, `base_trash` | `gitCacheExpiration` trash paths; for a live row only `worktree_trash`, at the next generation, derived by the same `path.join` rule as `git-workspace-expiration.ts:93`, extracted with no change |
| `expiration_lock_marker` | Each location of `gitExpirationMarkerLocations(anchor)` |
| `expiration_lock_marker_dir` | The parent directory of each marker, so a marker that appears and goes again inside the window still changes `mtimeNs`/`ctimeNs` |
| `checkout_container` | `<worktree>/<PROJECT_REPOSITORIES_DIR>` itself, always listed, also with zero checkouts and when it does not exist (then observed `present: false`), so a checkout added or removed after the checkout list was read is still seen |
| `checkout_root` | Each `<worktree>/<PROJECT_REPOSITORIES_DIR>/<name>` |
| `checkout_head`, `checkout_index` | `HEAD` and `index` under each checkout's Git dir from the before anchor (for a pending row `<checkout_root>/.git`, as in the lock locations), so a branch switch after phase A is still seen by phase B |

Each entry reports `role`, `pathDigest` and an observation whose value is
`{ present: false }` on `ENOENT` or `{ present: true, statDigest, type }`, where
`statDigest` covers `dev`, `ino`, `mode`, `uid`, `gid`, `nlink`, `size`, `mtimeNs`
and `ctimeNs`. Raw paths are not written; the journal already has workspace IDs and
the host has the private manifest.

**Unresolved roles.** When the seam cannot name a required path, the role is still
listed, with `unavailable` and one of these reasons: `location_unresolved` (no
source candidate, admin outside every candidate, before HEAD read failed),
`invalid_metadata` (a native validator threw), `checkout_budget` (more checkouts than
the native limit). Each one is a not-`observed` before observation and stops the
round `evidence_unavailable` (see stop rules). For a pending row whose worktree is
gone, the anchor comes only from metadata, so `worktree_admin`, `gitdir_*`, `source`
and markers stay observed, and `worktree` and `checkout_container` are observed
`present: false`. The container path depends only on `worktreePath`, so it is
`location_unresolved` only when `worktreePath` is.

### HEAD

One Git child through `runBoundedGit`, so the child gate, output cap, row deadline,
`GIT_OPTIONAL_LOCKS=0` and process-group drain all apply. Value:
`{ commit, refDigest, gitDirDigest }`. A detached HEAD gives `refDigest` of `"HEAD"`.
A missing worktree gives `unavailable` `worktree_absent`. A non-zero exit gives
`error` `git_exit_<n>`. The command is not copied from proof logic: it only reads
identity for the comparison.

### Drift

```ts
drift: { state: "none" }
     | { state: "changed"; fields: string[] }     // e.g. "row.metadata", "paths.gitdir_index", "head.commit"
     | { state: "unknown"; missing: string[] }
selectionDrift: { state: "none" } | { state: "changed"; fields: string[] }
```

`drift` compares `before` and `after`. `selectionDrift` compares `selected` and
`before`.

## Bytes

### Row

The existing walk in `inspectLockedGitExpirationCandidate` becomes
`measureWorktree(root, signal)` in `git-workspace-expiration-inspection.ts`. It walks
the same entries in the same order through `readBoundedDirectory`, so the shared
100,000-entry budget and abort checks do not change. `allocatedBytes` stays as a
wrapper that returns `rawAllocated`, so live expiration callers get the same number.

Per entry it reads `lstat(path, { bigint: true })` and adds:

| Field | Rule |
| --- | --- |
| `rawAllocated` | `blocks * 512` for every entry, hardlinks counted per path. Equal to today's `candidateBytes`. |
| `rawApparent` | `size` of regular files and symlinks, per path. Directory sizes are excluded because they depend on the filesystem. |
| `uniqueAllocated`, `uniqueApparent` | Same rules, each non-directory inode counted once per row by `(dev, ino)` |
| `entries`, `directories`, `distinctInodes`, `hardlinkedInodes` | Counts. A non-directory with `nlink > 1` goes into the row index. Directories cannot be hardlinked and count once. |
| `sparseEntries` | Regular files with `blocks * 512 < size` |

- A pending row whose worktree is absent reports `{ state: "observed", value:
  { present: false } }` and no byte fields. Today's `candidateBytes = 0` for that
  case stays for compatibility; the evidence makes the absence explicit.
- An `EACCES`, `ELOOP` or unsupported entry keeps today's native outcome (the walk
  throws, the row is rejected) and reports `bytes: error <code>`. The walk was
  attempted and failed, so this is a failed measurement, not a legitimate absence:
  it stops the round `partial` `evidence_unavailable` (see stop rules) and counts in
  the round `failedRows`.
- Rows rejected before the walk report `unavailable` `rejected_before_walk`. This is
  a legitimate rejection: no stop, and the row is outside the byte denominator.
- A budget hit or abort during the walk keeps today's `resource_limit` or stop and
  reports `unavailable` `row_stopped`. The round is already partial.

The three cases are told apart by the tag: observed `present: false` (absent
worktree, no stop), `unavailable` `rejected_before_walk` (no stop), and `error`
(walk attempted, stop).

### Round

`round_finished.bytes` and stdout `bytes`:

```ts
{ state: "observed" | "incomplete",
  candidateRows, attemptedRows, measuredRows, failedRows, unavailableRows,
  raw: Observation<{ allocated, apparent }>,                  // sum of row raw values
  unique: Observation<{ allocated, apparent, distinctInodes }>, // over all measured rows
  measuredSubset: { raw: { allocated, apparent }, unique: { allocated, apparent, distinctInodes } },
  hardlinkIndex: { entries, limit } }
```

- `attemptedRows` counts every row whose walk started, whatever its final outcome
  (candidate or rejected). `failedRows` counts rows with `bytes` `error`. A
  rejected row with a failed walk stays in `attemptedRows` and `failedRows`; it does
  not leave the denominator.
- `raw` and `unique` are `observed` only when `state` is `observed`. Otherwise both
  are `unavailable` `incomplete_measurement`. `measuredSubset` keeps the sums of the
  rows that were measured, for diagnosis only; the consumer never reads it as a
  total.

- `unique` across rows uses a round index of `(dev, ino)` for non-directory inodes
  with `nlink > 1`. Inodes with `nlink = 1` are unique without an index. Overlapping
  worktree paths cannot both be candidates, because eligibility rejects nested
  `cwd`.
- The round index has a fixed limit of 250,000 keys (about 30 MiB, inside
  `MemoryMax=512M`). Reaching it stops the round `partial` with `resource_limit`
  `hardlink_index`. This is a new stricter evidence budget. It relaxes no approved
  value, and it is listed in `budgets` so the host can match it with its manifest.
- `state` is `incomplete` when `failedRows > 0`, or when a candidate row has no
  observed bytes. The consumer then reports bytes as incomplete and rejects full
  reconciliation. `raw` and `unique` never mix: there is no combined total.

## Entry mutation sentinel

### Module

New leaf module `server/src/services/git-expiration-mutation-sentinel.ts` with no
imports from the round, the DB or other services:

- `installEntryMutationSentinel()` installs one process-wide ledger. A second install
  throws. It returns `{ snapshot(), uninstall() }`; `uninstall` exists for tests.
- `noteEntryMutation(kind)` does nothing when no ledger is installed. With a ledger it
  increments `attempts[kind]` and throws `GitExpirationMutationTrap(kind)` before the
  mutation starts.
- `reclaimedBytes` is incremented only by an instrumented reclaim site after its
  removal completes. With the trap at the top of the site, it stays 0 in the round
  process; it is a measured value, not an assumed one.

The ledger is process-wide, not `AsyncLocalStorage`, so a detached or swallowed path
(for example `purgeStaleWorkspaceCompactionTrash` with `.catch(() => {})`) still
counts. The round reads `snapshot()` at the end of every row and at the end of the
round. A count above zero stops the round even when the throw was caught somewhere.

Only the fixed CLI installs the sentinel, in its main-module branch, before it calls
the round. `inspectGitExpirationRound` never installs it, so a library caller in the
server process cannot trap the server's own maintenance. Without a ledger the round
reports `entryMutations: unavailable "sentinel_not_installed"` and omits
`entry_mutations.v1`, and the consumer fails closed.

### Sites

| Kind | Site |
| --- | --- |
| `expiration_archive` | `expireReconstructableGitWorkspace` status update to `archived` (`git-workspace-expiration.ts:98`) |
| `expiration_metadata_write` | Same function, metadata updates (`:105`, `:137`) |
| `expiration_move` | Same function, `fs.rename` of worktree and source (`:141`, `:159`) |
| `expiration_reclaim` | Same function, `fs.rm` of base trash (`:166`); `finishGitCacheTrash` (`git-workspace-restoration.ts:457`) |
| `expiration_lock_marker` | Acquire and recover functions in `git-workspace-expiration-locks.ts`; `recoverGitCacheExpirationLocks` |
| `restoration` | `restoreGitCacheBase`, `ensureSavedGitCommit` (`git-workspace-restoration.ts`) |
| `compaction_move`, `compaction_restore` | `moveWorkspaceDirsToTrash`, `restoreWorkspaceDirsFromTrash` (`workspace-compaction.ts`) |
| `compaction_trash` | `deleteWorkspaceCompactionTrash`, `purgeStaleWorkspaceCompactionTrash` (`workspace-compaction.ts`) |
| `ordinary_archive` | `archiveWorkspaceUnderLifecycleLock` and the terminal sweep archive update (`execution-workspaces.ts`) |
| `terminal_cleanup` | `cleanupTerminalWorkspace`, `compactTerminalWorkspace` (`execution-workspaces.ts`) |
| `reopen_state_clear` | `clearReopenPendingConsumptionForUnconsumedReopen` (`execution-workspaces.ts`) |

Each site gets one `noteEntryMutation(kind)` call as its first statement. No
signature changes, no new imports of the round into these modules, and no new
mutation reachable from the round. The source-scan test from PR #48 stays and
adds the new evidence module.

Shared-change note (module-boundaries rule): the capability is a measured
entry-origin counter. Existing contracts are not enough, because a source scan is a
static claim and the host cannot count calls inside the native process. The
affected consumers are the live expiration, compaction, terminal sweep and reopen
paths. With no ledger installed (every server process) the call is a no-op and
their behavior and tests are unchanged.

### Summary fields

```ts
entryMutations: Observation<{
  sites: string[];                       // instrumented site ids, fixed list
  attempts: Record<Kind, number>;        // every kind present, also when 0
  expirationMoves: number;               // = attempts.expiration_move
  expirationArchives: number;            // = attempts.expiration_archive
  reclaimedBytes: number;
}>
```

The consumer requires `observed`, every kind present, all counts 0 and
`reclaimedBytes` 0. The design's runner compaction, trash and archive counts are
`compaction_move + compaction_restore`, `compaction_trash` and
`ordinary_archive + terminal_cleanup`. Server-side events of the same families stay
with the host's log attribution.

## Stop rules

New stop reasons. All give `partial` and exit 3.

| Reason | Trigger | When |
| --- | --- | --- |
| `mutation_detected` | Any sentinel attempt | After the row in which it happened, and again at round end |
| `protected_state_changed` | Row `drift.state = "changed"` | After the row is recorded |
| `evidence_unavailable` | A row that got both locks and was not stopped has a before or after observation that is not `observed` (including an unresolved protected-path role), except `worktree_absent`; or its `bytes` is `error`, also when the row outcome is a rejection | After the row is recorded |

- `mutation_detected` overrides every other stop reason in the summary and in the
  final `round_finished`. The earlier reason is kept as `supersededStopReason`.
  Other reasons keep today's first-wins rule.
- The row is recorded with its native outcome. Native eligibility and proof results
  do not change. A `candidate` row with drift stays `candidate` in `outcome`, and the
  round is partial, so the consumer cannot count it as complete.
- `complete` still needs `exhausted`, no stop reason and `inspected == selected`. In
  addition it needs zero sentinel attempts, `drift.state = "none"` for every locked
  row, round `bytes.state = "observed"` (so `failedRows = 0`) and an installed
  sentinel. A library round without a sentinel can still be
  `complete` (tests), but it omits `entry_mutations.v1`, and the consumer rejects
  it.

## Preserved invariants

- **Journal order.** `round_started`, `page_selected` before its rows, one
  `row_inspected` per completed row, then `round_finished` and `round_committed`.
  Row evidence is inside `row_inspected`; there is no separate record that could be
  lost alone. `readGitExpirationRoundJournal` keeps its rules.
- **Accounting.** `lastCompletedKey` still advances only after the durable
  `row_inspected`. `selected`, `inspected` and `lastSelectedKey` are unchanged.
- **Exit 3 first.** Exit codes do not change. A consumer reads the exit code or run
  record first. With exit 3, a journal that reads complete (for example a
  `round_committed` whose sync and truncation both failed) is stale and is used only
  to list rows of a partial round. The stdout summary carries `evidenceContract`,
  `bytes` and `entryMutations` so the authoritative partial result has them.
- **Locks.** Source then lifecycle, try-only. No new lock, no new connection. All
  after observations finish before the lock chain unwinds.
- **Abort and drain.** No new Git child or budgeted directory read starts after the
  row signal aborts. All after work that needs one runs in phase A, before the final
  `drain()`, and is tracked by the row budget; after drain only the one select and
  `lstat` of fixed roles run, bounded by the drain bound and `statement_timeout`.
  The undrained hold is unchanged.
- **Budgets.** Before and after HEAD reads use the Git child gate, the output cap and
  the row deadline. The byte tally uses the same walk and entry counter. No budget
  value changes. The only addition is `hardlink_index`.
- **Writes.** Evidence reads are `lstat`, `opendir` and read-only Git. Scratch stays
  the only write target, and the sentinel blocks every instrumented mutation.

### Evidence size

A `row_inspected` record grows from about 0.4 KiB to about 3 KiB (about 30 digests,
the path list, bytes and drift). 10,000 rows use about 30 MiB, below the 64 MiB
budget minus the 64 KiB terminal reserve. The existing evidence budget still applies:
a near-full journal stops `resource_limit` `evidence`, never a truncated record.

## Files and seams

| File | Change |
| --- | --- |
| `server/src/services/git-expiration-evidence.ts` (new) | Contract constant, `Observation`, canonical digest, `observeRowState(tx, row)`, `resolveProtectedLocations(workspace, signal)`, `observeProtectedPaths(roles)`, `observeHead(worktree)` via `runBoundedGit`, `ByteTally`, `RoundHardlinkIndex` |
| `server/src/services/git-expiration-mutation-sentinel.ts` (new) | Ledger, kinds, `noteEntryMutation`, trap error |
| `server/src/services/git-workspace-expiration-inspection.ts` | `onLocked` async hook; `measureWorktree`; `allocatedBytes` wraps it |
| `server/src/services/git-expiration-round.ts` | Capture points, row `evidence`, summary `bytes`, `entryMutations`, `evidenceContract`, new stop reasons and precedence |
| `server/src/services/git-expiration-budget.ts` | `hardlinkIndexKeys: 250_000` in `GIT_EXPIRATION_BUDGETS` |
| `server/src/git-expiration-round-cli.ts` | Install sentinel at start; `--print-evidence-contract` |
| `server/src/services/git-workspace-restoration.ts` | Extract `gitExpirationMarkerLocations(anchor)` from `gitCacheExpirationLockLocations` (gate kept, same output); export `managedSourcePaths` unchanged |
| `server/src/services/git-workspace-expiration.ts` | Extract `verifiedWorktreeAdmin` and the worktree trash path rule; the expiration path calls them with the same result |
| `server/src/services/git-workspace-contents.ts` | Export `CHECKOUT_LIMIT` unchanged |
| Sentinel sites | `git-workspace-expiration.ts`, `git-workspace-restoration.ts`, `git-workspace-expiration-locks.ts`, `workspace-compaction.ts`, `execution-workspaces.ts`: one call each, no other change |
| `docs/deploy/git-expiration-round.md` | Evidence contract, fields, stop reasons, consumer rules |

No schema, migration, route, UI or shared package change.

## Out of scope

- Host consumer, reconciliation, attribution of server events, restore and public
  `start` (ai-team#484).
- Any change to eligibility, proof, cursor, upper bound, lock keys, budgets other than
  `hardlink_index`, or completion rules other than the additions above.
- Base storage bytes and free-space delta.

## Tests

All tests use embedded Postgres, temporary directories and synthetic repositories.
They run through `inspectGitExpirationRound` or `runGitExpirationRoundCli`, not only
through helpers. Sentinel tests run the CLI in a child process, or install and
uninstall the ledger in a dedicated test file.

| Area | Cases | Pass criterion |
| --- | --- | --- |
| Contract | `--print-evidence-contract` with no env and no DB; normal round | Exit 0, no file or connection; same object in `round_started`, `round_finished` and stdout; capabilities match what ran |
| Missing evidence | Library round without sentinel; row that is `not_candidate`, `lock_busy` or missing source issue | `entryMutations` `unavailable sentinel_not_installed` and no `entry_mutations.v1`; row `before`/`after` `unavailable` with the right reason; no field is 0 in place of an observation |
| Partial evidence | HEAD read fails after the lock (fake `git` exits 128 on the identity command only); after `lstat` fails with `EACCES` | Row recorded with `error` codes; round `partial` `evidence_unavailable`; exit 3 |
| Drift | Between before and after: a test session updates `metadata` on the lifecycle-locked row through a non-locking path; touch the worktree `index`; move `HEAD` with a fake `git` hook in a proof step; create an expiration lock marker | `drift.changed` names the field; round `partial` `protected_state_changed`; row outcome unchanged |
| Selection drift | Metadata changed after selection with the same `updatedAt`; key changed | `selectionDrift.changed`; no stop for the first; `workspace_changed` for the second, as today |
| Hardlinks | Two hardlinks to one file in a row; one inode shared by two candidate rows; index at 249,999, 250,000, 250,001 keys (injected limit) | Row `raw` counts both, `unique` once; round `unique` once across rows; limit + 1 stops `resource_limit` `hardlink_index` |
| Sparse | A 64 MiB sparse file with 4 KiB written | `rawApparent` ≥ 64 MiB, `rawAllocated` small, `sparseEntries` 1 |
| Inaccessible | Directory mode 000 inside the worktree, and a symlink loop, on a row whose protected root, HEAD and DB reads succeed (test skipped when it runs as root) | Row outcome rejected as today; `bytes` `error EACCES` / `ELOOP`; round `partial` `evidence_unavailable`, exit 3; round `bytes.state` `incomplete`, `attemptedRows` and `failedRows` 1, `raw` and `unique` `unavailable incomplete_measurement`; no `observed` 0 for the row or the round |
| Rejected before walk | Row rejected by eligibility or proof before the walk | `bytes` `unavailable rejected_before_walk`; no stop from bytes; row not in `attemptedRows` |
| Absent worktree | Pending row with worktree gone and its admin dir still present | `bytes` observed `present: false`; HEAD `worktree_absent`; `worktree` observed `present: false`; `worktree_admin`, `gitdir_*`, `source` and marker roles observed from the recorded metadata; no `evidence_unavailable` stop. Variant: admin dir removed or replaced between before and after gives `drift.changed` `paths.worktree_admin` and stop `protected_state_changed` |
| Live protected paths | Live row with no `gitCacheRestoration`, managed-project source and isolated-remote source; one nested checkout | Roles `source`, `worktree_admin`, `gitdir_*`, `expiration_lock_marker` (admin `index.lock`/`HEAD.lock`, source branch lock, checkout locks) `checkout_container` and `checkout_root` all listed and observed; no role missing. Variant with no `<PROJECT_REPOSITORIES_DIR>`: `checkout_container` listed and observed `present: false`, no `checkout_root` |
| Marker creation | Live row and pending row without `lockToken`: create, and separately create then remove, an `index.lock` and a branch `.lock` at a marker location between before and after | `drift.changed` names `paths.expiration_lock_marker` or `paths.expiration_lock_marker_dir`; stop `protected_state_changed` |
| Admin path change | Live row whose `.git` link is changed to point at another admin dir between before and after | `drift.changed` names `paths.locationSet` or `head.gitDir`; stop `protected_state_changed` |
| Unresolved paths | Live row whose Git dir is outside every source candidate; pending row with invalid `gitCacheExpiration`; more than `CHECKOUT_LIMIT` checkout entries | Roles listed with `unavailable` `location_unresolved` / `invalid_metadata` / `checkout_budget`; stop `evidence_unavailable`, exit 3; never an empty role list |
| Lock location parity | Existing lock acquire and recover tests | `gitCacheExpirationLockLocations` returns the same list as before the extraction |
| Budget | Entry budget hit, row deadline and Git output cap during the walk and during the after HEAD read | Existing `resource_limit` reasons; `after.head` `unavailable row_stopped`; after row and paths still observed after drain |
| Nested checkout, stop before after anchor | Live row with one nested checkout; separately: (a) abort the round, (b) exhaust the entry budget, (c) hit the Git child cap, each after the walk and before phase A; and (d) abort inside phase A between the HEAD child and the checkout child. A spawn hook records every child start with a timestamp | No child and no `readBoundedDirectory` call after the abort or budget hit, and none after the final `drain()` returns (spawn log vs drain timestamp); `after.head`, the live anchor inputs and `after.locationSet` `unavailable row_stopped`, never equal to the before values; phase B row and fixed-role paths observed; row keeps native `resource_limit` or abort and round `partial`/`aborted`, exit 3; locks released within the drain bound, or `after` `undrained` with the existing hold when a child is held past it |
| Nested checkout change | Successful live row with one nested checkout: (a) switch the checkout branch from a proof-step hook (before phase A); (b) replace the checkout `.git` with one that points at another Git dir (before phase A); (c) switch the checkout branch from a hook that runs after phase A and before drain | (a) `drift.changed` names `paths.locationSet` and `paths.checkout_head`; (b) names `paths.locationSet`; (c) names `paths.checkout_head` from the phase B `lstat`; all stop `protected_state_changed`, `partial`, exit 3; row outcome unchanged; no child after drain |
| Checkout container change | Successful live row with one nested checkout; variants with an empty container and with no container. From a hook that runs after phase A and before drain: (a) add a checkout to the container; (b) add a checkout and remove it again; (c) for the no-container variant, create the container with one checkout. Each hook first waits at least 10 ms after the before `lstat` so the coarse kernel timestamp moves, and the test never sets timestamps itself | All three: `drift.changed` names `paths.checkout_container`; stop `protected_state_changed`, `partial`, exit 3; row outcome unchanged; `after.locationSet` built from the phase A list, not re-read; no child and no directory read after the final `drain()` returns (spawn and read log vs drain timestamp); locks released within the drain bound |
| Abort | Abort during proof and during the before HEAD read; abort with undrained row | No new child after abort; locks held until drain; phase A parts `unavailable row_stopped`; `after` `undrained` when the bound is passed; round `aborted` |
| Lock | Busy source lock; busy lifecycle lock | `lock_busy` with `unavailable lock_busy` evidence; no observation taken without both locks |
| Mutation traps | Install sentinel, then call each instrumented site from a test seam inside a row; also from a detached promise whose error is swallowed | Trap thrown before any filesystem or DB effect (checked by `lstat` and row select); `attempts[kind]` 1; round `mutation_detected`, overriding an earlier `lock_busy` or `resource_limit`, with `supersededStopReason` set |
| Live paths | Existing `git-workspace-expiration*.test.ts`, compaction tests, terminal sweep tests, `git-expiration-auth-fallback.test.ts`, without sentinel | Pass unchanged; `allocatedBytes` returns the same values |
| Exit 3 | CLI with a `round_committed` whose sync and truncation fail | `readGitExpirationRoundJournal` reads complete; CLI exits 3 and stdout says `partial` `evidence_lost` with the evidence fields |
| Journal | Normal multi-page round (0, 1, 50, 51 rows); evidence near the 64 MiB limit | Event order unchanged; one `row_inspected` per row; evidence budget stop as today |
| Read-only | Existing source scan and session write traps | Still no writes; scan extended to the evidence module |

## Delivery

Issue #85 implements this plan. It touches two guarantee classes: evidence
observation and mutation detection. If the core logic grows beyond about 400 lines,
split it into PRs in this order:

1. Contract, observation types, row state, the protected location seam, paths, HEAD,
   drift stop and CLI contract flag (E1, E2, E5, part of E6).
2. Byte tally, round hardlink index and the byte-error stop (E3).
3. Entry mutation sentinel, its sites and `mutation_detected` (E4, rest of E6).

Each slice gets its own independent review. The host consumer (ai-team#484) checks
for all capabilities, so a partial native delivery keeps `start` disabled.
