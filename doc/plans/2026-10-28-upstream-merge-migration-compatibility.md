# Upstream merge into develop: migration compatibility and conflict plan

Date: 2026-10-28 (UTC+8). Plan for [#96](https://github.com/phenix3443/paperclip/issues/96),
part of [#95](https://github.com/phenix3443/paperclip/issues/95).
Status: proposed. The CTO decided the CI-gate question in section 6 (option A).
The plan needs independent review of the exact PR head before any later step starts.
This document grants no merge, deployment or database authority.

## 1. Exact revisions

All values come from `git ls-remote`, `git merge-base` and `git rev-list`.
They were first taken at `81cb1b201b` and checked again at `d0f8e5ad13`.

| Ref | SHA |
|---|---|
| fork `master` = upstream `master` | `70c864633744cd96c0dc7394d631fc7119cd17d2` |
| fork `develop` (current) | `d0f8e5ad130f9940707ed25b201cb5bb0a83b641` (merge of #108) |
| fork `develop` (first analysis) | `81cb1b201b46c688c65e3c77ef8033779ed4ab29` (merge of #81) |
| merge base | `043f2514e67c50320433a0013fb228a75a51325c` |
| develop when #95 was written | `11da652027726cb77e5bb6a62a513772e2a1d7ba` (merge of #86) |
| production (`/api/health` `commit`) | `fdbafff72d8fd6ae7f12eb5827631efc67d208f3` |

`develop` is 300 commits behind `master`. It is now 167 commits ahead, not 148:
#81 and later changes merged after #95 was written. Between `81cb1b201b` and
`d0f8e5ad13`, develop changed only `.github/workflows/sync-upstream.yml` (removed)
and two plan documents. No migration, `client.ts` or conflicting path changed. #97 must start from the `develop` SHA that is
current at that time and repeat sections 2 and 3. A new develop-only migration
means a new number in section 4 and a new review of this plan.

## 2. Conflict inventory

Command: `git merge-tree --write-tree --name-only <develop> <master>` (Git 2.53).

| develop | Conflicting paths | Notes |
|---|---|---|
| `11da652027` | 37 | The figure in #95. |
| `81cb1b201b` | 38 | #81 adds `0376_messy_chimera` and a conflict in `execution-control-work.test.ts`. |
| `d0f8e5ad13` | 38 | Same path list as `81cb1b201b` (compared with `diff`); 26 with `-X no-renames`. |

With default rename detection, Git pairs the large snapshot files by similarity.
This gives 4 `rename/rename` conflicts over 12 snapshot paths. They are artifacts.
With `-X no-renames` there are 26 content conflicts. The 12 snapshot paths have
no conflict, and the snapshot set is rebuilt anyway (section 4.4).

Content conflicts at `81cb1b201b` (hunks / conflicted lines; same paths at `d0f8e5ad13`):

| Area | File | Hunks | Lines |
|---|---|---|---|
| Migrations | `packages/db/src/client.ts` | 2 | 26 |
| Migrations | `packages/db/src/migrations/meta/_journal.json` | whole file (Git treats it as binary) | – |
| Shared exports | `packages/shared/src/index.ts` | 1 | 6 |
| Shared exports | `packages/shared/src/types/index.ts` | 1 | 6 |
| Server entry | `server/src/index.ts` | 1 | 10 |
| Heartbeat | `server/src/services/heartbeat.ts` | 1 | 19 |
| Heartbeat | `server/src/services/heartbeat/queue.ts` | 8 | 105 |
| Heartbeat | `server/src/services/heartbeat/queue.test.ts` | 1 | 7 |
| Heartbeat | `server/src/services/heartbeat/run-preparation.ts` | 1 | 5 |
| Recovery | `server/src/services/recovery/service.ts` | 2 | 29 |
| Recovery | `server/src/services/execution-blocker.ts` | 1 | 32 |
| Native runtime | `server/src/services/native-runtime/native-session-executor.ts` | 2 | 46 |
| Workspaces | `server/src/services/execution-workspaces.ts` | 5 | 54 |
| Workspaces | `server/src/services/git-workspace-contents.ts` | 2 | 18 |
| Workspaces | `server/src/services/git-workspace-expiration.ts` | 4 | 249 |
| Workspaces | `server/src/services/git-workspace-restoration.ts` | 9 | 91 |
| Approvals | `server/src/services/approvals.ts` | 2 | 62 |
| Approvals | `server/src/services/issue-approvals.ts` | 2 | 36 |
| Companies | `server/src/services/companies.ts` | 1 | 5 |
| Notifications | `server/src/services/delivery-work-notifications.ts` | 1 | 23 |
| Tool gateway | `server/src/services/tool-gateway.ts` | 1 | 18 |
| Tests | `server/src/__tests__/execution-control-work.test.ts` | 1 | 5 |
| Tests | `server/src/__tests__/heartbeat-process-recovery.test.ts` | 1 | 5 |
| Tests | `server/src/__tests__/openapi-routes.test.ts` | 1 | 15 |
| Tests | `server/src/__tests__/server-startup-feedback-export.test.ts` | 1 | 33 |
| UI | `ui/src/pages/Issues.tsx` | 1 | 5 |

## 3. Conflict resolution rules

1. Keep both sides. Every upstream change and every develop-only fix stays.
   Never take one side of a file wholesale.
2. For each hunk, find the develop commit and the upstream commit that changed it
   (`git log --merge -p -- <file>`). Keep the intent of both. Where the two change
   the same guard or query, combine the guards. Do not drop a develop check.
3. Imports, export lists and registries (`shared/*/index.ts`, `server/src/index.ts`,
   OpenAPI route lists): take the union and keep the upstream order.
4. Heartbeat files: follow `rules/heartbeat-execution-boundaries.mdc`. Keep the
   develop queue revalidation from #81 and the upstream queue changes together.
5. Tests: keep the upstream and develop cases. Fix fixtures only to match the merged
   code. Do not delete a develop regression test to pass CI.
6. `client.ts`: hunk 1 keeps both lines (`dedicatedDbGuards.set(...)` and
   `installDatabaseResponseCapture(...)`). Hunk 2 is section 4.3.
7. Auto-merged files are part of the review. Check the full `develop...merge` diff
   for semantic breaks, not only the conflict hunks.
8. Put any change beyond conflict resolution in a separate, explained commit on
   the merge branch. Examples: a type fix after an auto-merge, or the client.ts
   file-name list.

## 4. Migration plan

### 4.1 Numbers collide

At the merge base the last migration is `0371_furry_red_shift`. After that,
the two sides use the same numbers:

- upstream: 23 files, `0372_mature_the_initiative` … `0394_conscious_whizzer`.
- develop: 5 files, `0372_aromatic_loki` … `0376_messy_chimera`.
  #95 lists four files. `0376_messy_chimera` arrived later with #81.

Keep upstream `0372`–`0394` unchanged. Rename the develop files with `git mv`.
The SQL bytes do not change:

| develop file | new file | SHA-256 of SQL (unchanged) | journal `when` (kept) |
|---|---|---|---|
| `0372_aromatic_loki.sql` | `0395_aromatic_loki.sql` | `f7f8da4d04b7b2c6d87b1d8b31f438a27715727e19eab7d6b1252ff30f892f87` | 1792809786245 |
| `0373_melted_hydra.sql` | `0396_melted_hydra.sql` | `8ce631d5c1dda67a32135ed4ca4c38aee1ba82b470e69f79f755f10edeb17c3a` | 1793109921370 |
| `0374_purple_sue_storm.sql` | `0397_purple_sue_storm.sql` | `44ab97136e6634ac9e9be9a9f7ec5bf7c8bf20566271dddbcf01e329aeb163f7` | 1793124505405 |
| `0375_young_garia.sql` | `0398_young_garia.sql` | `17debea737c743049555aa56a5ba2189e624a143c09ec5260bb3508a2ef473bd` | 1793130317685 |
| `0376_messy_chimera.sql` | `0399_messy_chimera.sql` | `30dea19f19e0c7a00b8c8d44957a2638db45f6d6421e9c0cb2276ccd1c3c3cd1` | 1793154577343 |

The 0376 → 0399 row extends the direction in #95 to the fifth file.
The fifth file uses the same rule, so the order does not change.

The 28 SHA-256 values of the five develop files and the 23 upstream files are all
different. A hash never resolves to two files.

### 4.2 How the applied-migration check sees the rename

Source: `packages/db/src/client.ts` at both SHAs.

- `inspectMigrations` → `loadAppliedMigrations`. If `__drizzle_migrations` has a
  `name` column, applied migrations are read by name only. Otherwise the code reads
  `hash` and maps each hash to the current file with that SHA-256
  (`mapHashesToMigrationFiles`). Files that do not match are pending.
- `ensureMigrationJournalTable` creates the table as `(id, hash, created_at)`.
  Drizzle's table has no `name` column either. With that shape, a renamed file with
  the same bytes counts as applied. It does not run again.
- `migrationHistoryEntryExists` (the guard before each apply) builds its filter
  from the columns that exist: `hash = …` if there is a `hash` column, `name = …`
  if there is a `name` column, joined with `OR`. It skips a file that matches.
- If the production table has a `name` column, `loadAppliedMigrations` reads by
  name, so the renamed develop files (`0395`–`0399`) are pending. What happens
  next depends on the other columns:
  - `name` and `hash`: the guard finds the old hash and skips each file. The SQL
    does not run again, and no row gets the new name. The final `inspectMigrations`
    still lists the five files as pending, so `applyPendingMigrations` throws
    `Failed to apply pending migrations` and the server does not start.
  - `name` without `hash`: the guard only compares names. The new names do not
    match, so the SQL runs again.
  Neither case has been tested against a real named history. Any `name` column is
  therefore a deployment stop condition (section 7).
- `reconcilePendingMigrationHistory` walks pending files in name order. It stops
  at the first file whose statements are not all present. Upstream `0372` creates
  `execution_workspace_restore_points`, so it stops at once. Nothing is backfilled
  wrongly.
- `applyPendingMigrationsManually` orders pending files by journal `idx`. It records
  `created_at = max(latest + 1, when)`. The develop `when` values are older than some
  upstream ones. Upstream rows inserted after them still get increasing `created_at`.
- The upstream journal already has 18 non-increasing `when` pairs and `idx` gaps
  (126, 130, 177). `check-migration-numbering.ts` checks tags, numbers and order,
  not `when`. Keeping the original `when` values follows that precedent.

### 4.3 File names in client.ts

`MIGRATIONS_WITH_TOP_LEVEL_STATEMENTS` is a set of file names. Migrations in the
set run outside a transaction, which `CREATE INDEX CONCURRENTLY` needs. They also
get the drop-and-rebuild guard for invalid indexes. Resolve hunk 2 as the union.
Rename the develop entries:

- keep every upstream entry (`0381`–`0393`);
- `0372_aromatic_loki.sql` → `0395_aromatic_loki.sql`;
- `0375_young_garia.sql` → `0398_young_garia.sql`;
- `0376_messy_chimera.sql` → `0399_messy_chimera.sql`.

If the old names stay, a fresh database (CI and new installs) runs the concurrent
index builds inside a transaction, and PostgreSQL rejects them. No other source
file or test refers to the five develop file names.

### 4.4 Journal and snapshot

Journal: use the upstream `_journal.json` (entries `idx` 0–394). Append five entries
with `idx` 395–399, the new tags, the original `when` values, `version: "7"` and
`breakpoints: true`. Remove the old develop entries.

Snapshot: do not use `pnpm db:generate` on netcup. It builds `packages/db` from
source. Build `0399_snapshot.json` with a small JSON script:

- three-way merge over the snapshot contents: base `0371_snapshot.json` at
  `043f2514e6`, ours `0376_snapshot.json` at `81cb1b201b`, theirs
  `0394_snapshot.json` at `70c8646337`. Ignore `id` and `prevId`;
- the merge must have no conflicts. A conflict is a stop condition;
- `prevId` = `633afb6b-4b89-44ea-81d5-a477a3696eb5` (0394's `id`), with a new random `id`;
- expected result: 304 tables. That is 300 at the base, plus upstream
  `execution_workspace_restore_points` and `native_runner_checkpoints`, plus develop
  `execution_reconciliation_receipts` and `issue_document_decisions`. Also expected:
  the `companies.execution_reconciliation_authority` column, the develop indexes on
  `agent_wakeup_requests`, `issue_comments` and `issue_recovery_actions`, and the
  `authorization_evidence` column.

A trial of this merge in the planning run (recursive key-level three-way merge)
returned 0 conflicts and 304 tables, including the four new tables and the
`companies` column. #97 repeats it on its own base.

Retention (`rules/database-migration-snapshots.mdc`): keep the five newest snapshots,
`0391`–`0394` (upstream bytes) and `0399`. Delete `0390` and the develop snapshots
`0372`–`0376`. Do not create snapshots for `0395`–`0398`: the rule does not require
one per journal entry. Commit the script output and the merge-check result in the
PR description, not the script.

### 4.5 Upstream overlap check

The develop migrations create or alter these objects:

| develop file | objects |
|---|---|
| 0395 aromatic_loki | index `agent_wakeup_requests_owner_repair_continuation_uq` on `agent_wakeup_requests` |
| 0396 melted_hydra | table `execution_reconciliation_receipts`, its 4 FKs (companies, issues, issue_recovery_actions, heartbeat_runs) and 3 indexes |
| 0397 purple_sue_storm | table `issue_document_decisions`, 6 FKs, 2 indexes; column `companies.execution_reconciliation_authority`; column `execution_reconciliation_receipts.authorization_evidence` |
| 0398 young_garia | indexes `agent_wakeup_requests_cross_task_continuation_intent_uq`, `…_dispatch_uq` on `agent_wakeup_requests`, `issue_comments_agent_client_request_uq` on `issue_comments` |
| 0399 messy_chimera | index `agent_wakeup_requests_execution_reconciliation_delivery_uq`; index `issue_recovery_actions_continuation_wait_due_idx` |

The upstream migrations `0372`–`0394` touch: `execution_workspace_restore_points`
(table, indexes, and triggers on `issues` for update/delete), `issue_thread_interactions`
(2 columns), `native_run_finalizations` and `heartbeat_runs` (data `UPDATE`s on other
columns), and environment and skill runtime functions with triggers on `environments`,
`plugins`, `plugin_company_settings` and `instance_settings`. They also touch `projects`
(2 columns and an FK to `connection_grants`), `tool_mcp_gateway_tokens` (1 column),
and concurrent indexes on `tool_gateway_sessions`, `tool_action_requests`,
`decision_archive_notification_outbox`, `decisions`, `grok_bot_dispatches`,
`approvals` and `join_requests`. Finally, they touch `native_runner_checkpoints`.

A whole-word search of the 23 upstream files finds no reference to `companies`,
`agent_wakeup_requests`, `issue_comments`, `issue_recovery_actions`, `documents`,
`document_revisions`, `execution_reconciliation_receipts` or `issue_document_decisions`.
The object sets do not overlap. Both orders give the same result:

- production: the develop migrations already applied first, upstream ones after;
- fresh database: upstream `0372`–`0394` first, develop `0395`–`0399` after.

The proposed order is valid.

### 4.6 What production has

`/api/health` reports `fdbafff72d`. That tree has only `0372_aromatic_loki`
of the develop migrations. Unless they were applied by hand, `0373`–`0376` are
not in production. #95 says four are applied. The source does not support that.
With identical bytes, both cases work. Recorded hashes are skipped. Missing ones
run as `0396`–`0399` after the upstream files. Ops records the real rows before
deployment (section 7).

## 5. CI validation

Netcup runs no whole-package typecheck, tests or source build. Full PR CI on the
merge PR is the validation (`pr.yml` → `pr-trusted.yml`): policy, typecheck,
general tests, build, e2e and the `verify` aggregate. Local checks for #97 are
small and do not build:

- `git diff --check`;
- the hashes in 4.1 again, on the merge tree (`git show <merge>:<file> | sha256sum`);
- `git diff -M100% --summary <develop> <merge> -- packages/db/src/migrations/*.sql`
  shows five 100% renames and 23 additions;
- `tsx packages/db/src/check-migration-numbering.ts` and
  `check-migration-safety.ts` only if dependencies already exist; otherwise CI;
- a snapshot list check (five files: 0391–0394, 0399) and the 3-way merge output.

CI applies all migrations to fresh embedded databases in the db and server tests.
That proves the order and the client.ts name list on a fresh database. It does not
prove the upgrade path of the production database. Section 7 covers that.

## 6. Decision: the CI migration-order gate (CTO, option A)

`pr-trusted.yml` runs `.github/scripts/check-pr-migration-order.mjs <base> <head>`
in the `policy` job. The script lists `--diff-filter=A` SQL files in `base...head`.
It fails if any has a number less than or equal to the newest number on the base.
For the merge PR the base is `develop`, with `0376` as the newest. The added files
are upstream `0372`–`0394`. The five renames are not additions. Upstream
`0372`–`0376` fail the check. `verify` and `e2e` need `policy`, so full CI cannot
pass without a change. Renaming first does not help: after that the base is at
`0399`, and all 23 upstream files are lower.

The CTO chose option A. A separate small PR to `develop` fixes the gate before the
merge PR starts. Rejected: merging with `policy` red under a waiver (breaks "full CI
green" in #95 and repeats on every sync), and changing the #95 direction to a rebase
(redoes the conflict work and rewrites published history).

Scope of the gate PR:

- Only `.github/scripts/check-pr-migration-order.mjs`, any trusted-ref fetch the CI
  job needs, and regression tests. No SQL change. `policy` stays on. `verify` and
  `e2e` get no exemption. No hand-kept list of exempt numbers.
- An added migration is exempt from the old-number check only when all of these hold:
  a real merge commit in `base..head` has a non-first parent that contains the same
  path with the same blob, and that parent is in the trusted upstream-mirror history
  of fork `master`. The proof uses the trusted base and CI context. A ref with the
  same name that the PR itself creates is not proof. A missing ref, history or object
  fails the check with a reason.
- Other added migrations keep the current rule. Every fork-only migration must be
  numbered after every exempt file.
- No exemption for: same path with changed bytes, same bytes at a different path,
  a parent that is not in the mirror history, or an ordinary feature PR.
- Tests cover a real upstream merge that passes, each rejected case above, and the
  fork-only ordering rule.

Order:

1. This plan (#96) passes independent review and merges into `develop`.
2. The gate PR is built on its own Issue and task, passes cross-type independent
   review of its exact SHA and full PR CI, and merges into `develop`.
3. #97 starts from the `develop` of that time.

Nobody changes the gate or starts the merge before this plan is approved. The
dispatcher of #95 opens the gate Issue and task and records the native dependency
of #97 on it.

Later syncs: upstream's next migration will be `0395`, so the next sync collides
again. The same rename (identical bytes, higher numbers) is safe each time because
production matches by hash. A permanent numbering policy for fork migrations is out
of scope.

## 7. Backup, deployment and rollback limits (input for #98)

Ops owns these steps under the existing Paperclip deploy procedure. This plan only
lists the conditions.

Before deployment:

1. Full database backup. Record its location and size.
2. Read only: `SELECT column_name FROM information_schema.columns WHERE table_name = '__drizzle_migrations'`.
   If a `name` column exists, **stop**. The rename would make applied files pending.
   With `hash` too, startup fails with `Failed to apply pending migrations`; without
   `hash`, the SQL runs again (4.2). Compatibility with a named history is not
   verified. Bring the result to CTO.
3. Read only: count all rows in `__drizzle_migrations`. Also list which of the five
   hashes in 4.1 are present. Record the result.

After deployment:

4. `/api/health` reports the merge commit, and startup has no migration error.
5. Every hash of the 23 upstream files and the 5 develop files is in
   `__drizzle_migrations`, once each. The row count grows by 23 plus the missing
   develop files from step 3.
6. The objects in 4.5 exist. All indexes built `CONCURRENTLY` are valid
   (`pg_index.indisvalid`).

Rollback limits:

- The upstream migrations cannot be undone in code. `0376` and `0377` clear column
  values. `0374` and `0375` replace indexes. `0372` and `0378` add triggers that the
  older code does not expect. The only full rollback is to restore the backup and
  redeploy the earlier commit.
- An old build on the migrated database would treat the 23 new rows as unknown
  hashes and start. Nobody has tested that, so it is not a rollback path.
- Concurrent index builds on large tables (`tool_action_requests`, `decisions`,
  `approvals`, `join_requests`) run at startup outside a transaction and can take
  time. A cancelled build leaves an invalid index. The existing guard drops and
  rebuilds it on the next start.

## 8. Out of scope

Conflict resolution and the merge PR (#97), the implementation of the CI-gate PR from
section 6 (only its scope is set here), deployment
and acceptance (#98), changes to any SQL file, changes to upstream PRs, and a
permanent numbering policy for fork migrations.

## 9. Acceptance for #97 (from this plan)

- [ ] The CI-gate PR from section 6 is merged into `develop` before #97 starts.
- [ ] Base is the then-current `develop`. Sections 2 and 3 were repeated on it,
      including the migration list and numbers.
- [ ] The five develop SQL files are 100% renames with the hashes in 4.1.
      Upstream `0372`–`0394` are byte-identical to `70c8646337`.
- [ ] The journal has upstream entries 0–394 plus 395–399 as in 4.1.
      `check-migration-numbering` passes.
- [ ] `MIGRATIONS_WITH_TOP_LEVEL_STATEMENTS` has the upstream entries and the three
      renamed develop entries.
- [ ] The snapshot set is `0391`–`0394` plus `0399`. The 3-way merge output is
      recorded and has no conflicts.
- [ ] Every conflict is resolved under section 3, with no develop regression test removed.
- [ ] Full PR CI is green, `policy` included, with the section 6 gate change.
- [ ] Independent review of the exact head SHA.
