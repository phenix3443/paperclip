# Server source project: CI cache and incremental type checks

Date: 2026-10-29. Scope: [#186](https://github.com/phenix3443/paperclip/issues/186), sub-issue of [#183](https://github.com/phenix3443/paperclip/issues/183).
Status: plan for independent review. Nothing here is implemented or measured yet.
Documentation draft [#187](https://github.com/phenix3443/paperclip/pull/187) was opened before this file was filled in.

## Baselines

| Item | Value | Role |
| --- | --- | --- |
| Fork `develop` | `752ef594982e9c8ed6b150223b59c0556786737d` | Current CI workflows and lockfile |
| PR [#181](https://github.com/phenix3443/paperclip/pull/181) head | `ba865fa6fdf928a8bb91c30a10f7113b7f348e02` (OPEN, not merged) | `tsconfig.src.json`, `tsconfig.tests.json`, new `typecheck` script, `server-typecheck-memory` workflow |
| Locked TypeScript | `typescript@7.0.2` and `@typescript/typescript-linux-x64@7.0.2` in `pnpm-lock.yaml` on both SHAs above | Compiler whose behavior is described |
| Compiler source | [microsoft/typescript-go](https://github.com/microsoft/typescript-go) tag `typescript/v7.0.2` = `2bd066d87f5bafd315be9f40889d0a60b9e58e0b`; `internal/core/version.go` sets `version = "7.0.2"` | Source read for this plan |
| `actions/cache` | `55cc8345863c7cc4c66a329aec7e433d2d1c52a9` (v6.1.0, the pin used in this repo) | Cache transport |

Source links below are pinned to the compiler commit.

Evidence limits: this plan is based on reading the source. Nothing was compiled, type-checked or measured for it, on the host or in CI. The npm tarball was not unpacked; that it was built from this tag is an inference from the tag name, the release date (2026-07-08) and `version.go`. The implementation must confirm with `tsc --version` in CI and re-read this code if the locked version has changed by then.

## How `tsc -b` decides the source project is up to date (TypeScript 7.0.2)

`tsconfig.src.json` sets `composite: true`, so the project is incremental and has `node_modules/.cache/typecheck/src.tsbuildinfo` as its build info. `getUpToDateStatus` ([buildtask.go#L306](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/execute/build/buildtask.go#L306)) runs these checks in order. The first failing check decides the result.

| # | Check | Basis | Source |
| --- | --- | --- | --- |
| 1 | Build info missing or unreadable → full build | file read | [L336–339](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/execute/build/buildtask.go#L336-L339) |
| 2 | Build info `version` differs from the compiler's `7.0.2` → full build, old state discarded | string | [L342](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/execute/build/buildtask.go#L342); [incremental.go#L47](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/execute/incremental/incremental.go#L47) |
| 3 | Build info records errors, pending checks, per-file semantic or emit diagnostics, a change set or pending emit → rebuild | build info content | [L347–375](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/execute/build/buildtask.go#L347-L375) |
| 4 | Each root file: missing → rebuild. If its mtime is **newer** than the build info, hash its text and compare with the stored version; a mismatch → rebuild, equal → continue | mtime, then content hash | [L383–414](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/execute/build/buildtask.go#L383-L414) |
| 5 | A root file recorded in the build info but no longer in the project → rebuild | build info content | [L416–421](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/execute/build/buildtask.go#L416-L421) |
| 6 | Each other program file (other packages, `node_modules` declarations), except bundled `lib` files: same mtime-then-hash rule as #4 | mtime, then content hash | [L429–461](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/execute/build/buildtask.go#L429-L461) |
| 7 | Output timestamps: **skipped for incremental projects** | — | [L463](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/execute/build/buildtask.go#L463) |
| 8 | `tsconfig.src.json` and every extended config (`tsconfig.json`, `../tsconfig.base.json`): mtime newer than the build info → rebuild | **mtime only** | [L518–537](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/execute/build/buildtask.go#L518-L537) |
| 9 | Every `package.json` the previous build looked up, and every one it found missing: newer or now present → rebuild | **mtime only** | [L539–552](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/execute/build/buildtask.go#L539-L552) |

The hash is xxh3-128 of the file text, hex-encoded ([snapshot.go#L32](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/execute/incremental/snapshot.go#L32)).

"Rebuild" does not mean starting from scratch. `compileAndEmit` ([buildtask.go#L190](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/execute/build/buildtask.go#L190)) loads the old build info as the previous program ([L203](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/execute/build/buildtask.go#L203)) unless `--force` is given or check #2 failed. Then `computeProgramFileChanges` ([programtosnapshot.go#L72](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/execute/incremental/programtosnapshot.go#L72)) parses the whole program, hashes every file, and adds a file to the change set when:

- its hash, global-scope flag or module format differs,
- its references differ, or
- a file it referenced was deleted.

Unchanged files keep their old semantic diagnostics, provided no option that affects semantic diagnostics changed ([L73](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/execute/incremental/programtosnapshot.go#L73)). Only changed files and the files their changes affect are checked again.

### What this means for a fresh CI checkout

These points are inferred from the code above and will be confirmed by the measurements below.

1. **The 0.1 s "unchanged" skip from #181 will not happen in CI.** `actions/checkout` writes every file at checkout time, and `pnpm install` rewrites every `package.json` under `node_modules`. The restored build info is older than both. Check #8 or #9 therefore always fails, and `tsc -b` always goes into the incremental rebuild.
2. **The cache benefit is the incremental rebuild.** The rebuild still parses and hashes all ~580k source lines, but it reuses semantic diagnostics for unchanged files and does not run the checker for them. Its peak RSS and wall time are unknown. They sit somewhere between the 50 MiB up-to-date check and the 6069 MiB cold source build in [run 40846687649](https://github.com/phenix3443/paperclip/actions/runs/40846687649), and this plan does not predict a number.
3. **Content hashes, not mtimes, decide which files are rechecked.** A changed source file, a changed dependency declaration, or a changed workspace package output is caught at check #4/#6 or in `computeProgramFileChanges`, whatever its mtime is.
4. **The one unsafe case is a build info that is newer than changed inputs.** If the build info's mtime were later than a changed root file, and every config and `package.json` mtime also passed, `tsc -b` would report "up to date" without hashing the changed file. That is why the plan never sets source or output mtimes forward. The GNU tar used by `actions/cache` keeps archived mtimes on extraction, because the toolkit's extract arguments (`-xf … -P -C`) do not include `-m`/`--touch` ([toolkit tar.ts](https://github.com/actions/toolkit/blob/4f68f3f93a8e4abb3481f0377812d8519a622691/packages/cache/src/internal/tar.ts#L96)). That is main-branch source, not the exact toolkit release bundled in v6.1.0. To avoid depending on it, step R3 below ages the restored files.
5. **Declaration outputs must be cached together with the build info.** Check #7 skips output files for incremental projects, so a build info restored without its `.d.ts` files would let the source phase pass. The tests phase (`tsc -p tsconfig.tests.json`) would then fail on the missing declarations. The cache path is therefore the whole `server/node_modules/.cache/typecheck/` directory, restored and saved as one entry.
6. **The tests project is not cached.** `tsconfig.tests.json` is `noEmit` without `incremental`, so every run fully checks colocated tests against the source declarations (about 2.7 GiB / 8.4 s in run 40846687649). This keeps test coverage independent of the cache.

### Rejected approaches

- **Restoring source mtimes** (`git restore-mtime` or similar) so that check #4 can skip hashing. This makes correctness depend on mtimes, which is what #183 asks to avoid, and the task forbids it.
- **Touching the restored build info to "now"** so that checks #8/#9 pass and the 0.1 s skip happens. This hits the unsafe case in point 4: a PR's changed source file has a checkout mtime older than the touched build info, so it is never hashed.
- **Skipping the type check on a cache hit.** The command always runs; a cache hit only changes how much work it does.

## Repository CI conventions that constrain the design

- `setup-ci-dependencies` and every rust-cache writer save only when `github.repository == 'paperclipai/paperclip'` on a `master` push. PR jobs use `actions/cache/restore` or `save-if: false`. In the fork, therefore, nothing ever writes those caches.
- `scripts/ci-dependency-cache.mjs` marks the dependency cache uncacheable when a package has an install hook. `server/package.json` has `postinstall`, so every fork job runs a full `pnpm install`.
- The fork's runner is `ubuntu-latest`; `ci-routing.yml` sends fork events to it.
- The writer's and readers' cache paths must be the same strings, or the cache version does not match. This is the lesson recorded in `pr-trusted.yml`, where rust-cache missed on every PR.
- `pr-trusted.yml` is an upstream file that the daily sync merges into `develop`. Fork-only CI lives in separate workflows guarded by `if: github.repository == 'phenix3443/paperclip'`, like `deploy-packages.yml` and #181's `server-typecheck-memory.yml`.
- PR CI today runs `typecheck:build-gaps`, whose server step is the server `build` (`tsconfig.build.json`, source only). Colocated server tests are type-checked only by `pnpm -r typecheck` (`release-verify`, `build-npm`) and by `server-typecheck-memory`.

## Cache design

### Contents

One entry, path `server/node_modules/.cache/typecheck` (exactly this string in every writer and reader). It contains `src.tsbuildinfo` and `src/**/*.d.ts` from `tsconfig.src.json`. Nothing else: no `dist`, no `node_modules` packages, no tests output. The implementation records the entry size from the save step log.

### Key

```text
prefix = server-tsc-src-v1-${runner.os}-${runner.arch}-tsc<V>-<C>
key    = <prefix>-<full commit SHA>
```

- `<V>`: the output of `pnpm --dir server exec tsc --version` from the installed compiler, for example `7.0.2`. It is not read from `package.json`, because `^7.0.2` is a range.
- `<C>`: `hashFiles('tsconfig.base.json', 'server/tsconfig.json', 'server/tsconfig.src.json')`.
- Writer: `<full commit SHA>` = `github.sha` of the `develop` push.
- Reader (PR): `key = <prefix>-${{ github.event.pull_request.base.sha }}` and `restore-keys: <prefix>-`. An exact hit on the base commit's entry comes first, then the newest `develop` entry with the same compiler and config.
- No looser restore key. Under another compiler version, check #2 discards the state anyway. Under another config, options may change semantic diagnostics ([L73](https://github.com/microsoft/typescript-go/blob/2bd066d87f5bafd315be9f40889d0a60b9e58e0b/internal/execute/incremental/programtosnapshot.go#L73)), so the restore would cost download time and save little.
- `v1` is bumped by hand when the cache contents or layout change.

### What invalidates what

| Change | Key effect | Compiler effect (evidence) | Result |
| --- | --- | --- | --- |
| Source file in `server/src` | none | hash mismatch at #4 / change set | That file and the files its change affects are rechecked |
| Source file added or removed | none | new root without stored version → #4; removed root → #5 | Rebuild, incremental |
| Tests (`*.test.ts`, `__tests__`) | none | not in the source project | Always fully checked by the tests phase |
| `tsconfig.base.json`, `server/tsconfig.json`, `server/tsconfig.src.json` | new prefix → miss | (options would also be compared) | Cold build |
| `pnpm-lock.yaml`, other `package.json`, dependency versions | none | changed `node_modules` declarations hash differently at #6 / change set; resolution is recomputed each run | Affected files rechecked |
| Workspace package outputs the program reads (for example `packages/*/dist` produced by `ensure-build-deps`) | none | hashed like any program file | Affected files rechecked |
| TypeScript version | new prefix → miss | #2 would discard the state | Cold build |
| Runner OS / arch | new prefix → miss | — | Cold build |
| Node, pnpm | none | the native compiler does not depend on them; any change in their outputs is hashed | Covered by content |

### Steps

PR job (read only):

- R1. Check out, install, and run the same preparation as the `typecheck` script.
- R2. `actions/cache/restore` with the key above. No save step exists in PR jobs.
- R3. **Age the restored entry** if anything was restored: set the mtime of every file under the cache path to a fixed old time (`touch -d '2000-01-01T00:00:00Z'`). Restored outputs can then only be older than every input, so tsc hashes every root and program file and always takes the incremental rebuild (point 4). This only ever adds work. It never touches source files.
- R4. Run `pnpm --filter @paperclipai/server typecheck` unconditionally. Its exit code alone decides the job. The cache step's outputs (`cache-hit`, `cache-matched-key`) are logged, never used in an `if:`.

`develop` push job (the only writer):

- W1. Check out and install as in R1. Do **not** restore. The saved state always comes from a cold build of a merged commit, so incremental state never builds on earlier incremental state.
- W2. Run the same `typecheck` command.
- W3. Save only `if: success() && github.event_name == 'push' && github.ref == 'refs/heads/develop' && github.repository == 'phenix3443/paperclip'`, with `continue-on-error: true`. A failed save only means the next PR misses.

Failure modes, all of which fall back to a correct cold check:

- Restore fails or finds nothing: `actions/cache/restore` warns and continues, and the check runs cold.
- Corrupt build info: check #1 → full build.
- Mismatched declarations: the source phase re-emits what changed; the tests phase reports a missing declaration as an error, which fails safe.
- A bug in incremental reuse: bounded by W1's cold build on every `develop` push, and by the untouched `pnpm -r typecheck` in `release-verify` / `build-npm`.

## Decision: type-check the server in PR CI

**Yes.** Add a fork-only workflow `.github/workflows/server-typecheck.yml` with one job, `server-typecheck`:

- Triggers: `pull_request` targeting `develop`, and `push` to `develop`. No path filter in the first version, because a server type error can come from changes in any workspace package.
- `runs-on: ubuntu-latest`, `timeout-minutes: 20`, guarded by `github.repository == 'phenix3443/paperclip'`.
- PR events run R1–R4. Push events run W1–W3.
- `concurrency: server-typecheck-${{ github.event.pull_request.number || github.sha }}` with `cancel-in-progress` for PRs only.

`pr-trusted.yml` and `typecheck:build-gaps` are left as they are, so the upstream merge surface does not change.

- **Benefit:** colocated server tests and test helpers are type-checked before merge, not only after it. With a warm cache the source phase should cost less than the cold 6 GiB / 24 s. The measurements below give the real number.
- **Cost:** one extra job per PR and per `develop` push: install (the dependency cache is unavailable for the server, see above), preparation, then the check. Cold, the check alone is about 6.1 GiB / 23.7 s plus 2.7 GiB / 8.4 s on the 16 GiB `ubuntu-latest` runner (run 40846687649). One cache entry per `develop` push counts against the repository's cache quota; GitHub evicts the least recently used.
- **Fallback rule:** if the warm measurement shows no meaningful saving (the warm source phase within 10 % of cold wall time and RSS), keep the job but drop the cache steps. The coverage benefit holds without the cache.
- Making `server-typecheck` a required check is a branch-protection change for the CTO to decide after the measurements, not part of this plan.

## Measurements (to run in CI during implementation)

Run in a `workflow_dispatch` measurement workflow (or a new job in `server-typecheck-memory`) on the implementation branch. Caches written there are scoped to that branch, so `develop` and other PRs never see them. Measurement keys use the prefix `server-tsc-src-measure-v1-<run_id>-`, never the production prefix. Each scenario is a separate job on a fresh runner and checkout, so "fresh checkout" is real:

| Scenario | Job | Steps |
| --- | --- | --- |
| Miss | `miss` | No restore. Run the source and tests phases separately under `/usr/bin/time -f '%M %e'`. Save the cache under the measurement key. |
| Hit | `hit` (needs `miss`) | Same SHA, fresh checkout. Restore by exact key, age (R3), run both phases. |
| Partial | `partial` (needs `miss`) | Restore and age, then change one input in the runner workspace only. Two sub-runs, each on a fresh restore: (a) a body-only edit to one source file (exported signature unchanged); (b) one added exported declaration (signature changes). Run both phases. |

Each sub-run also runs `tsc -b tsconfig.src.json --verbose --dry` before the measured run, to record the status reason that tsc reports (for example, "output is older than input `tsconfig.src.json`"). That records which of checks #1–#9 fired.

Evidence row, one per phase per scenario, written to the job summary and copied into #183:

```text
| scenario | phase | command | exit | peak RSS (MiB) | wall (s) | cache-hit | matched key | tsc --version | commit SHA (full) | run URL |
```

Also record each job's runner (`nproc`, RAM), the entry size, the `--verbose` status line, and for the partial runs the edited file plus `git diff --stat`.

### Safety acceptance: a cache hit never hides an error

In separate `probe-*` jobs of the same measurement run, each on a fresh restore of the measurement cache and aged (R3), inject a type error into the runner workspace only. Then run the full `typecheck` command and require a **non-zero exit**, with the expected file named in the output:

- P1, direct: append `export const __cacheProbe: number = "x";` to one root source file.
- P2, cross-file: change the type of one exported function's parameter in file A so that an unchanged caller B no longer type-checks. The implementation picks A and B from the source at its SHA and records them. The error must be reported in B.
- P3, tests: append the same assignment to one colocated `*.test.ts`. The tests phase must fail.

Each probe job runs `git diff --stat` before and after the edit, and ends with `git checkout -- .`. No probe edit is committed, and no source file in the repository changes. A probe that exits 0 fails the measurement job.

## Gate and order

1. This plan is reviewed and merged. #186 is then closed by this PR.
2. Implementation (a separate task, closing #183) starts only after #181 is merged into `develop`. It re-reads the locked TypeScript version first, and if it is no longer `7.0.2`, rechecks the cited code at the new tag before relying on this plan.
3. The implementation PR adds `server-typecheck.yml` and the measurement workflow, changes only workflows (and, if needed, `tsconfig*.json` or package scripts), and attaches the measured table, the probe results and the run URLs. No source file under `server/src` is modified, moved or renamed, and nothing is compiled or measured on the Paperclip host.
4. The measured table and the PR-CI decision, adjusted by the fallback rule if needed, are written into #183's body.
