---
title: Git Expiration Inspection Round
summary: Read-only, one-round inspection of Git workspace expiration candidates
---

The inspection round checks Git workspace expiration once. It reports which workspaces the native expiration would accept, the bytes it would reclaim and every rejection. It does not archive, compact, move or delete anything.

Use it before you enable Git workspace expiration, or when you need evidence about the current candidates.

## Run a round

```sh
DATABASE_URL=postgres://... node server/dist/git-expiration-round-cli.js \
  --round-id 2026-10-27-a \
  --evidence-dir /var/lib/paperclip/expiration-rounds/2026-10-27-a \
  [--company-id <uuid>] [--max-rows <n>] [--deadline-seconds <n>]
```

| Argument | Meaning |
| --- | --- |
| `--round-id` | Identifier of the round. Use 1 to 64 characters from `A-Z a-z 0-9 . _ -`. |
| `--evidence-dir` | Normalized absolute path. The round creates this directory. The directory must not exist. |
| `--company-id` | Optional. Limit the round to one company. |
| `--max-rows` | Optional. 1 to 10,000. The round selects at most this number of rows. Without the flag the cap is 10,000. A larger value exits `2` before the database opens. |
| `--deadline-seconds` | Optional. 1 to 600. Stop when this time is over. Without the flag the deadline is 600 s. A larger value exits `2`. The host timer stays authoritative. |
| `--enabled=true`, `--dry-run=true`, `--expire-base=false` | Optional. The round accepts only these values. |

The round reads the database URL from `DATABASE_URL`. It rejects these environment values before it opens the database:

- `PAPERCLIP_GIT_CACHE_EXPIRATION_ENABLED` with a value other than `true`
- `PAPERCLIP_GIT_CACHE_EXPIRATION_DRY_RUN` with a value other than `true`
- `PAPERCLIP_GIT_BASE_EXPIRATION_ENABLED` with a value other than `false`

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | The round is complete. |
| `3` | The round is partial. |
| `2` | The arguments or the environment are not correct. The round did not start. |
| `1` | The round failed. |

`SIGINT` and `SIGTERM` stop the round. The round ends partial. It ends its connection pool at once, also when a query is in progress. The row in progress keeps its source and lifecycle locks until its Git children and database work have stopped: each Git child runs in its own process group, gets `SIGTERM` and, after 2 s, `SIGKILL`, and counts as stopped only when the whole group is gone.

If the row has not stopped 5 s after the stop, the summary has `drainIncomplete: true` and `undrainedRow` set to its key, and the journal already ends with `round_finished` `partial`. The CLI then writes the stdout summary, closes the journal and keeps running with both locks held. Further `SIGINT` or `SIGTERM` signals do not end it. It exits `3` once the row releases its locks, or ends when the host kills it (`TimeoutStopSec` or `RuntimeMaxSec`).

## What the round does

1. It reads the database time once. This time is the `upperBound` of the round.
2. It selects the workspaces that the recurring sweep gives to Git expiration, in pages of 50. The order is `(updatedAt, id)`. It selects only rows with `updatedAt <= upperBound`.
3. It records the keys of each page before it inspects the rows of that page.
4. For each Git expiration candidate, it takes the source lock and the lifecycle lock without waiting. It reads the row again and checks eligibility and reconstruction.
5. It records the result of each row.
6. Only an empty page or a short page ends the selection.

The round uses its own cursor. It does not use or change the cursor of the recurring sweep. It does not start a second rotation.

## Safety

- All database sessions of the round are read-only (`default_transaction_read_only=on`). A write attempt fails and stops the round.
- Remote proof uses only the `GITHUB_TOKEN` or `GH_TOKEN` server environment credentials. The round does not read company secrets or managed connections, and it does not refresh OAuth grants.
- Git commands of the round use `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `gc.auto=0`, `maintenance.auto=false` and `core.fsmonitor=false`. Each Git child may write at most 16 MiB to stdout and stderr together, and a row runs at most one Git child at a time. A Git timeout, the output cap and a group member left after the leader exits record the row as `resource_limit` at once (`git_timeout`, `git_output`, `git_group_survivor`); the locks stay held until the group is gone, as for a stop signal. A full scratch disk or quota (`ENOSPC`, `EDQUOT`) stops the round with `resource_limit` instead of rejecting the row. Remote proof fetches into a temporary repository and removes it.
- Each row has 60 s from the moment the round starts it. The time covers the source lock, the lifecycle transaction, eligibility, remote proof, the directory walks and the trash checks. A Git child gets the smaller of its own timeout and the time the row has left. When the 60 s are over, the row is recorded as `resource_limit` `row_deadline` and the round stops `partial`. A row deadline does not abort the round; the locks stay held until the row has drained, as for a stop signal.
- The round selects at most 10,000 rows (or `--max-rows`) and runs at most 200 full pages. A page asks only for the rows left under the cap, so no selected key beyond the cap is recorded. When the cap or the page budget is reached, the round runs one exhaustion query with the same filter and cursor and `limit 1`, and records `selection_exhaustion_checked` with `more`. If no row is left, the selection is exhausted. Otherwise the round stops `partial` with `row_budget` after it inspects the selected rows.
- Every statement of the round has `statement_timeout=10s`, and a connect has 10 s. A statement timeout (SQLSTATE `57014`, `canceling statement due to statement timeout`) stops the round `partial` with `resource_limit` and `budgetHit.budget` `statement_timeout`. In a row it records the row as `resource_limit` `statement_timeout`. Any other `57014`, for example a cancel by an operator, stays `database_error`.
- The round uses at most 4 database connections: the pool of 2 and one dedicated connection each for the source lock and the lifecycle lock. Dedicated connections use the round application name, `paperclip-git-expiration-round`. A fifth connection is refused with `db_connections` before it connects.
- The CLI journal refuses a non-terminal event that would leave less than 64 KiB below 64 MiB. The round then stops `partial` with `resource_limit` and `budgetHit.budget` `evidence`, and writes `round_finished` into the reserve. If a write fails (`EFBIG`, `ENOSPC`, `EDQUOT` or another error), the round ends with `evidence_lost`.
- All directory walks of one row share one counter of 100,000 entries: the size walk of the worktree, the search for regenerable directories, the walk of the base Git storage and the reads of single Git directories. Directories are read in batches. The 100,001st entry records the row as `resource_limit` `walker_entries` and the round stops `partial`. A walk never turns a budget hit or an abort into a rejection.

## Evidence

The round writes `events.jsonl` in the evidence directory. Each line is one event. The round syncs each event to disk before it continues.

| Event | Content |
| --- | --- |
| `round_started` | Round identifier, `upperBound`, mode, page size, limits, the fixed `budgets` and `scratchDir` |
| `page_selected` | Page number and selected keys |
| `selection_exhaustion_checked` | `more`: whether a row is left after the cap. No key is recorded. |
| `row_inspected` | Selected key, current row, workspace, outcome, reason and candidate bytes |
| `round_finished` | Summary. `status` is `partial` or `pending_commit`. It includes `fullPages`, `exhaustionChecked`, `budgetHit` (`budget`, `scope` `row` or `round`, `limit`, `observed`, or `null`), `peaks` (`rowMs`, `rowEntries`, `childOutputBytes`, `dbClients`, `gitChildren`, `journalBytes`), `drainIncomplete` and `undrainedRow`. The stdout summary has the same fields. |
| `round_committed` | Round identifier and status `complete` |

`current` in `row_inspected` is the row that the round read again under the lifecycle lock:

| `current.state` | Meaning |
| --- | --- |
| `read` | `current.key` and `current.status` are the values read under the lock. A key that is not the selected key gives `rejected` with `workspace_changed`. |
| `missing` | The row no longer exists. |
| `not_read` | The round did not read the row again, for example because the row is not a candidate or a lock is busy. |

### Read the result

A complete round ends with two records: a `round_finished` with status `pending_commit`, then a `round_committed`. No other record says `complete`.

The commit record alone decides `complete`:

- The round is complete when `round_committed` is written and its sync succeeds.
- If the write or the sync of `round_committed` fails, the round is partial with `evidence_lost`.
- An abort or the deadline stops the round only before the round starts to write `round_committed`. One that arrives while the round writes or syncs `round_committed`, or after that, does not change the result. The work of the round is already done at that point.
- If an abort or the deadline arrives while the round writes `pending_commit`, the round does not write `round_committed`. It writes a `round_finished` with status `partial` and returns `partial`. If that record cannot be written, the journal ends with `pending_commit` and the round returns `partial` with `evidence_lost`.

Read the journal in this way:

1. If a line is not valid JSON or the file does not end with a newline, the round is partial with `evidence_lost`.
2. If the last record is `round_committed`, the first record is the `round_started` of the same round and the record before it is `round_finished` with `pending_commit`, the round is complete.
3. If the last record is `round_finished` with status `partial`, the round is partial with that stop reason.
4. In all other cases the round is partial with `evidence_lost`. This includes a journal that ends with `pending_commit`.

`readGitExpirationRoundJournal` in `server/src/git-expiration-round-cli.ts` applies these rules.

### When the exit code is the result

If a record cannot be written or synced, the round truncates the file to the end of the previous record and ends partial with `evidence_lost`. The truncation can also fail. Then the journal on disk can be wrong: for example, a `round_committed` whose sync failed can stay in the file, and the rules above read the journal as complete.

So when the round returns `partial` with `evidence_lost`, the command exits with code `3`, and the journal on disk is not trusted, even if its last record says `complete`. A reader must check the exit code or the run record of the command first, and read the journal only when the exit code is `0`, or to find the rows of a partial round.

Row outcomes:

| Outcome | Meaning |
| --- | --- |
| `candidate` | Native expiration would accept the workspace. |
| `rejected` | Native expiration would skip the workspace. The reason is the native reason. |
| `not_candidate` | The sweep selects the row, but the row does not go to Git expiration. |
| `lock_busy` | Another process holds the source lock or the lifecycle lock. |
| `resource_limit` | A Git command timeout, a Git output limit, the row deadline, the walker entry budget, a statement timeout, the connection cap or a native helper budget stopped the inspection. Only a normal non-zero Git exit can give a rejection. |

## Complete and partial

A round is `complete` only when the selection is exhausted, the round recorded every selected row and nothing stopped the round.

These stop reasons make the round `partial`: `lock_busy`, `resource_limit`, `aborted`, `deadline`, `row_budget`, `evidence_lost` and `database_error`. A partial round does not continue later. Start a new round with a new round identifier.

## Limits

- The round is a bounded scan, not a snapshot. A row that changes after selection can move beyond `upperBound`. The round does not follow it.
- A row written with an old `updatedAt` after the round starts can be missing from the round.
- The round does not capture settings for restoration metadata. A row can show `candidate` where the live expiration fails at that step.
- Rows that need managed or company-secret Git credentials show `rejected` with `upstream_commit_unverified`.
- The round sets `client_connection_check_interval`. PostgreSQL supports this setting only on platforms with connection-loss detection, such as Linux and macOS. On other servers the round cannot connect and ends with `database_error`.
