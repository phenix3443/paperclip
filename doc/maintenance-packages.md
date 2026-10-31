# Maintenance package evidence

The fork's `.github/workflows/deploy-packages.yml` retains the native installer
export path for develop. Its only additional push source is
`refs/heads/fix/maintenance-rework-151` in `phenix3443/paperclip` (repository ID
`1420915320`). This is source/package preparation, not release eligibility or
installation authorization. The maintenance exception is limited to #298/#307.

The maintenance job requires a protected push. Checkout uses the event's full
SHA with no persisted credentials. Both workspace and native installer dependency
resolution use frozen lockfiles. The native installer receives the full SHA as
`--ref` and `PAPERCLIP_BUILD_COMMIT`. Maintenance push and maintenance-target PR
builds require independent build/typecheck and test jobs before package export.
The test matrix reuses `scripts/run-vitest-stable.mjs`: 12 server shards excluding
chat and native-runner suites, 3 chat shards, 2 workspace-a shards, one each for
workspace-b, workspace-c and native-runner suites, and 9 serialized route shards.
All 29 matrix jobs retain the selector's isolation and per-file serial constraints.
Build/typecheck runs first and uploads its outputs as a tar archive. Each test
runner restores the artifact named by the same SHA and run attempt. Tar retains
executable modes; a missing executable Runner binary fails before test collection.
The native-runner lane also builds and verifies its debug fake-provider fixture.
Rerun the full workflow, including build, when a test fails. A failed-jobs-only
rerun has a new attempt number but no matching build archive; it fails closed
rather than restoring an earlier attempt's outputs.
At most 4 test jobs then run concurrently.
Every job keeps a 90-minute limit. The packages job depends explicitly on both
checks. Failure, cancellation or an unexpected skip blocks maintenance exports.
Develop skips these maintenance checks and retains its existing packaging path.

The earlier serial check reached the 90-minute limit before native export
([run 41232994050](https://github.com/phenix3443/paperclip/actions/runs/41232994050)).
Partial test success in that attempt is not complete-test or package evidence.
The split jobs must succeed on the new exact source before acceptance. PRs upload
`paperclip-validation-<sha>`, with no maintenance provenance. Dispatch on the
maintenance ref cannot run the package job. Tag, foreign-repository and alternate
events cannot mint maintenance provenance. Develop's existing manifest stays
unchanged. All external actions use immutable commits; permissions are limited to
contents/actions read and the native Actions artifact upload facility. No
production/deployment secrets are used.

The packaging-only paths are:

- `.github/workflows/deploy-packages.yml`: exact-source checkout, maintenance
  admission, CI checks and provenance attachment to native exported packages.
- `.github/scripts/maintenance-package-provenance.mjs`: bind the native manifest
  to the CI context and GitHub API evidence without changing the runtime installer.
- `.github/scripts/tests/maintenance-package-provenance.test.mjs`: reject missing
  or contradictory identity/event/source/attempt evidence and guard workflow wiring.
- `doc/maintenance-packages.md`: document this evidence contract and its limits.

## Version 1 provenance

Only a trusted maintenance push adds `ciProvenance` to `payload-packages.json`:

| Key | Meaning |
| --- | --- |
| `version` | `1` |
| `repository`, `repositoryId`, `headRepositoryId` | Exact repository name and numeric repository identities |
| `ref`, `sha` | Exact maintenance ref and full lowercase source SHA |
| `workflowPath`, `workflowSha`, `workflowId` | Fixed workflow path, source commit and numeric workflow ID |
| `runId`, `runAttempt`, `jobId` | Exact run, attempt and attempt-specific packages job |

The writer checks the push payload, default GitHub environment context,
`actions/runs/<runId>/attempts/<runAttempt>`, that attempt's jobs, the current run,
the workflow resolved by path, and the protected branch tip. Missing evidence,
API errors, truncated job evidence, a newer attempt or tip drift fail the job.
The packages job is still in progress at attachment time: these bytes prove
identity, not completed-run acceptance. No job-success claim is embedded.

## Independent delivery acceptance

After #301 merges first, update and independently review each changed #310 head.
Merge only the approved CI head after required protected-branch checks. Record
both PR heads, contributors/reviewer and merge SHAs. Account for all commits,
paths and trees from B `fdbafff72d8fd6ae7f12eb5827631efc67d208f3` to the tip;
the schema/journal/migration diff must be empty. #298 then owns independent final-C
review and a protected tip freeze. Intermediate push artifacts are not final-C
delivery evidence. A new tip or rerun requires new review.

For the selected exact C, independently verify the completed successful push run
and all required build/typecheck/unit/route/package jobs using the attempt-specific
run and jobs endpoints. Check current run_attempt still equals the approved
attempt. Verify the workflow source at `workflowSha:workflowPath` against the
reviewed C and all pinned action/lockfile inputs. Confirm repository identities,
exact ref/tip, protection rules and actor restrictions remain valid. The branch
protected flag alone does not prove the complete protection policy; retain the
administrator's ruleset readback and reject any unprotected-interval run.

Retain the existing strict six-field tuple: `repository`, `sha`, `workflowId`,
`runId`, `artifactId`, `artifactDigest`. Resolve the workflow ID from the fixed
path. Select an exact unexpired artifact belonging to that exact run, with name
`paperclip-payload-<C>`. Download by artifact ID and calculate `artifactDigest` as
SHA-256 of the **raw downloaded ZIP**, before extraction. Do not substitute an
API digest, a tarball hash, a name-only search or the latest successful run.
Verify provenance and native package inventory/hashes inside those approved ZIP
bytes. The tuple remains six fields; attempt/source identity lives in the bound
manifest. Retain the ZIP and API evidence for independent artifact review.

This workflow neither enables maintenance inputs in deployment tooling nor
changes protection, runtime dependencies, schema, migration history or #588 HOLD.
