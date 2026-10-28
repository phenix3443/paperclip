import { configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerExecutionControlWork } from "../services/execution-control-work.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { recordRunExecutionReleased } from "../services/heartbeat/case-handoff-lifecycle.js";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, databaseWorkPending, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";

import { createReviewerAssignmentIntent } from "../services/heartbeat/reviewer-assignment-continuation.js";
import { companyService } from "../services/companies.js";
import { executionControlSchedule } from "../services/execution-control-work.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("reviewer intent consumer", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("reviewer-consumer-");
    db = createDb(fixture.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await fixture?.cleanup(); });

  beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterEach(() => vi.useRealTimers());

  it("retires malformed unfinished intent without turning it into ordinary work", async () => {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Consumer fixture", issuePrefix: "C" + companyId.slice(0, 7) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", role: "engineer", adapterType: "process" });
    const [receipt] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment",
      status: "deferred_issue_execution", payload: { _paperclipReviewerAssignmentContinuation: null } }).returning();
    await heartbeatService(db).reconcileReviewerAssignments();
    const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt.id));
    expect(after).toMatchObject({ status: "cancelled", runId: null, payload: receipt.payload });
    expect(after.error).toMatch(/invalid/i);
    expect(after.finishedAt).toBeInstanceOf(Date);
  });

  async function seed(produce = true) {
    const companyId = randomUUID(), agentId = randomUUID(), authorId = randomUUID(), issueId = randomUUID(), stageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Consumer fixture", issuePrefix: "C" + companyId.slice(0, 7), defaultResponsibleUserId: "board" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
      { id: authorId, companyId, name: "Author", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
    ]);
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Pending review", status: "in_review",
      responsibleUserId: "board", assigneeAgentId: agentId,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId }] }] },
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", agentId }, returnAssignee: { type: "agent", agentId: authorId },
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, changesRequestedCount: 2,
        reviewRequest: { instructions: "Review the same submission" } } }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId: authorId, status: "cancelled",
      errorCode: "issue_reassigned", finishedAt: new Date(), responsibleUserId: "board", contextSnapshot: { issueId },
      resultJson: { executionCancellation: { state: "acknowledged" }, reassignmentStopConfirmed: true } }).returning();
    await recordRunExecutionReleased(db, source.id, issueId);
    const receipt = produce ? await db.transaction(tx => createReviewerAssignmentIntent(tx, { companyId, issueId, sourceRunId: source.id,
      requestedByActorType: "agent", requestedByActorId: authorId })) : null;
    return { companyId, agentId, issueId, source, issue, receipt: receipt! };
  }

  it("keeps a paused assignment due with persisted backoff and unchanged review state", async () => {
    const f = await seed();
    await companyService(db).update(f.companyId, { status: "paused" });
    vi.useFakeTimers({ toFake: ["Date"] });
    const at = Date.now();
    const service = heartbeatService(db);
    await service.reconcileReviewerAssignments();
    const read = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0];
    const after = await read();
    expect(after).toMatchObject({ status: "deferred_issue_execution", runId: null, finishedAt: null });
    expect(after.payload?._paperclipReviewerAssignmentContinuation).toMatchObject({ attempt: 1, nextAttemptAt: new Date(at + 15_000).toISOString() });
    expect(await executionControlSchedule(db).continuation()).toBe(at + 15_000);
    await service.reconcileReviewerAssignments();
    expect(await read()).toEqual(after);
    const [current] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(current.executionPolicy).toEqual(f.issue.executionPolicy);
    expect(current.executionState).toEqual(f.issue.executionState);
    expect(current.responsibleUserId).toBe("board");
  });


  it("associates exactly one original-reviewer successor across two service instances", async () => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const one = heartbeatService(db), two = heartbeatService(db);
    await Promise.all([one.reconcileReviewerAssignments(), two.reconcileReviewerAssignments()]);
    const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id));
    expect(after.status).toBe("coalesced");
    expect(after.runId).toBeTruthy();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId));
    const successors = runs.filter(run => run.contextSnapshot?.issueId === f.issueId);
    expect(successors).toHaveLength(1);
    expect(successors[0]).toMatchObject({ id: after.runId, agentId: f.agentId, responsibleUserId: "board", status: "queued" });
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, successors[0].wakeupRequestId!));
    expect(wake.idempotencyKey).toBe(`review-assignment-continuation:${f.receipt.id}`);
    expect(wake.payload).not.toHaveProperty("_paperclipReviewerAssignmentContinuation");
    expect(await executionControlSchedule(db).continuation()).toBeNull();
    const [current] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(current.executionState).toEqual(f.issue.executionState);
    expect(current.executionPolicy).toEqual(f.issue.executionPolicy);
  });


  it.each(["queued", "running", "scheduled_retry"])("adopts a matching %s ordinary turn", async status => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const service = heartbeatService(db);
    const run = await service.wakeup(f.agentId, { source: "assignment", reason: "execution_review_requested",
      payload: { issueId: f.issueId }, requestedByActorType: "agent", requestedByActorId: f.source.agentId });
    expect(run).toBeTruthy();
    if (status !== "queued") await db.update(heartbeatRuns).set({ status }).where(eq(heartbeatRuns.id, run!.id));
    await service.reconcileReviewerAssignments();
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id));
    expect(receipt).toMatchObject({ status: "coalesced", runId: run!.id });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(2);
    expect(await executionControlSchedule(db).continuation()).toBeNull();
  });

  it("rolls successor creation back if receipt association fails, then retries its durable due time", async () => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    await db.execute(sql`CREATE FUNCTION public.reject_reviewer_consume() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.status = 'coalesced' AND OLD.payload ? '_paperclipReviewerAssignmentContinuation' THEN
        RAISE EXCEPTION 'synthetic association failure'; END IF; RETURN NEW; END $$`);
    await db.execute(sql`CREATE TRIGGER reject_reviewer_consume BEFORE UPDATE ON agent_wakeup_requests
      FOR EACH ROW EXECUTE FUNCTION public.reject_reviewer_consume()`);
    vi.useFakeTimers({ toFake: ["Date"] });
    const at = Date.now();
    const service = heartbeatService(db);
    try {
      await service.reconcileReviewerAssignments();
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id));
      expect(receipt).toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(1);
      expect(await executionControlSchedule(db).continuation()).toBe(at + 15_000);
    } finally {
      await db.execute(sql`DROP TRIGGER reject_reviewer_consume ON agent_wakeup_requests`);
      await db.execute(sql`DROP FUNCTION public.reject_reviewer_consume()`);
    }
    vi.setSystemTime(at + 15_000);
    await service.reconcileReviewerAssignments();
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id));
    expect(receipt.status).toBe("coalesced");
  });

  it("retires a changed complete generation without altering review history", async () => {
    const f = await seed();
    const changed = { ...f.issue.executionState!, reviewRequest: { instructions: "Another revision" } };
    await db.update(issues).set({ executionState: changed }).where(eq(issues.id, f.issueId));
    await heartbeatService(db).reconcileReviewerAssignments();
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id));
    expect(receipt).toMatchObject({ status: "cancelled", runId: null });
    const [current] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(current.executionState).toEqual(changed);
    expect(current.executionPolicy).toEqual(f.issue.executionPolicy);
    expect(await executionControlSchedule(db).continuation()).toBeNull();
  });


  it.each(["empty", "configured", "history"])("becomes quiet with %s state, then first synthetic production reactivates it", async kind => {
    if (kind !== "empty") {
      const f = await seed(kind === "history");
      if (kind === "history") await companyService(db).archive(f.companyId);
    }
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    let reads = 0;
    const observed = new Proxy(db, { get(target, key) {
      if (!["select", "execute", "transaction"].includes(String(key))) return Reflect.get(target, key);
      return (...args: unknown[]) => { reads++; return Reflect.apply(Reflect.get(target, key), target, args); };
    } });
    const errors: unknown[] = [];
    const c = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const service = heartbeatService(observed);
    try {
      await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionContinuation,
        run: service.reconcileReviewerAssignments, next: executionControlSchedule(observed).continuation }]).ready;
      expect(c.nextWakeAt()).toBeNull();
      const before = reads;
      await vi.advanceTimersByTimeAsync(90_000);
      expect(reads).toBe(before);
      const f = await seed();
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(async () => {
        const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id));
        expect(receipt.status).toBe("coalesced");
        expect(c.nextWakeAt()).toBeNull();
      }, { timeout: 5000 });
      const settled = reads;
      await vi.advanceTimersByTimeAsync(90_000);
      expect(reads).toBe(settled);
      expect(errors).toEqual([]);
    } finally { await c.stop(); }
    expect(c.nextWakeAt()).toBeNull();
  });

  it.each(["commit", "rollback"])("retains unresolved outer %s duty after a released savepoint and an empty sweep", async outcome => {
    const f = await seed(false);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const errors: unknown[] = [];
    const c = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const service = heartbeatService(db);
    let release!: () => void, written!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const inserted = new Promise<void>(resolve => { written = resolve; });
    try {
      await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionContinuation,
        run: service.reconcileReviewerAssignments, next: executionControlSchedule(db).continuation }]).ready;
      const transaction = db.transaction(async outer => {
        await outer.transaction(tx => createReviewerAssignmentIntent(tx, { companyId: f.companyId, issueId: f.issueId,
          sourceRunId: f.source.id, requestedByActorType: "agent", requestedByActorId: f.source.agentId }));
        written(); await gate;
        if (outcome === "rollback") throw new Error("synthetic outer rollback");
      }).then(() => "committed", () => "rolled_back");
      await inserted;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
      expect(databaseWorkPending(db, DELIVERY_QUEUES.executionContinuation)).toBe(true);
      await vi.waitFor(() => expect(c.nextWakeAt()).not.toBeNull(), { timeout: 5000 });
      release();
      expect(await transaction).toBe(outcome === "commit" ? "committed" : "rolled_back");
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(async () => {
        const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
        if (outcome === "commit") expect(receipts.filter(row => row.payload?._paperclipReviewerAssignmentContinuation)).toMatchObject([{ status: "coalesced" }]);
        else expect(receipts).toHaveLength(0);
        expect(c.nextWakeAt()).toBeNull();
      }, { timeout: 5000 });
      expect(errors).toEqual([]);
    } finally { release?.(); await c.stop(); }
  });


  it("rechecks an actual company resume only at its registered receipt deadline", async () => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    await companyService(db).update(f.companyId, { status: "paused" });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const errors: unknown[] = [];
    const c = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const service = heartbeatService(db);
    const lifecycle = configureAgentLifecycle(db, { requiredPluginIds: async () => [],
      runHost: async () => "complete", runPlugin: async () => "complete" });
    await lifecycle.sweep();
    try {
      await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionContinuation,
        run: service.reconcileReviewerAssignments, next: executionControlSchedule(db).continuation }]).ready;
      const read = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0];
      const held = await read();
      expect(held.status).toBe("deferred_issue_execution");
      expect(c.nextWakeAt()).toBeTruthy();
      await companyService(db).update(f.companyId, { status: "active" });
      await lifecycle.sweep();
      await service.reconcileReviewerAssignments();
      expect(await read()).toEqual(held);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(async () => expect(await read()).toMatchObject({ status: "coalesced", error: null }), { timeout: 5000 });
      expect(errors).toEqual([]);
    } finally { await c.stop(); await lifecycle.stop(); }
  });

  it("caps retry frequency at 300 seconds while preserving duty and backoff across service recreation", async () => {
    const f = await seed();
    await companyService(db).update(f.companyId, { status: "paused" });
    vi.useFakeTimers({ toFake: ["Date"] });
    const intervals = [15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000];
    for (const interval of intervals) {
      const now = Date.now();
      await heartbeatService(db).reconcileReviewerAssignments();
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id));
      expect(receipt).toMatchObject({ status: "deferred_issue_execution", runId: null, finishedAt: null });
      expect(await executionControlSchedule(db).continuation()).toBe(now + interval);
      const duplicate = await db.transaction(tx => createReviewerAssignmentIntent(tx, { companyId: f.companyId, issueId: f.issueId,
        sourceRunId: f.source.id, requestedByActorType: "agent", requestedByActorId: f.source.agentId }));
      expect(duplicate).toBeNull();
      await heartbeatService(db).reconcileReviewerAssignments();
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0]).toEqual(receipt);
      vi.setSystemTime(now + interval);
    }
  });


  it("does not perform fallback cleanup or mint source-release proof while consuming", async () => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const recovery = { executionRecovery: { providerStopped: true, sessionPreserved: true, actionOutcomes: "settled" } };
    await db.update(heartbeatRuns).set({ resultJson: recovery, executionStage: "settled" }).where(eq(heartbeatRuns.id, f.source.id));
    await heartbeatService(db).reconcileReviewerAssignments();
    const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.source.id));
    expect(source.resultJson).toEqual(recovery);
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id));
    expect(receipt).toMatchObject({ status: "deferred_issue_execution", runId: null });
  });

});
