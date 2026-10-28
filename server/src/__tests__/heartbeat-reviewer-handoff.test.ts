import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, createDb, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedReviewerIntent } from "./helpers/reviewer-intent.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { companyService } from "../services/companies.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerExecutionControlWork, executionControlSchedule } from "../services/execution-control-work.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("reviewer handoff production and executor cleanup", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("reviewer-handoff-");
    db = createDb(fixture.connectionString);
    await db.insert(authUsers).values({ id: "board", name: "Sponsor", email: "handoff@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterEach(() => { vi.useRealTimers(); });
  afterAll(async () => { await db?.$client.end(); await fixture?.cleanup(); });

  async function seed() {
    const f = await seedReviewerIntent(db, false);
    await db.update(issues).set({ status: "in_progress", assigneeAgentId: f.source.agentId, executionState: null }).where(eq(issues.id, f.issueId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    return f;
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const handoff = (f: Fixture, owner: Db = db, runId = f.source.id) => issueService(owner).update(f.issueId, {
    status: "in_review", assigneeAgentId: f.agentId, executionState: f.issue.executionState,
    actorAgentId: f.source.agentId, executionHandoffRunId: runId,
  });
  const receipts = (f: Fixture) => db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, f.companyId), sql`${agentWakeupRequests.payload} ? '_paperclipReviewerAssignmentContinuation'`));
  const coordinator = (service: ReturnType<typeof heartbeatService>) => {
    const c = createDeliveryWorkCoordinator({ owner: db, canRun: () => true });
    return { c, start: () => registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionContinuation,
      run: service.reconcileReviewerAssignments, next: executionControlSchedule(db).continuation }]).ready };
  };

  it("rolls the real handoff and receipt back together, then startup delivers the committed handoff", async () => {
    const f = await seed();
    await expect(db.transaction(async tx => { await handoff(f, tx as unknown as Db); throw new Error("rollback handoff"); })).rejects.toThrow("rollback handoff");
    expect(await receipts(f)).toHaveLength(0);
    expect((await issueService(db).getById(f.issueId))?.assigneeAgentId).toBe(f.source.agentId);
    await handoff(f);
    const service = heartbeatService(db), { c, start } = coordinator(service);
    try {
      await start();
      expect(await receipts(f)).toMatchObject([{ status: "coalesced", runId: expect.any(String) }]);
      const after = await issueService(db).getById(f.issueId);
      expect(after?.executionState).toEqual(f.issue.executionState);
      expect(after?.executionPolicy).toEqual(f.issue.executionPolicy);
      expect(after?.responsibleUserId).toBe("board");
    } finally { await c.stop(); await service.drainActiveRunExecutions(); }
  });

  it("does not manufacture a new stage handoff from assignment-only repair", async () => {
    const f = await seedReviewerIntent(db, false);
    await db.update(issues).set({ assigneeAgentId: f.source.agentId }).where(eq(issues.id, f.issueId));
    await issueService(db).update(f.issueId, { assigneeAgentId: f.agentId, actorAgentId: f.source.agentId,
      executionHandoffRunId: f.source.id });
    expect(await receipts(f)).toHaveLength(0);
  });

  it("does not turn a caller-declared stage wake into durable reviewer authority", async () => {
    const f = await seedReviewerIntent(db, false, undefined, false);
    const service = heartbeatService(db);
    await service.wakeup(f.agentId, { source: "assignment", reason: "execution_review_requested", triggerDetail: "system",
      requestedByActorType: "agent", requestedByActorId: f.source.agentId,
      payload: { issueId: f.issueId, interruptedRunId: f.source.id },
      contextSnapshot: { issueId: f.issueId, source: "issue.execution_stage", interruptedRunId: f.source.id } });
    expect(await receipts(f)).toHaveLength(0);
    await service.drainActiveRunExecutions();
  });

  it("actual cross-agent executor cleanup wakes the original reviewer exactly once", async () => {
    const f = await seed();
    await db.update(agents).set({ adapterConfig: { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] } })
      .where(eq(agents.id, f.source.agentId));
    const service = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    const { c, start } = coordinator(service);
    let source: Awaited<ReturnType<typeof service.wakeup>>;
    try {
      await start();
      source = await service.wakeup(f.source.agentId, { source: "assignment", reason: "issue_assigned", payload: { issueId: f.issueId },
        requestedByActorType: "user", requestedByActorId: "board" });
      expect(source).toBeTruthy();
      await vi.waitFor(async () => {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source!.id));
        expect(run.status).toBe("running"); expect(run.processPid).toBeTruthy();
      }, { timeout: 15_000 });
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
      await handoff(f, db, source!.id);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await receipts(f)).toMatchObject([{ status: "deferred_issue_execution", runId: null }]);
      await service.cancelRun(source!.id, "Cancelled before issue reassignment");
      await service.drainActiveRunExecutions();
      const [released] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, source!.id));
      expect(released.resultJson?.executionReleased).toMatchObject({ runId: source!.id, issueId: f.issueId });
      await vi.advanceTimersByTimeAsync(60_000);
      await vi.waitFor(async () => expect(await receipts(f)).toMatchObject([{ status: "coalesced", runId: expect.any(String) }]), { timeout: 5000 });
      const [receipt] = await receipts(f);
      const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, f.agentId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ id: receipt.runId, status: "queued" });
      const after = await issueService(db).getById(f.issueId);
      expect(after?.executionState).toEqual(f.issue.executionState);
      expect(after?.executionPolicy).toEqual(f.issue.executionPolicy);
      expect(after?.responsibleUserId).toBe("board");
      expect(c.nextWakeAt()).toBeNull();
    } finally {
      vi.useRealTimers();
      if (source!) await service.cancelRun(source.id, "Fixture cleanup").catch(() => undefined);
      await service.drainActiveRunExecutions(); await c.stop();
    }
  }, 60_000);

  it("serializes archive with the real producer and never replays on unarchive", async () => {
    const f = await seed();
    await Promise.all([handoff(f), companyService(db).archive(f.companyId)]);
    for (const row of await receipts(f)) expect(row).toMatchObject({ status: "cancelled", error: "Company archived", runId: null });
    expect(await executionControlSchedule(db).continuation()).toBeNull();
    await companyService(db).update(f.companyId, { status: "active" });
    const service = heartbeatService(db), { c, start } = coordinator(service);
    try { await start(); expect(c.nextWakeAt()).toBeNull(); }
    finally { await c.stop(); }
  });
});
