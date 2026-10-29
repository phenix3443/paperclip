import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { seedReviewerIntent } from "./helpers/reviewer-intent.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createAgentLifecycle, startAgentLifecycle } from "../services/agent-lifecycle.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerExecutionControlWork, executionControlSchedule } from "../services/execution-control-work.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("reviewer intent and generic drain", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("reviewer-generic-drain-");
    db = createDb(fixture.connectionString);
    await db.insert(authUsers).values({ id: "board", name: "Review sponsor", email: "drain@example.test",
      createdAt: new Date(), updatedAt: new Date() });
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterEach(() => { vi.useRealTimers(); });
  afterAll(async () => { await db?.$client.end(); await fixture?.cleanup(); });

  it.each(["author", "another agent"])("isolates the first receipt across %s release, two consumers and startup drains", async owner => {
    const f = await seedReviewerIntent(db);
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", status: "succeeded", errorCode: null,
      startedAt: new Date(Date.now() - 1000) })
      .where(eq(heartbeatRuns.id, f.source.id));
    const otherId = randomUUID();
    await db.insert(agents).values({ id: otherId, companyId: f.companyId, name: "Mentioned agent", role: "engineer",
      status: "idle", adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } });
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: otherId, status: "running" }).returning();
    if (owner === "another agent") {
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: otherId, status: "succeeded",
        runtimeMode: "legacy", finishedAt: new Date(), contextSnapshot: { issueId: f.issueId } });
    }
    const lifecycle = startAgentLifecycle(db, { requiredPluginIds: async () => [],
      runHost: async () => "complete", runPlugin: async () => "complete" }, () => true);
    const one = heartbeatService(db), two = heartbeatService(db);
    const errors: unknown[] = [];
    const coordinators = [one, two].map(() => createDeliveryWorkCoordinator({ owner: db,
      canRun: () => true, onError: error => errors.push(error) }));
    const read = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0];
    const successors = () => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, f.agentId),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`));
    try {
      await createAgentLifecycle(db).pauseAgent(f.agentId);
      await lifecycle.sweep();
      vi.useFakeTimers({ toFake: ["Date"] });
      await one.reconcileReviewerAssignments();
      const held = await read();
      const due = (held.payload!._paperclipReviewerAssignmentContinuation as { nextAttemptAt: number }).nextAttemptAt;
      expect(due).toBeGreaterThan(Date.now());
      await db.update(agentWakeupRequests).set({ requestedAt: new Date(0) }).where(eq(agentWakeupRequests.id, held.id));
      const first = await read();
      const malformed = await db.insert(agentWakeupRequests).values([null, "invalid", { version: 99 }].map(value => ({
        companyId: f.companyId, agentId: f.agentId, source: "assignment", status: "deferred_issue_execution",
        payload: { issueId: f.issueId, _paperclipReviewerAssignmentContinuation: value }, requestedAt: new Date(0),
      }))).returning();
      const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
        authorType: "user", authorUserId: "board", body: "Inspect the saved input" }).returning();
      const [ordinary] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: otherId,
        source: "on_demand", triggerDetail: "system", reason: "issue_comment_mentioned", status: "deferred_issue_execution",
        requestedByActorType: "user", requestedByActorId: "board", payload: { issueId: f.issueId, commentId: comment.id,
          _paperclipWakeContext: { issueId: f.issueId, wakeReason: "issue_comment_mentioned", wakeCommentIds: [comment.id] } },
      }).returning();
      await Promise.all([one.resumeQueuedRuns(), two.resumeQueuedRuns(),
        ...[first, ...malformed].map(row => one.resumeQueuedCommentInterrupt(f.companyId, row.id))]);
      expect(await read()).toEqual(first);
      for (const row of malformed) expect((await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, row.id)))[0]).toEqual(row);
      const [promoted] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, ordinary.id));
      expect(promoted).toMatchObject({ status: "queued", runId: expect.any(String) });
      const [ordinaryRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, promoted.runId!));
      expect(ordinaryRun).toMatchObject({ agentId: otherId, status: "queued", startedAt: null });
      await Promise.all([one, two].map((service, index) => registerExecutionControlWork(coordinators[index], [{
        queue: DELIVERY_QUEUES.executionContinuation, run: service.reconcileReviewerAssignments,
        next: executionControlSchedule(db).continuation,
      }]).ready).concat([one.resumeQueuedRuns(), two.resumeQueuedRuns()]));
      expect(await read()).toEqual(first);
      expect(await successors()).toEqual([]);
      expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].executionRunId).toBeNull();
      for (const row of malformed) expect((await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, row.id)))[0]).toMatchObject({ status: "cancelled", runId: null, payload: row.payload });
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
      await one.resumeQueuedRunsForAgent(f.companyId, otherId);
      await vi.waitFor(async () => expect(await one.getRun(ordinaryRun.id)).toMatchObject({ status: "succeeded" }), { timeout: 10_000 });
      await one.drainActiveRunExecutions();
      expect(await one.getRun(ordinaryRun.id)).toMatchObject({ status: "succeeded", errorCode: null });
      expect(await read()).toEqual(first);
      await createAgentLifecycle(db).resumeAgent(f.agentId);
      await lifecycle.sweep();
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
      await Promise.all([one.reconcileReviewerAssignments(), two.reconcileReviewerAssignments()]);
      expect(await read()).toEqual(first);
      vi.setSystemTime(due + 1);
      await Promise.all([one.reconcileReviewerAssignments(), two.reconcileReviewerAssignments(),
        one.resumeQueuedRuns(), two.resumeQueuedRuns()]);
      const after = await read();
      expect(after).toMatchObject({ id: first.id, status: "coalesced", runId: expect.any(String) });
      expect((after.payload!._paperclipReviewerAssignmentContinuation as { immutable: unknown }).immutable)
        .toEqual((first.payload!._paperclipReviewerAssignmentContinuation as { immutable: unknown }).immutable);
      expect(await successors()).toEqual([expect.objectContaining({ id: after.runId, status: "queued", startedAt: null })]);
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, (await successors())[0].wakeupRequestId!));
      expect(wake.idempotencyKey).toBe(`review-assignment-continuation:${first.id}`);
      const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(task.executionState).toEqual(f.issue.executionState);
      expect(task.executionPolicy).toEqual(f.issue.executionPolicy);
      expect(task.responsibleUserId).toBe(f.issue.responsibleUserId);
      expect(task.executionRunId).toBeNull();
      expect(await executionControlSchedule(db).continuation()).toBeNull();
      expect(errors).toEqual([]);
    } finally {
      await Promise.all(coordinators.map(coordinator => coordinator.stop()));
      await lifecycle.stop();
      await Promise.all([one.drainActiveRunExecutions(), two.drainActiveRunExecutions()]);
    }
  }, 60_000);
});
