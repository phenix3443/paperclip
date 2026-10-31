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
