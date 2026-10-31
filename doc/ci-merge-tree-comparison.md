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
