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
| `--max-rows` | Optional. Stop after this number of inspected rows. |
| `--deadline-seconds` | Optional. Stop when this time is over. |
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

`SIGINT` and `SIGTERM` stop the round. The round closes its database connections, also when a query is in progress, and ends partial.

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
- Git commands in the worktree use `GIT_OPTIONAL_LOCKS=0`. Remote proof fetches into a temporary repository and removes it.

## Evidence

The round writes `events.jsonl` in the evidence directory. Each line is one event. The round syncs each event to disk before it continues.

| Event | Content |
| --- | --- |
| `round_started` | Round identifier, `upperBound`, mode, page size and limits |
| `page_selected` | Page number and selected keys |
| `row_inspected` | Selected key, current row, workspace, outcome, reason and candidate bytes |
| `round_finished` | Summary |

`current` in `row_inspected` is the row that the round read again under the lifecycle lock:

| `current.state` | Meaning |
| --- | --- |
| `read` | `current.key` and `current.status` are the values read under the lock. A key that is not the selected key gives `rejected` with `workspace_changed`. |
| `missing` | The row no longer exists. |
| `not_read` | The round did not read the row again, for example because the row is not a candidate or a lock is busy. |

If an abort or the deadline arrives while the round writes a `complete` `round_finished`, the round writes a second `round_finished` with status `partial`. The last `round_finished` is the result of the round.

Row outcomes:

| Outcome | Meaning |
| --- | --- |
| `candidate` | Native expiration would accept the workspace. |
| `rejected` | Native expiration would skip the workspace. The reason is the native reason. |
| `not_candidate` | The sweep selects the row, but the row does not go to Git expiration. |
| `lock_busy` | Another process holds the source lock or the lifecycle lock. |
| `resource_limit` | A Git command timeout, a Git output limit or a native helper budget stopped the inspection. Only a normal non-zero Git exit can give a rejection. |

## Complete and partial

A round is `complete` only when the selection is exhausted, the round recorded every selected row and nothing stopped the round.

These stop reasons make the round `partial`: `lock_busy`, `resource_limit`, `aborted`, `deadline`, `row_budget`, `evidence_lost` and `database_error`. A partial round does not continue later. Start a new round with a new round identifier.

## Limits

- The round is a bounded scan, not a snapshot. A row that changes after selection can move beyond `upperBound`. The round does not follow it.
- A row written with an old `updatedAt` after the round starts can be missing from the round.
- The round does not capture settings for restoration metadata. A row can show `candidate` where the live expiration fails at that step.
- Rows that need managed or company-secret Git credentials show `rejected` with `upstream_commit_unverified`.
- The round sets `client_connection_check_interval`. PostgreSQL supports this setting only on platforms with connection-loss detection, such as Linux and macOS. On other servers the round cannot connect and ends with `database_error`.
