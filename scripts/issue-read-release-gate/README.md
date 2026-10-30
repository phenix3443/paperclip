# Issue-read release evidence

This harness implements the bounded comparison in #122. It does not change
runtime code or authorize deployment. `manifest.json` pins the deployed incident
baseline, runtime candidate and matching package artifact. A new candidate needs
new evidence and independent exact-SHA approval.

The workflow checks out each runtime SHA in its own directory and runs the same
probe against that checkout's production Express routes and PostgreSQL schema.
Only authentication identity is supplied by the fixture. Services, routes,
database queries, Git work and the Codex skills adapter are real. This is an
assembled route test, not a test of the production authentication middleware.
Foreign-company HTTP access and the company-scoped stored-workspace getter are
checked separately. No service instance, production database or credential is used.

Each arm has 75 distinct Git worktrees with 11,480 tracked files each, 75 tasks,
75 attached runtime-service records and 50 synthetic skills. Files are empty
except README; the fixture reproduces file count, not production file contents.
Runtime-service rows describe fixture records; no web process is started.
Two complete warmups precede measurement. Each path gets 20 requests at
concurrency 1 and 4, before and after a 31-second cache expiry interval. Additional
coverage requests read all 75 workspaces through detail and heartbeat-context.
Each measured batch and coverage pass has a 120-second deadline. The outer probe
has a ten-minute process-group limit in CI.

Raw samples include errors, latency, median/p95/max, Git commands and status-scan
counts, Node CPU, waited-child CPU and Node peak RSS. Linux `/proc/self/stat`
provides child CPU ticks. Child CPU includes completed Git children, not the
still-running PostgreSQL server. Git command count measures Git process demand;
it does not measure the peak number of simultaneous OS processes. No improvement
in skills catalog work is attributed to the workspace-read repair.

Candidate task reads must perform zero Git commands, including past TTL. Both
arms must complete every request. Each paired list/skills median must be within
10%. Failures are retained in JSON and logs; there is no automatic retry-until-pass.

The close exercise covers clean, dirty, untracked, local and unpushed commits,
slow Git status, blocked archive on uncertainty, recovery and clean archive.
Mutation cases follow a metadata read. Explicit readiness must inspect afresh.
The fixture marks its task terminal before checking close safety so an open task
cannot mask an unsafe inspection result. A PATH shim delays only `git status`;
the production Git scheduler must time out that real child. A failed inspection
must block archive with 409 and retain the active workspace. Existing workspace
expiration/finalization and close-route suites run beside the probe in CI.
The heartbeat finalization branch-guard suite exercises the real heartbeat
service with PostgreSQL and Git. Only the adapter execution is synthetic.

Run only in an isolated CI checkout with dependencies prepared:

```sh
RELEASE_EVIDENCE_ARM=candidate \
RELEASE_EVIDENCE_OUTPUT="$RUNNER_TEMP/evidence" \
PAPERCLIP_WORKSPACE_GIT_SCAN_TIMEOUT_MS=1000 \
timeout --kill-after=10s 600s node server/node_modules/tsx/dist/cli.mjs server/src/__tests__/helpers/issue-read-release-probe.ts
node scripts/issue-read-release-gate/compare.mjs "$RUNNER_TEMP/evidence"
```

The probe requires HEAD to equal the selected runtime SHA. The workflow copies
only this harness from the evidence checkout; it does not patch either runtime.
The certificate remains **pending** until results, required CI, package identity,
upstream ancestry, merge/review provenance and finalization evidence are checked
and an independent reviewer approves both the evidence head and candidate SHA.

The probe lives in the test-fixture directory because it directly seeds synthetic
agent records. It is not a production agent-creation path. The lifecycle boundary
checker stays unchanged. The first evidence head passed its probe but failed the
PR policy check for placing that fixture in `server/scripts/`; this relocation
corrects the fixture boundary and requires CI on the new evidence head.
