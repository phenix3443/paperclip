# Reviewer release discriminating probes

Date: 2026-10-30 UTC. Companion to [the design](2026-10-30-reviewer-release-minimal-correction.md).
Production source base: `ef5f04157907ecf96a7698afb4daac3aee899b64`.
Execution checkout head: `4892be2997` (only initial design documentation differs
from the base). Linux x86_64, Node v26.12.1, pnpm 9.15.4, Vitest 5.0.3.
Fresh disposable embedded PostgreSQL; synthetic agents, user and task. No provider,
live company, production database or historical receipt was used by the main probe.

## Main result: two passed, two failed

Command, with a 180-second whole-command bound:

```sh
timeout 180 pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/heartbeat-reviewer-release-probe.test.ts
```

Actual result: **2 failed / 2 passed / 0 skipped**, 43.33 seconds, Vitest exit 1.
The two inherited #211 tests passed: unchanged assignment queues one reviewer
successor after manual release/selection/admission, and stale stage/done/live wake
are rejected. The two new contract assertions failed:

| Assertion | Expected | Observed |
| --- | --- | --- |
| Same stage and participant, changed reviewRequest.instructions; deliver selected old receipt through real `heartbeatService.wakeup` | Zero task reviewer successors | One queued task reviewer successor |
| Release marker committed; throw after selection before enqueue; create a new heartbeat service and run current reviewer reconciliation | One successor | Zero successors; continuation deadline `null`; one skipped diagnostic remains |

The main probe uses real queue admission, real selector transactions, real release
marker persistence and real deadline reads. It manually changes lease state and
calls the selector. It therefore proves the generation counterexample and the
absence of this ordinary receipt from the exercised continuation duty. It does
**not** prove automatic executor cleanup, full startup/coordinator reconstruction,
or a process crash. A fresh service object is not a restarted server. The fault is
injected at the caller seam after marker commit, not inside a real executor.
No runtime correction or red-to-green claim is made.

## Bounded executor-teardown attempt did not reach its target

A separate `heartbeat-reviewer-release-lifecycle-probe.test.ts` attempted to run
real heartbeat teardown with a simulated provider and a controlled environment
release barrier. Three versions were run, each bounded by `timeout 180`:

1. Initial partial runtime fixture: **2 failed**, 147.23s. Setup failed with
   `environmentRuntime.acquireRunLease is not a function`; both tests timed out
   at 60s. This is a fixture defect, not a product failure.
2. Reuse real environment runtime, override only release: **2 failed**, 44.90s.
   The expected skipped receipt was absent, so the discriminating precondition
   was not established. This does not test post-release recovery.
3. Add the original probe's legacy-local source profile and full wake context:
   **2 failed**, 41.06s. The skipped receipt was now present, but the expected
   `executionReleased` marker was absent. The synthetic local adapter evidence
   did not establish the real local process cleanup contract; no owned real
   local process stop proof was supplied. The post-commit fault was not reached.

No result from these attempts is counted as a successful automatic-cleanup
positive control or as a reproduced executor post-commit fault. Real cancellation
through the owning service, genuine local process stop evidence, both native
finalization orders and a restarted coordinator remain unverified. Preserve all
three sources/logs in the attached evidence archive. Further fixture work belongs
to the subsequent authorized validation scope, not repeated retries until green.

## Preparation and cleanup

`pnpm install --offline --frozen-lockfile --ignore-scripts` completed in 9.4s.
It warned about the not-yet-built plugin SDK executable. The permitted
`pnpm --filter @paperclipai/plugin-sdk ensure-build-deps` completed successfully.
No full build, typecheck, whole-repo tests or browser suite ran. The temporary test
files were archived and removed from discovery after capture; teardown closed the
disposable DB clients and removed their databases. No manually created worktree.
The PR/native handoff records final workspace cleanup and exact-head CI separately.

## Reproducible main probe

Extract the following TypeScript block to the test path in the command above on
the pinned base with dependencies prepared. Remove it after the bounded run.
These are intentionally failing acceptance assertions, not passing regression tests.

```typescript
import { executionControlSchedule } from "../services/execution-control-work.js";
import { recordRunExecutionReleased } from "../services/heartbeat/case-handoff-lifecycle.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentWakeupRequests, authUsers, createDb, environmentLeases, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedReviewerIntent } from "./helpers/reviewer-intent.js";
import { heartbeatService } from "../services/heartbeat.js";
import { selectReleasedExecutionWake } from "../services/heartbeat/released-execution-wake.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("reviewer release discriminating probes", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("released-execution-wake-");
    db = createDb(fixture.connectionString);
    await db.insert(authUsers).values({ id: "board", name: "Sponsor", email: "release@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterAll(async () => { await db?.$client.end(); await fixture?.cleanup(); });

  // The author's run moved the task to review and was cancelled by that handoff.
  // Its environment lease is still held when the reviewer's wake is checked.
  async function seed() {
    const f = await seedReviewerIntent(db, false, undefined, false);
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy",
      runnerProfileJson: { adapterDispatch: { adapterType: "claude_local" } } }).where(eq(heartbeatRuns.id, f.source.id));
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.source.id,
      provider: "local", status: "active" }).returning();
    // Keep the reviewer busy so admission queues its run instead of launching a provider.
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const state = f.issue.executionState as Record<string, unknown>;
    const executionStage = { stageId: state.currentStageId, stageType: "review", wakeRole: "reviewer",
      currentParticipant: state.currentParticipant, returnAssignee: state.returnAssignee,
      reviewRequest: state.reviewRequest, lastDecisionOutcome: null, allowedActions: ["approve", "request_changes"] };
    const reviewWake = {
      source: "assignment" as const, triggerDetail: "system" as const, reason: "execution_review_requested",
      payload: { issueId: f.issueId, mutation: "update", executionStage, interruptedRunId: f.source.id },
      requestedByActorType: "agent" as const, requestedByActorId: f.source.agentId,
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "execution_review_requested",
        source: "issue.execution_stage", executionStage, interruptedRunId: f.source.id },
    };
    return { ...f, lease, reviewWake };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const release = (f: Fixture) => db.update(environmentLeases)
    .set({ status: "released", releasedAt: new Date(), cleanupStatus: "succeeded" }).where(eq(environmentLeases.id, f.lease.id));
  const skipped = (f: Fixture) => db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.agentId, f.agentId),
    eq(agentWakeupRequests.status, "skipped"), eq(agentWakeupRequests.reason, "execution_reconciliation_required")));
  const reviewerRuns = (f: Fixture) => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, f.agentId),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`));
  const select = (f: Fixture) => selectReleasedExecutionWake(db, { companyId: f.companyId, issueId: f.issueId, releasedRunId: f.source.id });

  it("delivers the skipped review wake once when the author's executor releases the task", async () => {
    const f = await seed();
    const service = heartbeatService(db);

    await service.wakeup(f.agentId, f.reviewWake);
    expect(await skipped(f)).toHaveLength(1);
    expect(await reviewerRuns(f)).toHaveLength(0);

    await release(f);
    const resume = await select(f);
    expect(resume).toMatchObject({ agentId: f.agentId, opts: {
      source: "assignment", reason: "execution_review_requested",
      payload: { issueId: f.issueId, executionStage: { stageId: f.reviewWake.payload.executionStage.stageId } },
      contextSnapshot: { source: "issue.execution_stage", wakeReason: "execution_review_requested" },
    } });
    expect(resume!.opts.payload).not.toHaveProperty("executionWait");
    await service.wakeup(resume!.agentId, resume!.opts);

    expect(await reviewerRuns(f)).toMatchObject([{ status: "queued",
      contextSnapshot: { wakeReason: "execution_review_requested", source: "issue.execution_stage" } }]);
    // The same release recorded again does not deliver a second wake.
    expect(await select(f)).toBeNull();
  }, 60_000);

  it("does not deliver a skipped wake that the task no longer needs", async () => {
    const f = await seed();
    await heartbeatService(db).wakeup(f.agentId, f.reviewWake);
    await release(f);
    expect(await select(f)).not.toBeNull();

    const state = f.issue.executionState as Record<string, unknown>;
    await db.update(issues).set({ executionState: { ...state, currentStageId: randomUUID() } }).where(eq(issues.id, f.issueId));
    expect(await select(f)).toBeNull();

    await db.update(issues).set({ executionState: state, status: "done" }).where(eq(issues.id, f.issueId));
    expect(await select(f)).toBeNull();

    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, f.issueId));
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "assignment",
      reason: "execution_review_requested", status: "queued", payload: { issueId: f.issueId } });
    expect(await select(f)).toBeNull();
  }, 60_000);
  it("rejects an old receipt after same-stage same-participant submission changes", async () => {
    const f = await seed();
    const service = heartbeatService(db);
    await service.wakeup(f.agentId, f.reviewWake);
    expect(await skipped(f)).toHaveLength(1);
    const oldState = f.issue.executionState as Record<string, unknown>;
    await db.update(issues).set({ executionState: { ...oldState,
      reviewRequest: { instructions: "Review a DIFFERENT submission" } } }).where(eq(issues.id, f.issueId));
    await release(f);
    const selected = await select(f);
    if (selected) await service.wakeup(selected.agentId, selected.opts);
    expect(await reviewerRuns(f)).toHaveLength(0);
  }, 60_000);

  it("retains a delivery duty after failure following release commit", async () => {
    const f = await seed();
    await heartbeatService(db).wakeup(f.agentId, f.reviewWake);
    await release(f);
    await recordRunExecutionReleased(db, f.source.id, f.issueId);
    const committed = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.source.id)))[0];
    expect(committed.resultJson).toHaveProperty("executionReleased");
    await expect((async () => {
      const selected = await select(f);
      expect(selected).not.toBeNull();
      throw new Error("diagnostic failure after release commit, before enqueue");
    })()).rejects.toThrow("diagnostic failure after release commit");
    const restarted = heartbeatService(db);
    await restarted.reconcileReviewerAssignments();
    const deadline = await executionControlSchedule(db).continuation();
    console.log("release-commit probe", JSON.stringify({ deadline,
      skipped: (await skipped(f)).length, successors: (await reviewerRuns(f)).length }));
    expect(await reviewerRuns(f)).toHaveLength(1);
  }, 60_000);

});
```
