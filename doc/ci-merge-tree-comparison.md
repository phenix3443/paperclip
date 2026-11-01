# Fixed original-CI source verification

The diagnostic implements [issue #317](https://github.com/phenix3443/paperclip/issues/317)
under the [approved design](plans/2026-10-31-ci-merge-tree-comparison.md).
The first delivery slice is the source identity boundary. It does not register
or run a comparison. Workflow integration and evidence capture are later slices.

`scripts/ci-merge-tree/identity.mjs` owns the fixed four-row manifest, dispatch
identity checks and tracked-byte verification. The caller supplies absolute source
and evidence paths. Source SHAs and commands are not operator inputs.

The verifier checks HEAD, tree, ordered merge parents, index contents, executable
modes, symlink contents and every tracked blob's Git object hash. It reads bytes
even when the index marks a path `assume-unchanged`. Ignored dependency and build
outputs may exist. A changed lockfile or source file fails verification; the
verifier never resets changes or repairs the lockfile.

The standalone CLI is intended for the later hosted workflow:

```sh
node scripts/ci-merge-tree/identity-cli.mjs base chat /absolute/source /absolute/evidence/identity.json
```

It requires `GITHUB_REPOSITORY`, `GITHUB_RUN_ATTEMPT`, `GITHUB_REF`, `GITHUB_SHA`,
`EXPECTED_CONTROL_SHA` and `EXECUTION_KEY`. The dispatch must use a
`ci-merge-tree-*` tag at the reviewed control SHA. The execution key is fixed to
`original-ci-41235773036-attempt-1-comparison-1`. This validation does not enforce
exactly-once dispatch: the separate operational task still owns intent, run
reconciliation and the prohibition on repeat dispatches.

Run the focused synthetic checks without installing or building Paperclip:

```sh
node --test scripts/ci-merge-tree/identity.test.mjs
```

No model, instance, deployment or runtime access is part of this helper.

## Capture boundary

The second slice owns synthetic fixture observation and sanitized evidence.
An external Node preload wraps the pinned `postgres` driver's ESM entry. It
captures an allowlisted projection before company deletion, fixture retirement
and client close. It also wraps transaction callbacks. Capture errors create
explicit gaps and do not replace the original query failure or suppress cleanup.
The synthetic preload test proves ordering without changing a source module.
This is instrumentation: extra reads and trace capture can change timing.

Only aliased IDs, known lifecycle states and timestamps enter projections.
The field allowlist is `FIELDS` in `evidence.mjs`; every other field is excluded.
Bodies, names, credentials, connection URLs, arbitrary SQL and payloads are not
copied. Worker-local aliases use a worker PID namespace. Test location/report
records provide case correlation; absent correlation is an explicit capture gap.

Trace archives are parsed as ZIP and JSON. Only recognized structural action
records remain. DOM snapshots, network data, storage state, images and opaque
attachments are omitted and listed in `capture-gaps.json`. This deliberately
limits visual and payload inspection. Unknown log text is replaced by character
counts; known failure signatures and source locations remain. The original run
is still the authoritative source for its original assertions and traces.

The upload staging gate rejects unknown entries, links and a total above 100 MiB.
It emits a file/size/SHA-256 manifest. At the cap, the final seal omits auxiliary
files with explicit gap records. Assertion records are never silently truncated.
Raw data stays in the disposable runner's private directory and is never an
upload input.

## Workflow integration (draft; not approved for execution)

The diagnostic workflow is `ci-merge-tree-comparison.yml`. It has only manual
dispatch, four fixed matrix rows, max-parallel 1, fail-fast false and 25 minutes
per job. It rejects rerun attempts, unapproved control refs and execution keys.
It grants only contents read and uploads only the sealed staging directory with
seven-day retention. `ci-merge-tree-check.yml` runs synthetic helper checks on
PRs; it does not execute the comparison.

Both diagnostic workflows pin Node 24.11.0. The Node-version policy permits
that exact version only in these two files, so helper checks use the same Node
as the comparison. Other workflows retain the Node 24 major policy.

The control checkout and immutable source checkout are separate. A fresh private
home/store is used for each job. Frozen installation has no lockfile repair or
cache fallback. After setup, a private PID/mount/network namespace keeps source
fixtures local, maps their hardcoded `/tmp` into the job temp root, and blocks
external provider traffic. The test process receives an explicit environment
allowlist. The source trees and their original test fixtures remain unchanged.
The original full chat shard and ordered E2E spec list remain fixed. E2E appends
trace=on, retries=0, an external results directory and the external reporter.

The execution deadline is 20 minutes from the initial job step. Packaging and
termination reserve two minutes; upload has the remaining job budget. Phase exits,
signals, setup failures, timeouts and capture gaps remain explicit. A successful
upload cannot turn a failed test or missing evidence into success. Runner loss
can prevent evidence upload; the operational report must retain that missing row.

Before execution, the assigned operator must receive the exact independently
approved implementation SHA and helper digest, create and verify an immutable
`ci-merge-tree-*` tag at those bytes, confirm included capacity and log retention,
and record the single intent and fixed execution key. Log retention above seven
days requires authorized per-run deletion at day seven. Reconcile a lost dispatch
receipt before any further action. This implementation task does not dispatch,
create the execution tag, approve upstream changes, or expand any rerun budget.

Review and merge the identity, capture and integration slices in that order.
Retarget the later PRs to `develop` after their predecessors merge. Each final
head and the full stack require the designated independent review. Do not infer
approval from this document or from synthetic test passes.

## Failure evidence and safety checks

The collector validates source locations against `git ls-tree HEAD`; a path-shaped
credential is never retained merely because it resembles a source filename.
Assertion records retain known matcher names, booleans, null and a small explicit
set of common HTTP/status numbers. Other values retain only type, length and
per-process aliases. This distinguishes a boolean assertion from a cleanup 500
without exporting tokens or provider payloads. Trace errors use the same safe
primitive policy; private trace paths map to framework test IDs before upload.

The fixture projection includes run/task/comment/publication links and comment
author roles. Unknown tables or columns are recorded. The error-code allowlist in
`error-codes.json` contains literal named codes from the two fixed source trees;
it is part of the control digest. PostgreSQL rejection codes and known failure
signatures are recorded before the driver propagates the original error. These
records contain no SQL or bound parameters. Snapshot metadata records the actual
server version; the environment report identifies `psql` separately as a client.
Resolved dependency versions are recorded after installation.

E2E's original web-server command is observed externally as the same two ordered
operations: UI build, then onboarding/server. Build exit and server process status
remain separate; global Playwright startup errors are infrastructure evidence.
The packaging subprocess has one overall two-minute bound and cannot consume the
three-minute upload reserve. A minimal predefined safe report is still uploaded
when control checkout fails.

The helper CI also runs a synthetic hosted namespace smoke. It checks PID 1,
absence of an external route, and termination of a writing detached descendant.
It never runs the real comparison. Local helper results do not substitute for
this hosted check or for the later authorized one-time comparison.
