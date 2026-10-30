import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentWakeupRequests, authUsers, createDb, environmentLeases, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedReviewerIntent } from "./helpers/reviewer-intent.js";
import { heartbeatService } from "../services/heartbeat.js";
import { selectReleasedExecutionWake } from "../services/heartbeat/released-execution-wake.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("wake skipped during executor cleanup", () => {
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
});
