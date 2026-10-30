# Issue-read candidate evidence — 2026-10-30

Status: **measurement passed; certificate pending**. No deployment is authorized.
The evidence head `c0a986ef9f1f5af5169872b686c092448c30c279` passed the
[paired evidence workflow](https://github.com/phenix3443/paperclip/actions/runs/41023221092).
Its full PR CI failed policy because the synthetic agent seed lived in
`server/scripts/`. The corrected evidence head must pass CI and independent
review before this record can become a release certificate.

## Fixed versions and artifacts

- Baseline: `fdbafff72d8fd6ae7f12eb5827631efc67d208f3`.
- Runtime candidate: `6cda8f0c46636f8abd42375e57794cff59da258a`.
- Reused upstream merge: `100477e8876f51add368554643e073a2d1c1becf`.
- Candidate [package run 41018500178](https://github.com/phenix3443/paperclip/actions/runs/41018500178): successful push on develop. Artifact `12961445041`, name `paperclip-payload-6cda8f0c46636f8abd42375e57794cff59da258a`. The evidence workflow downloaded it and checked every package SHA-256 against its candidate-bound manifest.
- [Raw evidence artifact 12963591918](https://github.com/phenix3443/paperclip/actions/runs/41023221092/artifacts/12963591918), digest `sha256:fa6c18685e3cf759acd08527a2727e1d9acd698d909a7cbba2347159a215dbf5`.

## Experiment

Each arm ran production Express routers and PostgreSQL in its pinned source
checkout on the same CI runner. The fixture supplied authentication identity and
seeded 75 distinct Git worktrees, 11,480 tracked files per worktree, 75 tasks,
75 runtime-service records and 50 company skills. There were two complete
warmups. Each measured batch had 20 requests and a 120-second deadline.
A 31-second quiet interval preceded the past-TTL phase. Full coverage separately
read all 75 workspaces through both task detail and heartbeat context.

The fixture files are empty except README. No production process, database or
credential was exercised. The services are persisted fixture rows, not running
web processes. Authentication middleware itself is outside this fixture.
Concurrency 4 follows concurrency 1, so its baseline cache is warm again; this
run does not measure 75 simultaneous cold Git inspections. Raw records retain
all request samples, CPU, RSS, close results and Git trace counts.

## Measured medians

All 320 measured requests per arm succeeded. Candidate task-read batches and
both full-workspace coverage passes ran zero Git commands. Baseline past-TTL
detail at concurrency 1 ran 20 status scans; the following full coverage ran 55,
covering all 75 distinct workspaces. Warm reads alone would not expose that cost.

| Phase | Path | Concurrency | Baseline median ms | Candidate median ms | Baseline p95 ms | Candidate p95 ms | Baseline / candidate scans |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| warm | detail | 1 | 30.30 | 25.51 | 70.01 | 34.81 | 0 / 0 |
| warm | context | 1 | 12.72 | 10.77 | 15.66 | 12.37 | 0 / 0 |
| warm | list | 1 | 22.31 | 22.37 | 31.26 | 27.01 | 0 / 0 |
| warm | skills | 1 | 111.04 | 78.74 | 118.53 | 87.54 | 0 / 0 |
| warm | detail | 4 | 67.26 | 65.24 | 76.94 | 76.71 | 0 / 0 |
| warm | context | 4 | 30.99 | 30.47 | 39.83 | 42.25 | 0 / 0 |
| warm | list | 4 | 31.10 | 30.34 | 42.55 | 33.49 | 0 / 0 |
| warm | skills | 4 | 144.23 | 110.57 | 185.37 | 138.95 | 0 / 0 |
| past-cache-ttl | detail | 1 | 130.03 | 25.03 | 141.86 | 74.50 | 20 / 0 |
| past-cache-ttl | context | 1 | 10.86 | 11.17 | 12.86 | 16.61 | 0 / 0 |
| past-cache-ttl | list | 1 | 20.55 | 20.36 | 23.72 | 25.87 | 0 / 0 |
| past-cache-ttl | skills | 1 | 106.46 | 74.35 | 114.74 | 80.22 | 0 / 0 |
| past-cache-ttl | detail | 4 | 66.67 | 63.61 | 72.82 | 68.45 | 0 / 0 |
| past-cache-ttl | context | 4 | 33.84 | 29.79 | 45.48 | 32.33 | 0 / 0 |
| past-cache-ttl | list | 4 | 30.22 | 30.48 | 40.58 | 36.78 | 0 / 0 |
| past-cache-ttl | skills | 4 | 152.63 | 109.00 | 180.57 | 147.97 | 0 / 0 |

Every paired list/skills median met the maximum 10% regression limit. The worst
list ratio was 1.00879 (0.88% slower). Skills medians were lower in this combined
candidate, but this comparison does not isolate workspace-read changes from
other upstream changes and does not attribute skills work to that repair.

For past-TTL detail at concurrency 1, baseline Node CPU was 0.932 s plus 1.64 s
of completed-child CPU; candidate Node CPU was 1.011 s with zero completed-child
CPU. These counters exclude the still-running PostgreSQL server. Git command
count measures spawned work, not peak process concurrency. See the raw JSON for
all CPU, RSS, p95 and maximum values.

## Close safety and regressions

Both arms observed clean readiness and fresh dirty/untracked/local/unpushed
warnings after metadata reads. A real delayed Git child caused inspection to
fail closed: readiness was blocked, archive returned 409, the row stayed active
and the worktree remained. After restoring Git, readiness recovered. A separate
clean workspace archived successfully with HTTP 200. Candidate reads preserved
runtime-service ID, running status, healthy status and URL. A foreign-company
request was denied and the company-scoped stored getter rejected the foreign ID.

Candidate regression CI passed **124 tests**, zero failures and zero skips:
comparison failure scenarios, issue context routes, closed-workspace routes,
Git expiration, inspection cache and real heartbeat finalization branch guard.
The heartbeat suite uses real PostgreSQL/Git and a synthetic execution adapter.
The raw report contains the test names and assertions; this is bounded fixture
coverage, not a proof of every production recovery path.

## Retained failure and remaining gates

[PR CI run 41023221145](https://github.com/phenix3443/paperclip/actions/runs/41023221145)
failed its policy check with:

```text
server/scripts/issue-read-release-probe.ts: Use the agent lifecycle module to insert an agent
```

All eight E2E shards passed. The E2E and verify aggregate gates failed because
policy failed. Build, Typecheck + Release Registry and server-typecheck passed.
Moving this direct-seed test fixture under `server/src/__tests__/helpers/`
corrects ownership without relaxing the boundary gate or changing runtime code.
The new evidence head must obtain fresh required CI. The old failure remains
recorded; a later pass does not erase it.

The complete upstream/fork merge and approval provenance, final evidence head,
independent exact-head/runtime-candidate decision and evidence merge SHA remain
pending. This document does not close #122 or #114. It does not authorize #115
deployment. Any runtime candidate change invalidates this evidence.
