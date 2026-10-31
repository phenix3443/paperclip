# Original CI merge-tree comparison plan

Date: 2026-10-31. Status: proposed; independent review required.

Requirement: [fork issue #316](https://github.com/phenix3443/paperclip/issues/316).
Planning PR: [#320](https://github.com/phenix3443/paperclip/pull/320).
The issue body governs scope and acceptance. This document specifies a later
implementation and a separately assigned one-time execution. Merging this
planning PR, or cancelling the planning task, does not authorize either action.

## Problem and outcome

[Upstream PR #18495](https://github.com/paperclipai/paperclip/pull/18495) has
failures in [original CI run 41235773036, attempt 1](https://github.com/paperclipai/paperclip/actions/runs/41235773036/attempts/1).
Earlier merge-base/head single-test passes used different source trees and test
selection. Compare the actual base with the actual tested merge on hosted CI.
Keep the original failure evidence and qualify any difference in instrumentation.

As the upstream investigator, I need the entire original chat shard, the seven
original E2E specs, and fixture persistence evidence for both versions. As the
operator, I need a fixed resource limit and an explicit record of every failed
phase. As the reviewer, I need immutable source identities and identical
collection settings before attributing a difference to the merge.

## Fixed identities and four jobs

| Arm | Full commit |
| --- | --- |
| base | `75fa37f30fc1e65d1e936fcc58ad507cb53f88bb` |
| merge | `9535ae08127e8ea4e4b951e77d21bb23763be002` |
| merge second parent (identity check only) | `e29ed583fe30f67d4d275b7ef1cdbdfc4fe8f665` |

Use one matrix job definition with exactly these four rows: base/chat,
merge/chat, base/e2e, merge/e2e. No authorization or summary job outside the
matrix. Set `fail-fast: false`, `max-parallel: 1`, `timeout-minutes: 25` on each
job, and no `continue-on-error` on the job. Each job uses a fresh GitHub-hosted
Ubuntu runner. Pin the same Ubuntu label and exact Node 24 patch in the
implementation; pnpm is exactly 9.15.4. Record runner image release, OS, CPU,
Node, pnpm, Chrome, PostgreSQL and relevant dependency versions. Hosted image
patches can change between jobs; record drift and qualify comparability.
The total execution ceiling is four times 25 job minutes, plus queue time.

## Workflow registration, dispatch ref and authority

The later implementation adds a dedicated fork-only `workflow_dispatch` workflow
and its diagnostic helper. It does not call a release, deployment, existing paid
E2E, or upstream workflow. No push, PR, schedule or workflow-run trigger.
Require `github.repository == 'phenix3443/paperclip'` and
`github.run_attempt == 1` in the matrix entry guard. Reject rerun attempts before
checkout/install/test; retain the denial in Actions logs. A job-level guard
cannot prevent GitHub from allocating a runner for an attempted rerun, so it is
also an operator prohibition, not a claim of global exactly-once enforcement.

GitHub must first have this workflow at the fork's default branch. The
implementation PR therefore merges the reviewed workflow into `develop`, after
confirming the repository default branch with `gh repo view`. Do not try to
register it by dispatching a workflow that exists only on a topic branch, and do
not merge this plan as though it registered executable code.

After implementation review, record its full reviewed commit and immutable
configuration digest. The executor creates a unique fork tag at that exact
commit, verifies tag resolution and workflow availability through host `gh`, and
uses that tag as the dispatch `--ref`. Record the tag and commit in the execution
task before dispatch. The tag must never move. The workflow validates an
`expected_control_sha` input against `github.sha`; the two source SHAs are
constants, not dispatch inputs. It also validates the unique execution key
against the recorded handoff. A tag is a dispatch ref; it is never a source arm.
Tag creation and dispatch belong to the later execution assignment.

The executor records intent once, checks for a pre-existing run with the same
execution key/ref, and sends one dispatch. If the response is lost, reconcile
against run metadata before taking any action; never send a second dispatch
because a CLI timed out. Fixed workflow concurrency with `cancel-in-progress:
false` avoids cancellation of an active comparison but does not deduplicate
queued dispatches. Native execution ownership plus the intent/run receipt is the
one-time control. No automatic retry, failed-job rerun, empty commit or rerun to
green. Any new comparison needs a new explicit decision.

Workflow permissions are `contents: read`, all other token permissions disabled.
Use the Actions artifact runtime token through the pinned upload action; do not
grant `actions: write`, OIDC, pull-request writes, environment access, PATs or
`secrets: inherit`. Use `persist-credentials: false` for every checkout and pin
all actions to reviewed full commits. Dispatch/tag authority stays in host Git
and `/home/lsl/.local/bin/gh`, outside the test process. Remove tokens from the
child environment. Included existing CI capacity only; no paid runners,
provisioning, new spending, real model credentials or real chat connections.

## Checkout layout and immutable source contract

Each matrix job has two separate checkouts: `control/` at the dispatch commit,
and `source/` at that row's fixed upstream SHA. Use explicit repository names
and full SHA refs; do not let the default checkout ref select either source.
Fetch public upstream objects directly, including the exact merge and parents;
never synthesize a new merge, fall back to head, or use the current PR merge ref.
If GitHub no longer serves the object, record `source_unavailable` and stop that
job. A missing object does not authorize reconstruction or a replacement SHA.

Record `git rev-parse HEAD`, tree, ordered parents, lockfile SHA-256 and tracked
status before install, after setup and after tests. Verify merge parent 1 equals
base and parent 2 equals the stated head. Require exact HEAD and no tracked
source/lockfile changes; never reset modifications to conceal them. Compare
tracked file bytes against Git, not just a cached index stat. Ignored dependency
and build outputs are permitted; record their locations. Harness files, preload,
reporters and output live outside `source/`, under the job temporary directory.
Each job owns its own home, pnpm store, fixture data and ports. No shared database
or materialized builds between arms. No observer file enters test discovery.

The diagnostic helper owns one small interface: fixed arm/lane plus absolute
source and output roots. It returns a phase/status manifest. It owns capture,
redaction and finalization; product services retain all their existing ownership.
No database schema, API, UI or runtime module changes are needed.

## Original setup and deliberate deviations

Read the pinned merge's trusted PR workflow, dependency composite action, task
runner and E2E config when implementing. Preserve the original dependency
postinstall steps and synthetic fixtures. Use `pnpm install --frozen-lockfile` in
both arms, with fresh dependency state and no task/build cache restore or save.
The original dependency setup can resolve a stale lockfile inline. That fallback
is explicitly forbidden here because #316 requires unchanged lockfiles. A frozen
install mismatch is `setup_dependency_failure`; keep its exit and error, do not
resolve, install an alternative graph or retry. Cold setup versus original cache
state is a disclosed deviation, and can exhaust the 25-minute budget.

E2E still uses the source configuration's UI build and throwaway server. The UI
build runs only on hosted CI. No manual instance or managed service startup is
allowed on the production host. Do not reuse an existing instance. All fixture
homes are contained under the job temp root, with no inherited DATABASE_URL,
Paperclip API keys, home/config, cloud credentials or provider accounts. Keep the
source's fake GitHub/AI fixtures and fixed local-only signing settings. Record
only an allowlist of environment names/values, never an environment dump.
Dependency downloads finish before tests. During tests, block external model and
chat-provider egress; retain synthetic fixture routes and required local traffic.
Verify the fixed seven specs against that restriction during implementation; an
unhandled real-provider dependency is a setup failure, not permission to connect.

## Commands and symmetric instrumentation

Chat executes the original full zero-based shard 2 of 3 (displayed as 3/3):

```sh
CI_TASK=ci:chat CI_TASK_ARGS='["--shard-index","2","--shard-count","3"]' CI_FORCE_TASKS=true node scripts/ci/run-task.mjs
```

Record selection using the pinned stable runner's non-executing dry-run with
`--mode general --group general-chat --shard-index 2 --shard-count 3 --dry-run`.
Then record actual started/completed cases from the execution log/report. A
selection dry-run is not a second test execution. Do not filter to the initially
failing file, use incremental test selection, change ordering or enable retries.

E2E's required command is:

```sh
PAPERCLIP_E2E_SKIP_LLM=true PAPERCLIP_PLAYWRIGHT_CHANNEL=chrome pnpm run test:e2e tests/e2e/agent-chat-projects.spec.ts tests/e2e/agent-configuration.spec.ts tests/e2e/archived-company-url.spec.ts tests/e2e/cloud-auth.spec.ts tests/e2e/onboarding.spec.ts tests/e2e/plan-task-fixture.spec.ts tests/e2e/runner-e2e-dashboard.spec.ts
```

Preserve that ordered seven-spec list, workers=1, original assertion/test/server
timeouts, source fixtures and Chrome channel. Keep retries=0. The pinned config
has trace `on-first-retry` with retries=0, so it does not capture failure traces.
Append explicit CLI instrumentation `--trace=on --retries=0 --output=<external
results root> --reporter=list,<external reporter>` to this command in both arms.
The external reporter writes the selected test IDs, outcomes and an HTML/JSON
report outside the checkout, and relays web-server stdout/stderr. Any config
wrapper needed for log destinations must import each source's original config,
resolve paths against that source, preserve server command/fixtures/timeouts and
change only capture destinations. Record the effective config and CLI overrides.
Do not silently replace the source config with the control checkout's config.

The same control SHA, preload/reporter bytes and configuration digest apply to
both arms of each lane. Only source identity and output labels vary. Report all
instrumentation, cold cache, runner-image and dependency-setup deviations from
original attempt 1. Trace-on introduces timing cost; a pass cannot prove that the
original CI condition passed. Use no extra test retries to obtain traces.

## Persistence and safe evidence

The helper starts a bounded local observer before the lane command. Its external
Node preload observes fixture database lifecycle and service output without
changing query results, fixture cleanup or assertions. Capture a sanitized
projection before fixture database close/removal, correlated to test identity,
phase, time and fixture alias. Do not wait until after the suite to find a
database that teardown already deleted. Avoid copying a live database directory.
The implementation must demonstrate this seam on synthetic fixtures, including
failure and cleanup paths, before approval to run the comparison. If a source
cannot support it without product changes, stop implementation and return the
concrete limitation for plan revision; do not dispatch with missing capture.

Persist only fixture chat structure needed for attribution: aliased company,
agent, conversation/message/task/run IDs, lifecycle status, roles, ordering,
parent links, timestamps and named error codes. Replace message bodies, prompts,
response text, names, email, paths and provider payloads with explicit redaction
markers or lengths. Use stable per-job aliases, not plain hashes of secret text.
Never export tokens, signing secrets, headers, cookies, connection strings,
provider configs, encrypted credential blobs or arbitrary SQL parameter values.
Keep schema version and the projection's field allowlist in the evidence.

All attempted jobs use `if: always()` finalization and artifact upload, including
setup failures. Continuously write private phase logs and a checkpoint manifest;
initialize phase status before starting work. Give the lane process a hard
20-minute deadline from job start, then at most two minutes for process-group
termination, sanitized snapshot completion and packaging. Reserve the remaining
three minutes for upload within the 25-minute job limit. Child services terminate
with the lane process group and a final trap. Forced runner loss or hard job
cancellation can prevent upload: show `evidence_missing`, preserve Actions job
URL/status and available logs, and never claim guaranteed artifacts after loss.

The uploader receives only a separate sanitized staging directory with these
explicit entries:

- `identity.json`, `environment.json`, `commands.json`, `selection.json`,
  `status.json`, `instrumentation.json`, `capture-gaps.json`;
- sanitized phase stdout/stderr, assertion report and service/PostgreSQL logs;
- sanitized fixture projection JSON, never database files or SQL dumps;
- sanitized Playwright trace archives, report files and failure screenshots;
- `manifest.json` listing every staged file, size and SHA-256.

Reject symlinks, path escapes, hidden files and unlisted files. Process trace zip
entries and HTML attachments recursively: remove authorization/cookie headers,
request bodies and storage state; retain only synthetic loopback/fixture network
content and approved screenshots. Drop unsafe attachments with explicit omission
records. A regex pass over an opaque archive is insufficient. Unknown data is
excluded, not uploaded on a best-effort assumption. Never upload raw homes,
`.env`, `.git`, node_modules, database directories, generic test-results globs,
workspace archives or real instance data. Fixture-only status does not waive
redaction, because synthetic JWTs and credentials can still be present.

Use one unique artifact per run/attempt/arm/lane, retention-days=7, compression
and an aggregate 100 MiB sanitized cap per job. At the cap, record truncation and
evidence incompleteness; never hide a failed upload or truncate assertions
silently. Workflow logs must also be sanitized before console emission, since
GitHub retains them separately. Confirm repository log retention is at most
seven days before dispatch; if it is longer, arrange authorized per-run deletion
at day seven in the execution handoff, without changing global settings. Private
raw buffers exist only on the disposable runner and die with that runner.

## Status and interpretation

Record independent checkout, install, build, selection, observer, test, cleanup,
sanitize and upload outcomes, numeric exit codes or signal/deadline, start/end
times and GitHub step/job conclusion. Preserve the test exit through `tee` and
finalization. Upload success never converts a failed test or setup into success.
Distinguish not-started, skipped, cancelled, timed-out, source/integrity failure,
setup/infrastructure failure, test assertion failure and capture/upload failure.
An observer failure makes evidence incomplete even when tests pass. Cleanup
failure is separate from the earliest assertion failure and cannot erase it.

The executor writes exactly four result rows with full source SHA, run/job URL,
phase/status/exit, selected and executed cases, failing assertion, relevant
database log references, artifact URL/ID and capture gaps. Missing artifacts
remain explicit rows. Cross-arm interpretation is lane-specific:

| Observation | Permitted conclusion |
| --- | --- |
| Same relevant failure in base and merge, comparable setup | Evidence of baseline failure for that assertion |
| Both pass | Not reproduced under recorded diagnostic conditions |
| Only merge fails | Return evidence to upstream follow-up for narrowing |
| Setup fails, identity drifts, or required evidence is missing | Inconclusive comparison; no business attribution |

Matching HTTP status alone is not the same failure signature. Compare assertion,
test, phase and database evidence. A cleanup 500 alone does not explain earlier
trace assertions. Results do not approve upstream code or permit a ready
transition, external-wait declaration or upstream update/rerun budget change.
The existing upstream follow-up keeps its owner, branch, participants, decisions,
review counters, responsible human and 0/2 upstream update/rerun allowance.

## Verification and staged handoff

This planning task changes only this dated document. It creates no script or
workflow and sends no dispatch. Review the exact documentation commit, compare
all #316 requirements, check links and `git diff --check`, and inspect applicable
documentation CI. No product test, build or typecheck is evidence for a prose
plan; host-wide build/typecheck remains prohibited.

After independent cross-type approval and documentation checks, merge the exact
reviewed document PR and verify #316 closes. The reviewer records the approved
commit, task plan revision and merged commit. Implementation has its own task,
PR and independent review. It must verify matrix dimensions/guards, SHA and
parent rejection, identical digests, immutable-file rejection, phase exit
preservation, no retry, safe-upload rejection (including archive secrets),
snapshot-before-cleanup, timeout finalization and setup-failure reporting using
synthetic tests. Full compilation/build checks belong to GitHub CI.

Only after that implementation is reviewed and merged does the existing
execution task receive: approved plan SHA/revision, implementation and dispatch
SHA/tag, helper/config digest, fixed four rows and commands, original run link,
unique execution key, intent record, capacity/retention confirmation, artifact
allowlist and deadlines. Its assigned operator sends one dispatch, records the
resulting run ID and attempt, and returns the four-row evidence table. No new
workflow registration test run or dispatch dry-run may consume an extra run.
No binder/prepare/launch/runtime action, publishing, restart, real model call or
paid allocation is included. Launch budget remains 0. This plan grants no
implementation or execution approval by itself.
