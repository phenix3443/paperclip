import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueThreadInteractions, issues, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { selectDeferredOwnerWakes } from "../services/heartbeat/deferred-owner-wake.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("wakes deferred behind a reassigned run", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("deferred-owner-wake-");
    db = createDb(fixture.connectionString);
    await db.insert(authUsers).values({ id: "board", name: "Sponsor", email: "deferred@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterAll(async () => { await db?.$client.end(); await fixture?.cleanup(); });

  const agent = (companyId: string, id: string, name: string) => ({ id, companyId, name, role: "engineer", status: "idle",
    adapterType: "process", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
  // Keep an agent busy so admission queues its run instead of launching a provider.
  const busy = (companyId: string, agentId: string) => db.insert(heartbeatRuns).values({ companyId, agentId, status: "running" });

  // The board reassigns the task. The new owner's wake waits behind the previous
  // owner's queued run, and then that run is stopped.
  async function seed() {
    const companyId = randomUUID(), previousId = randomUUID(), ownerId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Deferred fixture", issuePrefix: "D" + companyId.slice(0, 7), defaultResponsibleUserId: "board" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board", membershipRole: "operator", status: "active" });
    await db.insert(agents).values([agent(companyId, previousId, "Previous"), agent(companyId, ownerId, "Owner")]);
    const [previousRun] = await db.insert(heartbeatRuns).values({ companyId, agentId: previousId, status: "queued", runtimeMode: "legacy",
      responsibleUserId: "board", contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_reopened_via_comment" } }).returning();
    await db.insert(issues).values({ id: issueId, companyId, title: "Reassigned task", status: "todo", responsibleUserId: "board",
      assigneeAgentId: ownerId, executionRunId: previousRun.id, executionLockedAt: new Date() });
    await busy(companyId, ownerId);
    const [deferred] = await db.insert(agentWakeupRequests).values({ companyId, agentId: ownerId, source: "assignment", triggerDetail: "system",
      reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId, mutation: "update", _paperclipWakeContext: { wakeReason: "issue_assigned", issueId, taskId: issueId } } }).returning();
    return { companyId, previousId, ownerId, issueId, previousRun, deferred };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const runsFor = (f: Fixture, agentId: string) => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agentId),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`));
  const wakeRow = async (id: string) => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0];
  const select = (f: Fixture, endedRunId = f.previousRun.id) =>
    selectDeferredOwnerWakes(db, { companyId: f.companyId, issueId: f.issueId, endedRunId });
  // The board Stop route's options: an operator stop never promotes queued work by itself.
  const boardStop = (runId: string) => heartbeatService(db).cancelRun(runId, "Cancelled by a board operator", {
    reviewerIntentDisposition: "retire",
    resultJson: { cancelledByActorType: "user", cancelledByUserId: "board" },
  });

  it("admits the new owner's deferred wake once when the previous owner's run is stopped", async () => {
    const f = await seed();

    await boardStop(f.previousRun.id);

    expect(await runsFor(f, f.ownerId)).toMatchObject([{ status: "queued", contextSnapshot: { wakeReason: "issue_assigned" } }]);
    expect(await wakeRow(f.deferred.id)).toMatchObject({ status: "cancelled", error: "Admitted again after the run that held the task ended" });
    // The same end recorded again does not admit a second wake.
    expect(await select(f)).toEqual([]);
  }, 60_000);

  it("admits a pending question for a non-participant once while the task waits in review", async () => {
    // A task in review with a pending review stage. The author's run asks the CTO a question
    // and is then stopped; the CTO is neither the assignee nor the review participant.
    const f = await seed();
    const ctoId = randomUUID(), stageId = randomUUID();
    await db.insert(agents).values(agent(f.companyId, ctoId, "CTO"));
    await busy(f.companyId, ctoId);
    await db.update(issues).set({ status: "in_review",
      executionPolicy: { mode: "normal", commentRequired: true, stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId: f.ownerId }] }] },
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", agentId: f.ownerId }, returnAssignee: { type: "agent", agentId: f.previousId },
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, changesRequestedCount: 0 } }).where(eq(issues.id, f.issueId));
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.deferred.id));
    const [question] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issueId,
      kind: "ask_user_questions", status: "pending", createdByAgentId: f.previousId,
      payload: { version: 1, questions: [{ id: "disposition", prompt: "Close or keep?" }] } as never }).returning();
    const [ask] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: ctoId, source: "automation",
      triggerDetail: "system", reason: "issue_execution_deferred", status: "deferred_issue_execution",
      requestedByActorType: "agent", requestedByActorId: f.previousId,
      payload: { issueId: f.issueId, mutation: "interaction", interactionId: question.id, interactionKind: "ask_user_questions",
        _paperclipWakeContext: { wakeReason: "interaction_pending", issueId: f.issueId, taskId: f.issueId } } }).returning();

    await boardStop(f.previousRun.id);

    expect(await runsFor(f, ctoId)).toMatchObject([{ status: "queued", contextSnapshot: { wakeReason: "interaction_pending" } }]);
    expect(await wakeRow(ask.id)).toMatchObject({ status: "cancelled" });
    expect(await runsFor(f, f.ownerId)).toEqual([]);
    expect(await select(f)).toEqual([]);
  }, 60_000);

  it("keeps deferred wakes that the task no longer needs or that belong to other paths", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.previousRun.id));

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    expect(await select(f)).toEqual([]);

    // The stopped agent's own queued input waits for its next explicit wake.
    await db.update(issues).set({ status: "todo", assigneeAgentId: f.previousId }).where(eq(issues.id, f.issueId));
    await db.update(agentWakeupRequests).set({ agentId: f.previousId }).where(eq(agentWakeupRequests.id, f.deferred.id));
    expect(await select(f)).toEqual([]);
    await db.update(issues).set({ assigneeAgentId: f.ownerId }).where(eq(issues.id, f.issueId));
    await db.update(agentWakeupRequests).set({ agentId: f.ownerId }).where(eq(agentWakeupRequests.id, f.deferred.id));

    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.ownerId));
    expect(await select(f)).toEqual([]);
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.ownerId));

    // The review participant's wakes follow the review continuation.
    const stageId = randomUUID();
    await db.update(issues).set({ status: "in_review", executionState: { status: "pending", currentStageId: stageId,
      currentStageIndex: 0, currentStageType: "review", currentParticipant: { type: "agent", agentId: f.ownerId },
      returnAssignee: { type: "agent", agentId: f.previousId }, completedStageIds: [], lastDecisionId: null,
      lastDecisionOutcome: null, changesRequestedCount: 0 } }).where(eq(issues.id, f.issueId));
    expect(await select(f)).toEqual([]);
    await db.update(issues).set({ status: "todo", executionState: null }).where(eq(issues.id, f.issueId));

    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.ownerId, status: "succeeded",
      contextSnapshot: { issueId: f.issueId }, createdAt: new Date(Date.now() + 1000) });
    expect(await select(f)).toEqual([]);

    expect(await wakeRow(f.deferred.id)).toMatchObject({ status: "deferred_issue_execution" });
  }, 60_000);

  it("waits while another live run still holds the task", async () => {
    const f = await seed();
    const [other] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.previousId, status: "running",
      contextSnapshot: { issueId: f.issueId } }).returning();
    await db.update(issues).set({ executionRunId: other.id }).where(eq(issues.id, f.issueId));

    expect(await select(f)).toEqual([]);

    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, other.id));
    expect(await select(f, other.id)).toMatchObject([{ agentId: f.ownerId, deferredWakeId: f.deferred.id,
      opts: { source: "assignment", reason: "issue_assigned", payload: { issueId: f.issueId } } }]);
  }, 60_000);
});
