# Native workflow and task-read repairs

Proposed plan for [#110](https://github.com/phenix3443/paperclip/issues/110).
This is a design deliverable. It authorizes no implementation or deployment.
Independent review of the exact document commit, merge into `develop`, closure of
#110, and publication of the approved scopes in #111–#114 precede implementation.

## Findings and delivery choices

| Issue | Finding | Delivery |
| --- | --- | --- |
| [#111](https://github.com/phenix3443/paperclip/issues/111) | Native completion still deduplicates by dependency edge, unlike the route's blocked-cycle key. A completed old wake suppresses a later cycle. | Repair native completion's key using the existing ready-state helper. Do not rebuild dependency scheduling. |
| [#112](https://github.com/phenix3443/paperclip/issues/112) | Connection reconciliation excludes every `accessRequest` before consulting current gateway access. Run termination itself is not invalidation. | Reconcile only an exact request already satisfied by current authority; preserve unanswered questions and approvals. |
| [#113](https://github.com/phenix3443/paperclip/issues/113) | Pending-interaction recovery protection is already in the fork. Explicit-blocker review waits remain unprotected; a nonterminal Board status change can erase pending review state. | Preserve the existing protection, repair the remaining wait/hold semantics in separate focused changes, and retain the recorded review cycle. |
| [#114](https://github.com/phenix3443/paperclip/issues/114) | Task reads hydrate live workspace delivery state despite an existing display cache. Upstream already removed this cost. | Reuse upstream #17396 through the existing master-to-develop merge. No equivalent new upstream PR. Measure the resulting deployment. |

The historical counts (14 dependency wakes and three interaction recovery wakes)
establish an incident to investigate, not proof that every instance had the same
root cause. The evidence below identifies current defects without assigning all
historical symptoms to them.

## Versions and source evidence

Observed on 2026-10-28, approximately 07:07–07:15 UTC:

| Reference | Exact SHA / evidence |
| --- | --- |
| Served Paperclip | `fdbafff72d8fd6ae7f12eb5827631efc67d208f3`; authenticated instance health `commit` and managed installer `sha` agree |
| Plan base / fork develop | `d0f8e5ad130f9940707ed25b201cb5bb0a83b641` |
| Fork master | `70c864633744cd96c0dc7394d631fc7119cd17d2` |
| Upstream master | `cff331f6ca0a652b5e41641c68dfa5fa584c22ae` |
| Existing merge plan #103 | OPEN, head `12c7371d752e267bef6cd88f00f1736a9cd69b5d` |
| Existing pool repair #109 | OPEN, head `58f43ad54a83e24a9400653fb5984e7a116fda21` |

`git ls-remote`, bounded fetches, `git show <SHA>:<path>`, and ancestry checks
established these references. Moving branches must be re-pinned before coding.
The ai-team configuration release SHA is a different repository's version and
must not be reported as the served Paperclip SHA.

The following source checks were made separately at deployed, develop and
upstream master, in that order:

| Source property | Deployed | Develop | Upstream |
| --- | --- | --- | --- |
| Native dependency producer uses legacy edge key | yes | yes | yes |
| Satisfied-connection helper excludes `accessRequest` | yes | yes | yes |
| Issue detail/context calls live workspace `getById` | yes | yes | no |
| Issue detail/context calls stored reader with runtime rows | no | no | yes |
| Review-release pending-interaction exemption | yes | yes | no |
| Pending-review Board override can clear state | yes | yes | yes |

Relevant source owners are `services/native-runtime/status-decision-committer.ts`,
`services/issue-dependency-wakeups.ts`, `services/satisfied-connection-intents.ts`,
`services/connection-intents.ts`, `services/issue-execution-policy.ts`,
`modules/wake-queue/`, `services/execution-workspaces.ts`, and `routes/issues.ts`
under `server/src/`. These are source findings, not passing end-to-end regressions.

## Upstream and fork overlap

Primary records were read using the host GitHub CLI, including PR diffs. States
are snapshots, not commitments that an open PR will merge.

| Upstream PR | State | Exact head | Conclusion |
| --- | --- | --- | --- |
| [#6719](https://github.com/paperclipai/paperclip/pull/6719) | OPEN | `7849cdf14397f8d76cf06bda1a27f47ff59f6fd8` | Adds backlog eligibility/audit coverage. Backlog is deliberately inactive in the current contract; do not import that policy. |
| [#13333](https://github.com/paperclipai/paperclip/pull/13333) | OPEN | `07568e6d1796be4b6a49f87c9fc9cbe3a131fec2` | Already-done blocker edits for active statuses; includes unrelated changes. Does not replace the native completion key. |
| [#8169](https://github.com/paperclipai/paperclip/pull/8169) | CLOSED, unmerged | `d0af304ddc16b76a9ce1f2dfb7cb11a8605ff3a0` | Terminal issue cleanup, not terminal-run cleanup. Current code already has kind-sensitive terminal-issue behavior. |
| [#14067](https://github.com/paperclipai/paperclip/pull/14067) | MERGED | `61a2c47082308a2902929395a070861f3ba5296d` | Merge `457d3209b18bd16415f5fe081df3bad1e1dacf37`; improves ownership-change wording, not readiness. |
| [#17849](https://github.com/paperclipai/paperclip/pull/17849) | OPEN | `d80fae68996ce06962ca3c2f818f1a679a7ce3f8` | Pending-interaction review-release exemption. Already delivered by fork #51. |
| [#12157](https://github.com/paperclipai/paperclip/pull/12157) | OPEN | `74633b6a9a372b5999684c173fa6e1c5f1d22488` | Restored-review dispatch; includes schema/migration work. Do not import wholesale or add a dispatch table. |
| [#17018](https://github.com/paperclipai/paperclip/pull/17018) | OPEN | `a71fe4b329bacac4ee9cc5f8eb258d2458eceae5` | Recovery lineage scoped to current decision. Preserve that distinction; it does not repair status clearing. |
| [#11621](https://github.com/paperclipai/paperclip/pull/11621) | OPEN | `2d5944a259fb3293a822b21c49351eec3f1f9115` | Broader demand/timeout/UI contracts; unnecessary for Git-free task metadata. |
| [#11753](https://github.com/paperclipai/paperclip/pull/11753) | OPEN | `0525466a0e028537e73c1448811afd4f3c676339` | Related metadata-read repair, mixed with runtime/reaper work. Prefer merged #17396. |

Related issue bodies were also read:

- [#5985](https://github.com/paperclipai/paperclip/issues/5985) reports old missing
  dependency wakes. Current routes already emit them.
- [#12942](https://github.com/paperclipai/paperclip/issues/12942) is the distinct
  null-assignee case. Related open [#12944](https://github.com/paperclipai/paperclip/pull/12944)
  (`4be54ecf8612000de2b3090cdd91c2ae48b037bf`) adds creator fallback to a sweep.
  This plan neither assigns unowned work to its creator nor imports a sweep.
- [#17939](https://github.com/paperclipai/paperclip/issues/17939) describes readiness
  disagreeing with explicit gateway grants, including the blanket `accessRequest`
  exclusion and ambiguous organization-selection behavior. Do not weaken identity
  selection to resolve an ambiguous account.
- [#14822](https://github.com/paperclipai/paperclip/issues/14822) has explicit-blocker
  and pending-human-input variants. #17849 fixes only the latter.
- [#17495](https://github.com/paperclipai/paperclip/issues/17495) reports Board
  `in_progress` clearing pending state while retaining the reviewer.
- [#14423](https://github.com/paperclipai/paperclip/issues/14423) reports amplified
  inspections; [#14753](https://github.com/paperclipai/paperclip/issues/14753)
  concerns timeout/index-lock behavior; [#13014](https://github.com/paperclipai/paperclip/issues/13014)
  also includes an archive 404. Do not expand the read fix into archive semantics.

Bounded duplicate searches (first 30 results per query) used
`repo:paperclipai/paperclip` with `"issue_blockers_resolved"`,
`"connection_intent"`, `"review" "recovery"`, and `"close-readiness"`.
They found merged [#13174](https://github.com/paperclipai/paperclip/pull/13174),
merge `a05b828bcd6dd6093ba671e3fec30eeac8261970`, which already added display
inspection caching/coalescing. That commit is an ancestor of the deployment.
Current code has a 30-second, 256-entry cache, not the original five-second TTL.
Source history then identified merged [#17396](https://github.com/paperclipai/paperclip/pull/17396),
head `3d0891b7bd10e4f346f1d63a6b3455c741f2091b`, merge
`100477e8876f51add368554643e073a2d1c1becf`, merged 2026-10-24.
It is present in fork master and upstream master, absent from develop/deployment.

Fork [#89](https://github.com/phenix3443/paperclip/issues/89) and
[#90](https://github.com/phenix3443/paperclip/issues/90) are CLOSED. Their approved
design adds explicit guarded author-rebinding/stranded-review recovery intents.
They are not evidence those capabilities were implemented. This plan adds no
such intent, table, authority, or replacement reviewer. Fork
[#51](https://github.com/phenix3443/paperclip/pull/51), merged as
`b6eb9ad8cbecb52197a20397c79c8ec1ec65dcbe`, is an ancestor of the deployment
and already carries the #17849 pending-input protection. The master merge must
retain it even though upstream has not merged #17849.

## Reproduction evidence and limits

Six bounded diagnostic probes loaded the installed deployment's compiled module
exports, with synthetic values and no live database writes or provider calls.
They ran under `timeout 30s node <probe.mjs>` and returned exit 0:

| Probe | Observed result |
| --- | --- |
| Pending review, Board requests `blocked` | Patch contains `executionState:null`, no assignee replacement |
| Same state, Board requests `in_progress` | Same state loss and retained reviewer |
| Two different blocked-cycle timestamps, same dependent/blocker | Legacy keys equal; ready-state keys differ |
| 100 concurrent display reads, one workspace | One inspection; existing coalescing works |
| 75 additional distinct workspace display reads | 75 additional inspections despite that cache |
| Valid connection `accessRequest`, DB stub that throws on access | Returns null with zero DB reads; confirms early exclusion, not that access actually exists |

A review-release probe also returned `released` for pending human interaction,
but `blocked/execution_review_participant` for an exhausted review retry with only
an explicit blocker. The adapter does not query that blocker for review release.
This is a policy/interface reproduction; integrated PostgreSQL regressions below
remain mandatory before any fix is accepted.

The native producer uses `buildIssueBlockersResolvedWakeIdempotencyKey`; its
`enqueueWake` lookup accepts old `completed` rows. Thus the equal-key probe
corresponds to an actual suppression path. Route producers already use
`buildIssueBlockersResolvedWakeStateKey`; changing all producers would add risk.

Private activity evidence, retained in the task, separates recovery from later
state loss: the source task's system reviewer recovery at 00:41 UTC recorded
unchanged assignment; a Board `blocked` change at 02:28 UTC records
`executionState: pending -> null`, including a lost return assignee and count 1.
Do not claim the system recovery transaction itself cleared this particular state.
Do not replay or repair those live business tasks during implementation tests.

## #111: native dependency completion across blocked cycles

The native status committer owns durable completion effects; the existing
dependency module owns readiness keys. Use its current blocked-cycle/whole-set key
for ordinary dependency wakes emitted by native completion. Keep parent-child
completion keys and their distinct completion-decision semantics unchanged.
Retain the native committer's transaction, company scope, atomic wake row and
delivery notification. Do not call a route from the committer or create a second
dependency scheduler.

The fix targets a dependent with a current assigned owner, two genuinely different
blocked cycles, and the same blocker reopened and completed again. It does not
make backlog runnable, treat cancellation as completion, or choose a creator for
an unassigned task. A remaining live dependency or pending workspace finalization
still prevents readiness. Existing finalize-driven reconciliation remains; do not
add a recurring scan or bypass the pool/finalization fix to force a wake.

Deterministic acceptance uses the real native status committer and PostgreSQL:

1. Seed an assigned dependent blocked by A and B. Complete A: no runnable wake.
2. Complete and finalize B: one wake targets the current eligible owner.
3. Mark its wake completed, reopen B, establish a new blocked cycle, complete B
   through the same native path: a new wake is required. The old code returns the
   prior completed row instead. Replaying the same decision must produce no third wake.
4. Cover concurrent completion, different blocker ordering, reassignment before
   dispatch, another company, cancelled blocker, pending finalize, paused/budget
   hold, and failure/rollback. Assert persisted receipts and target, not helper calls.
5. Run existing dependency route, scheduling, ready-state dedup and native
   committer tests. No provider or host polling is involved.

No reviewed equivalent PR was found for this native producer's repeated-cycle
key. A minimal fork/develop PR and upstream/master PR are justified only for this
delta; reference the related PRs and recheck them before opening it.

## #112: retire satisfied requests without fabricating consent

The interaction lifecycle module owns pending/expired resolution. Connection
readiness and the gateway own current authorization. Extend the existing satisfied
connection check for an exact `accessRequest`: match company, task, current
requester, addressed responsible user, connection, tool IDs, versions and requested
permission against current effective grants and gateway policy. A successful check
means the request is obsolete, never that a human accepted it. Keep the existing
expired/existing-connection result and delivery receipt semantics.

Do not merely remove `payload.accessRequest` from the exclusion: checking any
tool on any same-service account would retire an unsatisfied request. Do not treat
`ask_first` as an existing `allowed` grant. Do not select among ambiguous personal,
dedicated or organization identities, grant access, or call a provider to probe it.
Provider OAuth, AI-account, channel setup and upstream-service cards keep their
own completion semantics.

Use existing connection/grant/catalog invalidation and interaction delivery
triggers to re-evaluate the affected request, including first publication when
already satisfied. Reuse existing durable interaction/delivery rows and startup
reconciliation. Add no polling pass, timer, table, route or feature flag. If a
supported grant producer lacks an existing notification, add the notification to
that producer's transaction; do not rely on a general periodic scan. Verify the
actual event path rather than just calling `sweepPending` in a test.

Acceptance starts from the existing real-PostgreSQL satisfied-intents fixtures:

1. Request exact tool/version/permission; commit matching existing grants through
   the normal producer. It retires once and dispatches only the existing intended
   continuation. The pre-fix helper leaves the card pending.
2. Retain pending for missing/revoked grant, denied or weaker permission, changed
   tool version, wrong requester/user/company/project and ambiguous identity.
3. End the source run with success, failure or cancellation while an ordinary
   question, confirmation or approval is legitimately pending: it stays actionable.
   A delayed answer remains recorded; terminal task replies cannot start new work.
4. Supersession, target-document revision change, ownership change and terminal
   issue cleanup retain existing kind-specific semantics. Test accept/expire races,
   rollback, restart replay and already-delivered receipts without duplicate wakes.
5. If gateway/readiness disagree for a case other than the exact request above,
   record it separately; do not broaden this slice into identity-resolution design.

Follow #17939 and reuse its exact failing scenario. No equivalent narrow PR was
found in the bounded search. Recheck before opening the fork and upstream fixes.

## #113: preserve the review cycle during waits and recovery holds

A review cycle, a temporary inability to execute, and a human review decision are
different facts. A hold must not create an approval/change-request decision or
erase the saved cycle. Preserve the entire state, stage IDs/index/type, participant,
return assignee, completed stages, decisions, monitor bounds and review count.
Default/null max-review-rounds remains three. Existing explicit terminal cancellation
and deliberate policy replacement stay explicit operations, with their audit history.

Deliver two small sequential PRs within #113; do not combine a recovery framework:

1. Extend the existing wake-queue review-release predicate to recognize current
   unresolved explicit blockers/finalize waits, just as the immediate branch does.
   Retain fork #51's pending-interaction exemption. Recovery is no-op while a valid
   wait exists, including after the bounded retry. Use the existing readiness
   interface and do not invent another waiting classification.
2. In the issue execution-policy transition module, keep pending cycle state on
   nonterminal `blocked` holds. Restoration through the existing guarded recovery
   path resumes `in_review` at the same participant; an ordinary `todo` or
   `in_progress` request that would bypass it must fail atomically with the existing
   validation error mechanism. Return to the author only through a real
   changes-request decision. Keep Board terminal cancellation intentional and
   separate. Update both PATCH and comment/status paths through the same module.

The second change must cover native and legacy recovery holders, without relaxing
stopped-execution/effect reconciliation, current action ownership, status-version
fences or admission gates. Reuse a supported restored-review dispatch path; do
not introduce #89/#90's cancelled capabilities, a new recovery intent, a replacement
reviewer, a database repair, or team-specific quota routing.

Acceptance uses real route/service/queue fixtures with count 1 and count 2:

- A reviewer waiting on a live dependency or valid interaction is not requeued or
  escalated as stranded. Resolving that wait uses the native event path once.
- An unavailable reviewer creates/retains the existing truthful recovery hold;
  repeated reconciliation changes neither review state nor counters. Resuming the
  same eligible reviewer retains the original return author and last decision.
- Board `blocked` does not clear state; status-only `in_progress`/`todo` cannot
  dissolve the gate. Comment/status and PATCH agree. Unauthorized actors fail.
- A real next changes request at count 2 escalates to the actual responsible human
  at default/null three; existing human decisions remain authoritative. Restored
  state cannot reset this to zero. Approval stages remain governed.
- Race restoration against pause, reassignment, new decision, policy edit, terminal
  cancellation and workspace recovery. Stale requests fail with no partial changes.

#17849 already supplies one subcase through fork #51, so do not submit it again.
Reference #14822/#17495 for the residual fixes. Reuse #17018's lineage discipline;
do not import #12157's migration. If the existing restored path cannot pass the
fixture without new authority or schema, stop and return that evidence to review
instead of expanding this approved scope.

## #114: use the merged read fix and measure it

Current detail/context reads call live workspace `getById`, which refreshes runtime
health, hydrates delivery state, and reaches `inspectDisplay`. That display cache
coalesces one workspace, but reading many workspaces or reading after expiry still
scans Git. `getCloseReadiness` separately calls the uncached inspector. The log's
operation name alone does not mean a user explicitly requested close readiness.

Reuse #17396 unchanged through the ongoing upstream merge (#103 plan; #97 merge
work). It uses `getStoredById(companyId, id, {includeRuntimeServices:true})` in task
reads. Runtime rows and current company checks remain; delivery state is the existing
`unknown` value, not fabricated clean/delivered state. No new response type or route.
Do not omit runtime services by using develop's older stored getter signature.
Keep live explicit close, archive and finalization inspection uncached and fail closed
on inspection failure. The source diff and affected fixtures must survive merge
conflict resolution. Do not open an equivalent fork/upstream patch for #114.

Historical load source: [ai-team #527](https://github.com/phenix3443/ai-team/issues/527)
records 1,407 issue detail reads, 767 Git scans, 198 wake diagnostics and 181
interaction reads in five minutes, skills 14–35 seconds and about 88% CPU. Its
initial count was 114 startup failures; [#529](https://github.com/phenix3443/ai-team/issues/529)
updates this to 129 and records stopping the eight polling timers. These are
incident records, not a controlled benchmark. No timer is restarted by this plan.

### Bounded current baseline

Window: 2026-10-28 07:09:34.944–07:09:52.455 UTC; concurrency one; five requests
per path planned; stop a path at its first failure; each HTTP request capped at
12 seconds. This read-only baseline used only the assigned task, its member's
filtered issue list (`status=in_progress`, limit ten), and its own skills snapshot.
The Git checkout had 11,480 tracked files. No new load generator or workspace
mutation ran against the service. Concurrent workloads were uncontrolled.

| Path | Completed | Median ms | p95 ms, nearest rank | Range ms |
| --- | --- | --- | --- | --- |
| Detail | 5 HTTP 200 | 184.42 | 1,637.62 | 113.43–1,637.62 |
| Filtered list | 5 HTTP 200 | 582.41 | 899.06 | 67.43–899.06 |
| Skills | 0 | unavailable | unavailable | first request timed out at 12 s |

Server process CPU advanced 11.58 seconds during 17.502 wall seconds (shared
service, not attributable to this probe alone). The journal contains 39 successful
`close_readiness_status` scan events across the window; **one** matches the assigned
workspace's SHA-256 path hash. This agrees with an existing cache and contradicts
the claim that every repeated read necessarily starts another scan. Request
cancellation does not prove the skills handler stopped its work. No before/after
improvement is claimed from this baseline.

### Independent acceptance after merge/deployment

In an isolated app with a synthetic repository matching the recorded file count,
use the pinned deployed baseline and merged treatment SHA. Fix the task set,
runtime services, repository layout, catalog size and machine resources. Record
those sizes and the request URLs without identities or credentials. Warm up twice;
measure 20 requests per path at concurrency one, then four, with a 120-second total
deadline per batch. Retain all timeouts and report completed counts, median/p95/max,
Git scan count and process CPU seconds. Do not mix warmup with measured samples.

- Unchanged detail and context reads must perform zero Git inspections, even
  beyond the old 30-second cache lifetime and across 75 distinct workspaces.
  Assert that through assembled routes, not a cache helper mock alone.
- List/skills measurements are collateral responsiveness checks. The skills route
  resolves runtime config, connector skills and adapter `listSkills`; no direct
  workspace Git call was found there. Do not claim #17396 fixes catalog/adapter
  work. If these paths still exceed the launcher budget, preserve the failure and
  isolate their own costs before proposing another change.
- Require no failed requests in the controlled run; task detail/context Git scans
  zero; no list/skills latency regression greater than 10% in paired medians.
  Inspect variance and repeat only a failed or inconclusive comparison, not until
  a preferred result appears. Production observations are validation, not a reason
  to reproduce the former saturation load on the shared service.
- Immediately after a metadata read, create a dirty tracked file, untracked file,
  local commit and unpushed commit in the isolated repository. Explicit close
  readiness and finalization must see each change without waiting for a cache TTL.
  Exercise slow/failed Git and recovery; never report safe cleanup on uncertainty.

If #17396 is retained correctly, #114 is delivery/verification work, not another
implementation. Record the merge and served SHAs, measured acceptance and close
#114 only after they pass. The existing deployment/acceptance issue #115 owns the
release; this plan does not alter that task.

## Sequencing, release and rollback

Keep the master merge and connection-pool repair independent. Before each fix,
re-pin develop/master/deployment and rerun the scoped reproductions; if equivalent
work has landed, record its delivery path rather than writing another patch.
The merge must preserve fork #51 and import #17396. Pool starvation can delay
wakes or reads independently; do not attribute a stalled admission to #111's key
without its exact completed-receipt fixture.

Each new runtime delta uses a focused fork/develop PR plus a separate
upstream/master PR, with exact-SHA independent cross-type review. Keep upstream
heads open until their own conclusion. Run the smallest relevant tests first,
then required repository typecheck, tests and build before PR-ready implementation
handoff. Update affected behavior/access maps and run their checker when mapped
behavior changes. A documentation-only plan does not claim these engineering
checks have run or that any bug has been fixed.

Roll out one reviewed delta at a time through existing prebuilt deployment and
native backup procedures. Inspect exact wake receipts, interaction dispositions,
review history and served version, then run the independent recipes above. No live
business task is a disposable regression fixture. No migration, table, route,
scheduler, feature flag, periodic cleanup, or host polling backstop is added.

Rollback is a reviewed source revert and existing deployment path; retain old
receipts, grants, decisions and review history. Never delete them to make a retry
look fresh. Rollback of #111 restores the missed-cycle risk; rollback of #112
restores stale cards; rollback of #113 restores the state-loss/false-recovery risk;
rollback of #17396 restores read amplification. Do not roll back the entire master
merge merely to revert a small fix. Preserve the independently owned pool fix and
the merge's migration compatibility requirements.

## Plan acceptance and author self-review

This plan distinguishes source-proven defects, deployed pure-function probes,
historical evidence and future integrated regressions. No real-PostgreSQL red/green
or treatment performance result is claimed yet. The exact request/access fixture
and paired measurements are implementation acceptance requirements, not permission
to bypass authorization when evidence is missing.

Author self-review checked all four requested investigations, every named upstream
record, fork #89/#90/#51 overlap, merge/pool dependencies, module ownership,
current-answer preservation, review counters and return identity, fresh close
checks, bounded measurements, separate scopes and rollback. The plan adds no
product capability. Independent review must reject an implementation that broadens
the identity, scheduling or recovery authority described here.

After cross-type plan approval, publish these exact scopes to #111–#114, keeping
their existing acceptance requirements. Record the reviewed plan SHA and merge SHA
there and in #110. Do not mark the plan task finally delivered until the plan PR
is merged and #110 is closed. Implementation remains gated until then.
