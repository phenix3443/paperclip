# Port the three remaining upstream-only fixes to `develop`

Date: 2026-11-02. Design only. Requirement: [#373](https://github.com/phenix3443/paperclip/issues/373).
Implementation slices: [#374](https://github.com/phenix3443/paperclip/issues/374),
[#375](https://github.com/phenix3443/paperclip/issues/375),
[#376](https://github.com/phenix3443/paperclip/issues/376).
Implementation starts only after a cross-type reviewer approves the exact SHA of
this document, the plan PR merges into `develop` and #373 is closed. This document
changes no runtime behavior.

This is fork-only delivery. The upstream PRs are read as sources. Nothing here
creates, comments on, pushes to or closes an upstream PR or issue. Old upstream
approvals do not approve any fork SHA.

## Baseline and source identities

| Input | Identity |
| --- | --- |
| `origin/develop` (fetched at plan revision 2) | `18e1723597cf43af09547ae4c869851f907e1bfb` |
| Upstream PR 18039 head | `3da2fc8a406c8689d6e5450058d00e5b6d2c5e30` |
| Upstream PR 18060 head | `b88510990d7c59be1b2b1371d8c4774f36a7fc87` |
| Upstream PR 18496 head (closed), fork `fix/bundle-patched-postgres-driver` | `dd2446725e27cb5fb5f0cb9ec2b58b3bdef5f242` |
| PR-1 follow-up, fork `fix/bundle-patched-postgres-driver-review` | `6a803351535700a15bb0c9f952a188da6b920b4b` |
| PR-2 follow-up, fork `fix/upstream-postgres-followup18496` (local ref) | `0c15f2e9c85a0ee8f8bea0a17abe4ae1bae23972` |
| Fork base postgres fix, PR #308 merge | `4376ec6f80490b2a9c44f61938b2d1e996880f5a` |

Revision 1 used `4c4a4be3a6639c6f5b7f268823b368180b985f9f`. The five commits
since then touch none of the files named below except an unrelated addition to
`doc/DEVELOPING.md`. Each implementation PR re-fetches `origin/develop`, records
the new SHA and re-checks the "already on develop" claims below before writing
code.

## Summary

| Slice | Missing on develop | Patch shape |
| --- | --- | --- |
| #374 terminal retirement (18039) | Runtime: nothing. Regression coverage: most of the PR's cases | Tests only, unless a ported test fails; working-tree mutations show the tests catch the bug |
| #375 superseded queued review (18060) | Retiring a superseded queued review before coalescing (`ca95288`) and the claim-time generation recheck (`2889c597`); the rest is on develop via fork #168 | One runtime PR, about 50 runtime lines plus tests |
| #376 postgres follow-ups (18496) | Checkout-derived driver expectation, strict patch-config reading, payload record carried in the export manifest, same-package link allowance, `packGitPayload` seam, required skills/version/production checks in `deploy-packages`, and the packaging gaps those checks prove | One runtime PR, fork CI export kept |

There are no code dependencies between the slices. They touch disjoint files
(#374 and #375 share no runtime file; #376 is CLI/scripts only). Order:
#374, #375, #376, smallest risk first. Any order is safe; each PR rebases on the
`develop` it merges into.

## Slice 1: terminal retirement (#374, upstream 18039)

### Source

Own commits, net +177 lines (23 runtime, 134 tests, 20 docs):

- `700c142243444a97bcde5216d2e5ab235f6794b3` empty preparation commit
- `55422020ee5d021e3763786f9c083ca046ae292c` retire reserved reviewer receipts on terminal task updates
- `939c03947c58684b9246283c65bd68491a86959e` protect reserved receipt history during terminal reassignment
- `f5a8bccf01304a1555854febc980b7b156aba9ab` cover terminal retirement notification settlement

The rest of the PR branch is upstream-master merge history and is not imported.

Behavior: inside `issueService.update`, after the issue row update and on the
caller's transaction, a terminal status (`done`, `cancelled`) cancels this
company's unfinished (`queued`, `deferred_issue_execution`, `claimed`),
unlinked (`runId IS NULL`) wake receipts that carry the reserved reviewer key
for this issue. Presence of the key is what counts, so null, malformed and
unknown-version values are retired too. The receipt's payload, source,
requester and finished rows are kept. The outer transaction's rollback undoes
the retirement with the status change. `939c0394` excludes reserved receipts
from the generic "user direction" cancel on assignment change, so a terminal
update that also clears the assignee retires them once, with the terminal reason.

Temporary holds (`blocked`, `in_review` and other non-terminal states) keep the
reserved duty. A hold means the reviewer still owes a decision when work
resumes; only a real end of the task ends that duty.

PR 18039 states that upstream has no producer of the reserved key ("No
production code writes this reserved key yet"). Upstream it is a defensive
lifecycle contract, not reviewer scheduling. This port does not activate or add
any scheduling.

### Develop difference

Develop already has the behavior, from fork #154 (`de749e29d623`), with a wider
scope. Develop also has a live producer and consumer of these receipts
(`createReviewerAssignmentIntent`, `consumeReviewerIntent`, `admitReviewerIntent`),
which is a fork difference, not something this slice adds.

- `server/src/services/heartbeat/reviewer-assignment-continuation.ts`:
  `retireReviewerIntents(tx, scope)` covers issue, agent and company scope.
  It uses `not(ordinaryWakeRequestPredicate())`, the same SQL as upstream's
  `reviewerIntentPredicate`, with the same status set, `runId IS NULL` and
  company filters.
- `server/src/services/issues.ts`: the terminal hook (around line 11971, reason
  `Task was marked ${status}`) and the user-direction guard (around line 11887)
  are present.
- Extra develop callers: company archive, agent termination and run Stop.
- `git merge-tree` reports conflicts for every source commit, and the runtime
  hunks would duplicate develop code. Do not cherry-pick.

### Smallest patch

Port the PR's test cases into
`server/src/__tests__/heartbeat-reviewer-intent-retirement.test.ts` (reuse its
`seed()`), as a nested `describe("terminal task retirement")`. Run them against
unchanged develop. A case that fails is a real gap. Fix only that gap in the
owner seam above and say so in the PR. If every case passes, the PR is
tests-only and its body says develop already had the behavior. No doc or map
change is required; one sentence that reopening does not revive a retired
receipt may be added to `doc/DEVELOPING.md` next to the existing contract.

### Proving the tests catch the bug when develop already has the fix

#374 asks for a demonstrated failing case before the fix. If the runtime is
already on develop, there is no "before" commit to run against, so the PR shows
the failing case by temporarily disabling the existing fix in the working tree.
These changes are never committed:

| Mutation (working tree only) | Cases that must fail |
| --- | --- |
| Skip the terminal hook call to `retireReviewerIntents` in `issueService.update` (around `issues.ts:11971`) | `cancelled` then reopen, the four malformed-key `done` cases, `blocked` then `cancelled`, rollback |
| Remove the reserved-receipt exclusion from the user-direction cancel (around `issues.ts:11887`) | Cancel plus `assigneeAgentId: null` (wrong reason, or retired twice) |
| Drop `runId IS NULL` or the company filter from `retireReviewerIntents` | Run-linked and other-company receipts unchanged |

For each mutation the PR body records the command, the affected test file, and
the exact failing test names from the vitest output. It then records the same
command passing on the unmodified head. A mutation that no test catches is a
coverage gap: add or tighten a case until it fails, and do not call the slice
done. If a ported case fails against unmodified develop, that case is the
before-fix evidence and the runtime fix goes in the owner seam above.

#374's acceptance line has been reworded to match (plan revision 2): "a
demonstrated failing case before the fix, or, where develop already has the
runtime, the same cases failing against a working-tree mutation that disables
it". The PR must not claim a red/green run that was not executed.

### Regression matrix

| Case | Expectation |
| --- | --- |
| `cancelled` then reopen to `todo` | Receipt cancelled with reason and `finishedAt`; payload unchanged; reopen does not revive it |
| `done` with reserved key `null`, `"malformed"`, `false`, `{version:99}` | Each retired |
| `blocked`, then `cancelled`, for `queued` and `claimed` | Kept through `blocked`, retired on `cancelled` |
| Cancel plus `assigneeAgentId: null` | Ordinary, already finished, run-linked and other-task receipts unchanged; reserved receipt retired once with terminal reason |
| `done` / `cancelled` inside an outer transaction | Notifications (`chatInboundWakeNotices`, `nativeStatusReassessment`) settle at outer commit, company scoped |
| Outer transaction rolls back | Issue status and receipt both unchanged |

Develop's `issueService.update` may signal the same queues more than once on
the terminal path. If an exact-count assertion fails for that reason only,
assert presence and scope instead, and record why in the PR.

Existing tests that must stay green: the other `heartbeat-reviewer-intent-*`
suites, `heartbeat-queued-comment-reviewer-intent`,
`heartbeat-task-drain-admission-release`, `durable-chat-wakeup`,
`modules/wake-queue/adapters/postgres.test.ts`, `services/task-retry.test.ts`,
`services/workspace-recovery.test.ts`, `issue-recovery-actions.test.ts`.
Run these with no heartbeat workers active, as the source fixture does, so
develop's consumer cannot race the synthetic rows.

## Slice 2: superseded queued review retirement (#375, upstream 18060)

### Source

PR 18060's own commits (merges excluded; its base `51c3f8924c` is in develop):

| Commit | Change | On develop |
| --- | --- | --- |
| `9878cee17de101ae2d3f6e4c82eb392ce28253a1` | Empty opening commit | n/a |
| `f78023246523b126b3773e5434b040143eb446e1` | Reject review dispatch after submission changes | Yes, fork #168 |
| `3b1ee7c39c05e5e44d7fb0b59eded710128aecea` | Keep current task gates at review dispatch | Yes, #168 |
| `0585a68c9ed391069253f70aad0c47d08cee4dcc` | Remove redundant comment | Yes, #168 |
| `e93ded5005a1586009beaff1c84a7e12228d23d1` | Atomically consume reviewer monitors during admission | Yes, #168 |
| `f3025682aea44381f447a351dea46b7bc20857c8` | Docs for monitor admission | Yes, #168 |
| `0d8f03c10bd28a9cf6891be245f97a983008827d` | Settle review identity and quota retry monitor evidence | Yes, #168 |
| `edb143c286c0f93955b9a29dbd988c1408fca03f` | Keep queued review identities consistent through claim | Yes, #168 |
| `9a5aa87febc786e263c66a934634704cdfab6192` | Honor queued message edits and quota recovery ownership | Yes, #168 |
| `0b147bd28faf3dcf0e9c9ebabdcde0a13f24e763` | Preserve verified pause interactions at review dispatch | Yes, #168 |
| `fe31164983f25e8f8eda8e7b38870fe854e9684c` | Cross-agent review and conversation quota retries | **No** (out of scope, see below) |
| `59d86147188062416eacc08af11def17a34bf8c7` | Verified reviewer comments on blocked dependencies | **No** (out of scope, see below) |
| `ca952889197ba54d4871ff211d14e8b853e7eced` | Admit fresh comments after queued review submission changes | **No: this slice** |
| `b88510990d7c59be1b2b1371d8c4774f36a7fc87` | Run-log docs for queued review retirement | **No: this slice** |

Fork branch `fix/upstream-18060-followup` (`db18578b50788cf9aa4801d73a460037c11fcaec`)
adds `2889c597a2167e491e212e2960deaabfe514a15d` (recheck the review generation
before the identity-free early return in `settleReviewRunClaimIdentity`;
**no** on develop: this slice), a test typing fix `db18578b`, and an
upstream-master merge that is not imported.

Fork #168 (`ef5a32b032`) is the earlier 18060 port. Fork #227 (`8f036b0316`)
is the separate same-generation wake context fix (`appendQueuedComment`): a
comment for a still-queued run of the same generation is appended to that run;
for a stale generation it returns `null`. Both stay as they are.

### Missing behavior

In `enqueueWakeup`'s issue-locked admission (`server/src/services/heartbeat/queue.ts`),
develop's `cancelStaleScheduledRetry` (around line 3770, called near 3902 for
`activeExecutionRun` and near 4008 for `legacyRun`) only cancels stale
scheduled retries. A queued review whose `contextSnapshot.reviewerAssignmentGeneration`
no longer matches the issue's current generation is left in place, so a fresh
comment is coalesced into or deferred behind a run the dispatch gates will
reject. Upstream `ca95288` widens it to `cancelStalePendingRun`:

- Also retires a run with `status === "queued"` whose generation differs from
  `issueExecutionGeneration(issue)` (develop's alias `reviewerAssignmentGeneration`).
  Running, claimed and finished runs are never touched.
- Sets `errorCode = "issue_review_participant_changed"`, writes a warning
  lifecycle event, updates the linked wake and clears `issues.executionRunId`.
  The old run's `contextSnapshot` and generation are kept unchanged.
- Runs before coalescing and before `admitWakeBehindIssueExecution`, so the
  fresh wake gets a new run with the current generation.
- Runs in the issue transaction; if the fresh admission fails, the retirement
  rolls back.

`2889c59` closes the claim side: a queued review without an active identity
context is rechecked against the current generation before it can be claimed.

Existing full-generation gates stay: claim (`claimQueuedRun`,
`settleReviewRunClaimIdentity`, `bindClaimedIssueExecution`), provider
(`reviewerGenerationStaleness`, `decideQueuedRunStaleness`), new-run identity
(`settleNewReviewRunIdentity`) and monitors (`recordReviewQuotaMonitorInstallation`,
`assertQuotaSourceEligibility`, `ReviewQuotaMonitorHeld`). Retirement adds a
cleanup before them; it does not replace any.

### Smallest patch

Hand-port, do not merge the follow-up branch (it is upstream-based and lacks
fork-only code).

1. Replace `cancelStaleScheduledRetry` with `cancelStalePendingRun` in
   `queue.ts`, taking the resolved version from `fix/upstream-18060-followup`.
   Keep develop's extra notifications (`notifyExternalAgentSettlement`,
   `notifyUnsafeWorkspaceExportRunChange`) and fork-only predicates
   (`ordinaryWakeRequestPredicate`, `isPendingInteractionAddressee`).
2. Apply the `run-identity.ts` hunk of `2889c59` (merges cleanly).
3. Add `server/src/__tests__/heartbeat-review-submission-generation.test.ts`
   with only the cases for this behavior (below), adapting seeds to develop.
4. Add the `doc/DEVELOPING.md` paragraph by hand and take the
   `run-log-events.md` section of `b885109`.

`queue.ts` is already far above 1,000 lines; this patch changes about 46 lines
in it and adds no new file over 1,000 lines.

### Regression matrix

| Case | Expectation |
| --- | --- |
| Fresh comment after submission changes, same reviewer, issue locked / unlocked | See "Provider start" below; both variants run the whole path, not only admission |
| Fresh admission fails after retirement | Old run still queued, `executionRunId` unchanged (rollback) |
| Superseded run already `running` | Not cancelled; existing gates decide |
| Same-generation queued run (#227 path) | Comment appended to that run; no retirement |
| Identity-free queued review, generation changed after preflight | Claim rejected (`2889c59`) |
| Older submission at queued / preparing execution gate | Rejected, as today |

#### Provider start (locked and unlocked)

Creating a new run is not enough: #375 asks that the fresh wake reaches the
provider through normal queue processing. The source test
(`delivers fresh comments after the submission changes with the same reviewer`,
`it.each([false, true])` in `heartbeat-review-submission-generation.test.ts` on
`db18578b`) is ported for both `locked` values. It sets the agent's adapter to a
`process.execPath -e` command that appends `PAPERCLIP_RUN_ID` to a marker file,
holds the agent with a `running` busy run, queues the original review, adds a
comment for the old submission (appended to the original run), changes
`executionState.reviewRequest`, sends a fresh comment, then finishes the busy
run and calls `resumeQueuedRuns()` and `drainActiveRunExecutions()`. Required
observations, each asserted:

- The marker file contains exactly one line, the fresh run's ID. The old run
  never started a provider process.
- The fresh run is `succeeded`, its `reviewerAssignmentGeneration` differs from
  the old run's, and its `wakeCommentIds` contains the fresh comment.
- The old run is `cancelled` with `errorCode = "issue_review_participant_changed"`,
  and its `contextSnapshot` equals the snapshot read before the change
  (including the old comment ID).
- The fresh comment's wake row links to the fresh run; the old comment's wake
  row stays linked to the old run.

For `locked = true`, `issues.executionRunId` is set to the original run before
the fresh comment, so the retirement must also clear the lock. The adapter
command and marker path go in the test's temp directory and are removed in
`finally` together with `drainActiveRunExecutions()`.

The claim race (`2889c59`), rollback and #227 same-generation cases stay as
listed in the table above.

Tests that must stay green: `heartbeat-queued-comment-inline`,
`heartbeat-queued-comment-reviewer-intent`, `modules/wake-queue/adapters/postgres.test.ts`
(stale-generation and generation-reject cases), `heartbeat-reviewer-intent-consumer`,
`heartbeat-reviewer-intent-retirement`, `heartbeat-reviewer-identity-admission`,
`heartbeat-reviewer-monitor-generation`, run-dispatch `postgres.test.ts` and
`policy.test.ts`, `issue-monitor-scheduler.test.ts`, `issue-recovery-actions.test.ts`,
`scheduling.test.ts`, `decided-review-reassignment.test.ts`,
`reviewer-continuation-evidence.test.ts`.

Risk: with retirement before the #227 append path, a comment for a stale queued
review now creates a new run instead of being deferred. No develop test was
found expecting deferral there; if one exists, the PR states why its
expectation changes.

### Found missing but outside #375

`fe31164` (dispatch for cross-agent reviewer runs with
`enforceContinuationOwnership === false`, and conversation-continuation quota
retries in `reviewer-quota-monitor.ts`) and `59d8614` (verified reviewer
comments allowed through a dependency-blocked hold) are absent from develop
(`run-dispatch/adapters/postgres.ts` around lines 1396, 1510 and 654;
`reviewer-quota-monitor.ts` line 24). Each is a separate behavior, not the
queued-review retirement #375 asks for, so this plan does not add them to the
#375 PR. Whether to port them, as separate issues, is a decision for CTO.

## Slice 3: postgres driver follow-ups (#376, upstream 18496)

### Source

The complete follow-up delta is `756599e4ea069c9338c320fe8846523d3dfb92a0..0c15f2e9c85a0ee8f8bea0a17abe4ae1bae23972`.
`756599e4` is the upstream-master base the branch was rebuilt on. The upstream
merges in that history (#18364, #18504 and earlier) are excluded. The twelve own
commits, in order:

| Commit | Change |
| --- | --- |
| `e8391c0fdbc06ad8c4c03872eefe89c1f5d6bb7f` | Install the patched driver as the payload's single root copy (rebuilt equivalent of 18496's `f84881c4`) |
| `e4f635046af032c49f7fe4efe62d89bae74aee2e` | Reject any linked file in the payload (rebuilt equivalent of 18496's `dd244672`) |
| `961cc2de63d9e1896be7c549bc3276432e336de4` | Derive the expected driver from the selected checkout |
| `dda4193e42fd8e4de82f1bc00bb642bcabe22d04` | Allow file links that stay inside their own package |
| `f11ba9a3a69c0083628c469b38800c80fb978348` | Reject patch configuration the reader cannot parse |
| `6a803351535700a15bb0c9f952a188da6b920b4b` | Read indented and escaped configuration instead of treating it as unpatched (PR-1 tip) |
| `478f5c5f2733d5846b5f858961a3a9d698e6a72f` | Real git-payload install from an empty directory; `packGitPayload` extracted |
| `28fbba337ab7f2199b41263717b1355ee3ad67db` | Prepare server `ui-dist` before packing |
| `3f34e8e09f401787329535c9294b12e235ccd528` | Copy skills into packaged workspaces before packing |
| `e5a7856520b3381fad4144c120f9ec13e93dc825` | Skip lifecycle scripts when packing staged bundled packages |
| `3a98b088a3e8d88bcef178a45f1c30b80e69dfe4` | Unify workspace package versions before packing |
| `0c15f2e9c85a0ee8f8bea0a17abe4ae1bae23972` | Build the verified payload with the install path's environment (PR-2 tip) |

Net delta over that base: 8 files, +1261/-39.

### What develop already has (PR #308)

`cli/src/postgres-driver-integrity.ts` on develop pins the patched driver in a
constant, `PATCHED_POSTGRES_DRIVER` (version `3.4.9`, four file hashes). It
rejects any symlink except same-directory file links and payload-internal
`node_modules/.bin` links, requires exactly one driver at
`node_modules/postgres`, and checks that `paperclipai`, `@paperclipai/db` and
every `drizzle-orm/postgres-js` resolve that copy for both ESM and CommonJS.
`cli/src/commands/install.ts` packs the patched driver with `--ignore-scripts`
and installs it at the root. Fork-only pieces that must remain:

- `exportGitPayloadPackages` and `PAPERCLIP_INSTALL_PACKAGES_DIR` in
  `install.ts`. The source branch deletes them because upstream has no such
  export. Deleting them breaks `deploy-packages` and the ai-team deploy.
- `.github/workflows/deploy-packages.yml`, `scripts/verify-postgres-final-install.mjs`
  and `scripts/postgres-close-probe.mjs`: the clean empty-directory install of
  the exported packages, run twice, with the close/live probe. This is the
  fork's real installed-payload integrity test and stays the acceptance gate.
- `PATCHED_POSTGRES_DRIVER` remains exported as the fork's pin.
  `verify-postgres-final-install.mjs` and `scripts/postgres-patch-packaging.test.mjs`
  use it, and the packaging test already asserts it equals the registry
  driver with the repository patch applied. Keeping it means a deploy artifact can
  never pass with an empty or drifted expectation.

### Missing behavior to port

1. **Checkout-derived expectation.** `readCheckoutPostgresDriver(checkoutPath)`
   reads the installed driver's version and the files named in the matching
   `patches/postgres@<version>.patch`, hashing them from the checkout. The
   installer verifies the staged payload against that, not against a constant,
   so an install of a SHA with a different patch is checked against its own
   patch.
2. **Payload record.** `writePostgresDriverRecord` stores the expectation as
   `.paperclip-postgres-driver.json` in the payload root. A reused payload is
   verified against its own record (`readPostgresDriverRecord`), which must
   contain exactly `version` and `files`, match the root driver's version, use
   package-relative paths and 64-hex hashes. How the record travels on develop
   is fixed in "Payload record across export and final install" below, because
   the source branch has no export step and writes the record only into the
   staged payload directory, which is neither inside any tarball nor copied by
   `exportGitPayloadPackages`.
3. **Strict patch configuration.** Entries come from `package.json`
   `pnpm.patchedDependencies` and from `pnpm-workspace.yaml`
   `patchedDependencies` (develop declares `postgres@3.4.9` in both). The YAML
   reader handles only the subset seen in real configs: block mappings with
   consistent indentation, plain, single- and double-quoted scalars with YAML
   escapes, and trailing comments. Anything else in that file, including flow
   mappings other than `{}`, duplicate `patchedDependencies`, merge keys (`<<`),
   anchors, invalid escapes or dedents below the root, is a hard error naming
   the line. It never falls back to "unpatched". A matching key that points to
   a missing patch file, or a patch listing no files, is an error. Only a
   checkout with no postgres patch entry at all yields an empty file set.
4. **Link policy.** Besides `.bin` links, a file symlink is allowed only when
   it and its target stay inside the same installed package, outside any
   nested `node_modules`. Directory links and links leaving the package or
   payload stay forbidden.
5. **`packGitPayload` seam.** Packing moves into an exported
   `packGitPayload(...)` so tests and the empty-directory script exercise the
   same code as `install`. On develop the export step stays in
   `installGitPayload`, after verify and smoke, exactly where it is today.
6. **Packaging gaps** (`prepare-server-ui-dist.sh`, skills copy into
   `server`/`claude-local`/`codex-local`, `--ignore-scripts` for staged bundled
   packs, `release-package-map.mjs set-version`, shared build environment).
   Develop's `install.ts` has none of the first four (`gitBuildEnv` already
   drops `NODE_ENV`). Whether each matters on develop is decided by the
   required installed-payload assertions below, which are added unconditionally.
   A packaging change is ported only when one of those assertions, or a unit
   test, fails on develop; the PR lists each gap as "reproduced and fixed" or
   "not reproduced, left out", with the failing output for the first kind.

### Payload record across export and final install

Owner: `cli/src/commands/install.ts` writes the record; `cli/src/postgres-driver-integrity.ts`
owns its format and validation (`readPostgresDriverRecord` plus a
`parsePostgresDriverRecord(value)` that validates an in-memory object with the
same rules, so the file reader and the manifest reader cannot drift).

Carrier: the export adds one field to the existing manifest,
`payload-packages.json`: `"postgresDriver": { "version": ..., "files": { ... } }`,
equal to the record written into the staged payload. It is not a separate
file. The service host's `deploy.py` (ai-team) rejects an artifact whose file
names differ from `{"payload-packages.json", *files}` and requires every
`files` entry to be a `.tgz`, so a separate record file would break deployment,
and listing it in `files` would make `npm install` treat metadata as a package.
`deploy.py` reads only `repo`, `sha`, `files` (and `provenance`) and ignores
unknown keys, so the added field is compatible; `schemaVersion` stays `1`.
`files`, the tarball names and the export location are unchanged.

Final install: `scripts/verify-postgres-final-install.mjs` reads
`manifest.postgresDriver`, validates it with `parsePostgresDriverRecord`,
requires it to equal `PATCHED_POSTGRES_DRIVER`, and verifies the installed
payload against it (`verifyPostgresDriverPayload(prefix, record)`). Missing,
malformed, or different from the pin, or not matching the installed files:
the script fails before the probes. The manifest checksum check that already
runs covers the tarballs; the record is trusted only after it matches both the
pin and the installed bytes, so editing it alone cannot pass.

Host cache compatibility: `deploy.py` installs the artifact into
`~/.paperclip/cli/installs/git/<sha12>` itself, without a record file, and then
runs `paperclipai install --repo ... --ref <sha>`, which takes the reuse path on
that directory. The source branch's reuse path fails on a missing record, which
would break every deploy. On develop the reuse path therefore:

- with a record: validates it strictly and verifies the payload against it;
- without a record: verifies the payload against `PATCHED_POSTGRES_DRIVER`,
  exactly what develop does today, and fails with "rebuild required" if the
  payload's root driver version differs from the pin's.

A payload built locally by `install --ref` always gets the record. Making
`deploy.py` write the record from `manifest.postgresDriver` would let the
fallback be removed later; that is an ai-team change and a decision for CTO, not
part of #376.

### Installed-payload assertions in CI (required)

#376 requires the real install to prove versions and skills, under the install
path's environment including `NODE_ENV=production`. `deploy-packages` is the
gate, so these become required checks there, added in the #376 PR whether or
not develop already passes them:

- Production environment: the "Install from source and export the packages"
  step passes `-E NODE_ENV=production` to `systemd-run`, so the build proves
  `gitBuildEnv` keeps devDependencies under an ambient production setting. The
  "Verify postgres in clean final installs" step exports `NODE_ENV=production`
  for both clean installs, so `npm install`, the module imports, `runtime setup
  pi` and the probes run as on the service host.
- Skills: for each package that ships `skills` (`@paperclipai/server`,
  `@paperclipai/adapter-claude-local`, `@paperclipai/adapter-codex-local`;
  the PR confirms the list from the packages' `files` fields), the installed
  `skills/` tree has the same file set and SHA-256 hashes as the checkout's
  `skills/` directory, and the checkout set is non-empty. Ported from the
  source `verifySkills`.
- Versions: exactly one installed `@paperclipai/plugin-sdk`, and
  `@paperclipai/server`'s dependency range for it equals that copy's version;
  `node_modules/.bin/paperclipai --version` equals `manifest.version` and the
  checkout's `cli/package.json` version. Ported from the source script.
- The record check above.

These go into `verify-postgres-final-install.mjs` (it already runs twice in
`deploy-packages` from an empty directory) and its report; the comparison of the
two runs includes the new results. `scripts/verify-git-payload-install.mjs` is
not ported: the final-install script is the one CI runs, and a second script
would duplicate it. The workflow `paths` filter already includes the touched
files.

### Files and owner seams

- `cli/src/postgres-driver-integrity.ts`: items 1 to 4, `parsePostgresDriverRecord`;
  keep the pinned constant.
- `cli/src/commands/install.ts`: item 5, the record write, the
  `postgresDriver` manifest field, the reuse-path fallback, and only the
  packaging items of 6 that a failing assertion proved; keep the export.
- `scripts/verify-postgres-final-install.mjs`: keep the pin; add the record,
  skills and version assertions.
- `.github/workflows/deploy-packages.yml`: `NODE_ENV=production` on the
  install and final-install steps; add any new script to the `paths` filter.
- Tests: `cli/src/__tests__/postgres-driver-integrity.test.ts`,
  `cli/src/__tests__/install-command.test.ts`,
  `cli/src/__tests__/update-command.test.ts`,
  `scripts/postgres-patch-packaging.test.mjs`.

Estimated core logic is about 450 lines, most in the YAML reader. The PR keeps
the source structure so review can compare it with the source commits.

### Regression matrix

| Case | Expectation |
| --- | --- |
| Develop checkout | Expectation equals `PATCHED_POSTGRES_DRIVER`; install, verify and export succeed |
| Reverted or changed patched file | Verify fails naming the file |
| Patch entry in `package.json` only, YAML only, both | Same expectation |
| Indented, quoted, escaped and commented YAML keys/values | Parsed, not treated as unpatched |
| Flow mapping, duplicate block, `<<`, bad escape, bad dedent | Hard error naming the line |
| Patch key for another version only | Error: patches do not match installed version |
| Patch file missing or listing no files | Error |
| Reused payload whose record has extra keys, wrong version, unsafe path or bad hash | Error, rebuild required |
| File link inside the same package | Allowed |
| Directory link, link leaving package, link into nested `node_modules` | Rejected |
| Second postgres copy anywhere | Rejected |
| `PAPERCLIP_INSTALL_PACKAGES_DIR` set | Same tarballs and `files` list as today; manifest gains only `postgresDriver`, equal to the staged record; no extra file in the export directory |
| Manifest `postgresDriver` missing, malformed, extra key, or different from the pin (vitest on `parsePostgresDriverRecord` and the pin comparison the script calls) | Final-install check fails before probes |
| Manifest record matches the pin but an installed driver file is altered | Final-install check fails naming the file |
| Reused payload with a valid record | Verified against the record |
| Reused payload without a record (deploy.py cache), root driver at the pin's version / another version | Verified against the pin / error "rebuild required" |
| `deploy-packages` on the PR head with `NODE_ENV=production` | Build succeeds; both clean final installs pass every control, including record, skills, plugin-sdk range/version and CLI version, and agree; recorded with the exact head and run URL |

Local checks are the affected vitest files and `node --test
scripts/postgres-patch-packaging.test.mjs`, with a time limit. The real install
(`paperclipai install --ref`, export, two clean installs) runs only in
`deploy-packages` on GitHub. No install or service command runs on the host.

### Out of scope

Public npm release redesign, upstream-master merge history, and any change to
how the service host deploys.

## Review, merge and release

Each slice is one PR against `develop`, `Closes` its issue, contains no upstream
close keywords, and gets a cross-type review of its exact head. A new head needs
a new review. Before merge the implementer checks that `HEAD` equals the
approved SHA and that required CI passed on it. After merge the implementer
confirms the issue is closed and closes it by hand if GitHub did not.

Merging is not deployment approval. After all three merge, the parent task
arranges release the normal way: an immutable tuple of reviewed source SHA,
`deploy-packages` artifact and baseline; execution by ops; acceptance on the
installed runtime by a reviewer who did not implement. Existing HOLDs stay in
place. This plan contains no deploy command and changes no policy.
