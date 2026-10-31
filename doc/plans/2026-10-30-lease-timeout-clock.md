# Lease timeout assertion plan

Date: 2026-10-30

## Problem and scope

[Issue #250](https://github.com/phenix3443/paperclip/issues/250) delivers this
plan. [Issue #83](https://github.com/phenix3443/paperclip/issues/83) owns the later
test correction and stays open when this plan is delivered. No test or runtime
code changes belong in this plan PR.

The test `preserves the exact lease when plugin-backed sandbox resume throws`
expects an RPC timeout of exactly `31234` on a real clock. The service sets a
deadline, then passes the remaining budget to the worker. A 1ms gap makes the
valid timeout `31233`. The existing failure report records this result in
[PR #69 CI](https://github.com/phenix3443/paperclip/actions/runs/40602245506/job/122533043569).
That historical failure is evidence from #83, not a new reproduction in this
planning task.

As a maintainer, I want the test to accept elapsed wall-clock time while still
proving that a failed resume preserves the same lease and creates no replacement.
I also want a controlled elapsed-time case that detects a reset of the timeout
budget on retry.

## Fixed baselines and upstream status

Checked on 2026-10-30 (America/New_York):

- Fork `develop`: `53fcf6fe5dce5f094f38edeca91f75da1ddb4c5b`.
- Upstream `master`: `4eaa435bf4225dd3dddd88f1094c17da739fbf7b`.
- Both versions still contain the same exact resume assertion and remaining-budget
  calculation. There is no merged correction to sync at these baselines.
- A search of fork and upstream PRs for `resume lease timeout` / `lease timeout`
  found related runtime work, but no focused correction of this assertion. Repeat
  the source comparison and duplicate search before the implementation PR.

The fixed source references are:

- [Fork resume test and invariants](https://github.com/phenix3443/paperclip/blob/53fcf6fe5dce5f094f38edeca91f75da1ddb4c5b/server/src/__tests__/environment-runtime.test.ts#L4820-L4927).
- [Fork resume budget and retry loop](https://github.com/phenix3443/paperclip/blob/53fcf6fe5dce5f094f38edeca91f75da1ddb4c5b/server/src/services/environment-runtime.ts#L2045-L2091).
- [Upstream resume assertion](https://github.com/paperclipai/paperclip/blob/4eaa435bf4225dd3dddd88f1094c17da739fbf7b/server/src/__tests__/environment-runtime.test.ts#L3788-L3791).
- [Upstream remaining-budget calculation](https://github.com/paperclipai/paperclip/blob/4eaa435bf4225dd3dddd88f1094c17da739fbf7b/server/src/services/environment-runtime.ts#L1777-L1823).

`resolvePluginSandboxRpcTimeoutMs` delegates to the configured RPC budget helper;
with these fixtures it yields `1234 + 30000 = 31234`. Only the resume loop
subtracts `Date.now()` from a deadline. Acquire, execute, release, and destroy
pass configured budgets without subtracting time spent before dispatch.

## Inventory of every exact 31234 assertion

All line numbers refer to the fixed test-file versions above. There are 16
assertions in each version. Abbreviated case names identify the same cases in
both versions.

| Fork line | Upstream line | Case | RPC | Decision |
| --- | --- | --- | --- | --- |
| 3847 | 2723 | plugin-backed sandbox execute and release | release | Keep exact configured budget |
| 4409 | 3290 | resolved secret-ref config | execute | Keep exact configured budget |
| 4414 | 3295 | resolved secret-ref config | release | Keep exact configured budget |
| 4550 | 3431 | waits for ready plugin worker | acquire | Keep exact; readiness wait does not reduce this RPC budget |
| 4910 | 3791 | preserves exact lease when resume throws | resume | Replace exact wall-clock expectation with bounded timeout checks |
| 5630 | 4511 | provider config drift | destroy | Keep exact configured budget |
| 5761 | 4642 | secret version drift | destroy | Keep exact configured budget |
| 5798 | 4679 | lease held by another running run | acquire | Keep exact configured budget |
| 5866 | 4747 | provider does not opt into reuse | acquire | Keep exact configured budget |
| 5951 | 4832 | nested capability disables reuse | acquire | Keep exact configured budget |
| 6091 | 4972 | worker does not verify reuse methods | acquire | Keep exact configured budget |
| 6156 | 5037 | failed reusable lease cleanup, issue/workspace scope | destroy | Keep exact configured budget |
| 6324 | 5237 | destroy environment-scoped reusable leases | destroy | Keep exact configured budget |
| 6368 | 5281 | destroy failed reusable sandbox after release | destroy | Keep exact configured budget |
| 6452 | 5365 | cleanup uses recorded configuration | destroy | Keep exact configured budget |
| 6530 | 5443 | retry destroy after worker unavailable | destroy | Keep exact; retry obtains a configured budget |

The other 15 assertions test config forwarding. Broadly loosening all of them
would lose useful coverage without addressing another deadline race.

## Chosen correction

Use the existing `acquireRunLease` service seam and fake plugin worker. Keep the
change in `server/src/__tests__/environment-runtime.test.ts`; no new production
clock interface, exported helper, dependency, schema, or API is needed.

For the original non-transient resume failure case:

1. Keep the first-call match for the plugin ID, `environmentResumeLease`,
   `driverKey`, and exact recorded `providerLeaseId`. Match its timeout as a
   number, then inspect that same first call's fourth argument.
2. Assert that the timeout is finite, at least `1`, and at most `31234`. Do not
   use a narrow tolerance around `31234`, sleep to reproduce the gap, or remove
   the timeout check. A gap longer than the configured budget remains valid:
   the existing service clamps the argument to `1`.
3. Keep the original `stale sandbox` error non-transient. Keep the rejection
   text, both no-destroy/no-acquire assertions, and the database lookup by
   `staleLease.id` with `status: active` unchanged.

This is smaller than adding a clock fixture to the original case and accepts
any real elapsed time. A separate controlled retry case below retains strong
coverage of budget consumption, which broad bounds alone cannot prove.

## Controlled elapsed-time verification and cleanup

Add one companion case at the same public service seam, reusing the existing
reusable-plugin fixture pattern. It must exercise the real runtime retry loop:

1. Finish database and plugin fixture setup with real timers. Enable
   `vi.useFakeTimers({ toFake: ["Date"] })` inside a `try/finally` scope and set a
   fixed current time `T`. Leave `setTimeout`, `clearTimeout`, and scheduling
   primitives real. The ready worker avoids readiness polling.
2. On the first `environmentResumeLease` call, record all arguments. Its timeout
   must be exactly `31234`. Set Date to `T + 1000ms` and throw
   `new Error("service unavailable")`, which the existing transient classifier
   recognizes. Advance the clock in the worker callback, after the first budget
   has been observed; do not depend on global Date.now call counts.
3. Allow the existing real retry delay to finish (the first jittered delay is
   approximately 188–313ms). Date remains fixed at `T + 1000ms`, so the second
   resume timeout must be exactly `30234`. Throw the original non-transient
   `stale sandbox` error on this second call so the operation terminates.
4. Await the acquisition rejection. Require exactly two resume calls, each for
   the same recorded lease and plugin. Require the lease-preserved rejection,
   no destroy, no acquire, and the same database lease row still active.
5. In `finally`, call `vi.useRealTimers()` even if assertions fail. Ensure the
   acquisition promise settles before leaving the clock scope. No background
   operation is started. Do not use `runAllTimers` or leave a pending retry.

This case fails if retry resets the timeout to `31234` or ignores the 1000ms
already consumed. It proves deadline consumption without a runtime change.
It does not attempt to test the entire retry policy or the 1ms clamp boundary.
The original real-clock case proves the accepted lower and upper bounds.
The neighboring slow-resume case already uses fake scheduling timers; this
change does not extend its clock scope or alter its cleanup.

## Implementation and verification sequence

1. Independently approve this exact plan HEAD, merge its PR into `develop`, and
   explicitly close #250. Publish the approved plan as the final #250 Issue
   body. Only then start the separate implementation for #83.
2. Recheck upstream source. If a focused correction has landed, record its exact
   commit and compare its invariants and elapsed-time coverage. Use the existing
   upstream-to-fork sync, or the smallest reviewed backport when needed; do not
   open a duplicate upstream PR. If it is still present, apply the test-only
   correction above to the fork and prepare a focused upstream correction from
   current upstream `master` under the contribution rules.
3. In the implementation, run the original and companion resume cases first,
   then the whole affected test file, each with a hard timeout. For example:

   ```sh
   timeout 600s pnpm --filter @paperclipai/server exec vitest run src/__tests__/environment-runtime.test.ts -t 'preserves the exact lease|resume.*elapsed'
   timeout 600s pnpm --filter @paperclipai/server exec vitest run src/__tests__/environment-runtime.test.ts
   ```

   Match the final companion case name in the filter. Require executed cases,
   not an all-skipped result. If dependencies or embedded Postgres are unavailable,
   record the exact blocker and use PR CI for the missing proof; do not install
   or run a full build on the host. The allowed dependency preparation, if needed,
   is `pnpm --filter @paperclipai/plugin-sdk ensure-build-deps`.
4. In the implementation workspace, confirm the controlled case fails when its
   expected second timeout is intentionally set to `31234`, then restore `30234`
   and run it again. This checks the elapsed-time assertion's sensitivity; retain
   the intentional failure separately from acceptance results. Require the
   original preservation/no-replacement checks in both variants.
5. Run the affected file again after restoration to check for clock leakage into
   neighboring cases. Keep every material failed attempt and explain its cause;
   a passing retry alone does not resolve an unexplained failure.
6. Use GitHub CI for full typecheck, build, and broader tests. Record exact-head
   results before delivery. Do not run repo-wide typecheck/build on this host.

## Acceptance and delivery gates

- This plan PR changes only this Markdown document (plus its initial empty
  draft-opening commit). It does not claim to fix #83.
- Both fixed baselines, all 16 assertions, and the keep/change reasons are recorded.
- The original failure case accepts finite RPC budgets in `[1, 31234]` while its
  lease-preservation and no-replacement assertions remain unchanged.
- The companion case observes `31234` then `30234`, preserves the same lease,
  creates no replacement, and restores Date after the acquisition settles.
- Targeted tests and the full affected file execute successfully for the code
  delivery; full checks are evidenced by PR CI. No test execution is claimed by
  this planning-only PR.
- Cross-type independent approval applies only to the exact plan HEAD reviewed.
  A changed HEAD requires another review. The merge must use that approved HEAD.
- Final plan delivery records approved HEAD, merge SHA, applicable CI/checks,
  clean workspace evidence, and explicit closure of #250. #83 remains open for
  the separate implementation and its independent review.

Runtime timeout changes, cleanup redesign, unrelated flaky tests, deployment,
installation, service restarts, and changes to real running leases are outside
this task.
