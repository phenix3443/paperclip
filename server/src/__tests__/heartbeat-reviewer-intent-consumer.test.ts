import { seedReviewerIntent } from "./helpers/reviewer-intent.js";
import express from "express";
import request from "supertest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createStorageService } from "../storage/service.js";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createRunDispatch } from "../modules/run-dispatch/index.js";
import { reserveRunBudget } from "../services/budget-reservations.js";
import { environmentService } from "../services/environments.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { ensureProjectAccessMember, projectService } from "../services/projects.js";
import { accessService } from "../services/access.js";
import { budgetService } from "../services/budgets.js";
import { issueService } from "../services/issues.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { createAgentLifecycle, startAgentLifecycle } from "../services/agent-lifecycle.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerExecutionControlWork } from "../services/execution-control-work.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { recordRunExecutionReleased } from "../services/heartbeat/case-handoff-lifecycle.js";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, authUsers, agentWakeupRequests, companies, companyMemberships, costEvents, createDb, databaseWorkPending, heartbeatRuns, issueExecutionDecisions, issueRecoveryActions, issues } from "@paperclipai/db";
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
    await db.insert(authUsers).values({ id: "board", name: "Review sponsor", email: "review-sponsor@example.test",
      createdAt: new Date(), updatedAt: new Date() });
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await fixture?.cleanup(); });

  beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

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

  const seed = (produce = true, limit?: null | number, released = true) => seedReviewerIntent(db, produce, limit, released);

  it("keeps a paused assignment due with persisted backoff and unchanged review state", async () => {
    const f = await seed(false);
    await companyService(db).update(f.companyId, { status: "paused" });
    const receipt = await db.transaction(tx => createReviewerAssignmentIntent(tx, { companyId: f.companyId, issueId: f.issueId,
      sourceRunId: f.source.id, requestedByActorType: "agent", requestedByActorId: f.source.agentId }));
    expect(receipt).not.toBeNull();
    f.receipt = receipt!;
    vi.useFakeTimers({ toFake: ["Date"] });
    const at = Date.now();
    const service = heartbeatService(db);
    await service.reconcileReviewerAssignments();
    const read = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0];
    const after = await read();
    expect(after).toMatchObject({ status: "deferred_issue_execution", runId: null, finishedAt: null });
    expect(after.payload?._paperclipReviewerAssignmentContinuation).toMatchObject({ attempt: 1, nextAttemptAt: at + 15_000 });
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
    let completedSweeps = 0;
    try {
      await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionContinuation,
        run: service.reconcileReviewerAssignments, next: async () => {
          const at = await executionControlSchedule(observed).continuation();
          completedSweeps++;
          return at;
        } }]).ready;
      expect(c.nextWakeAt()).toBeNull();
      const before = reads;
      await vi.advanceTimersByTimeAsync(90_000);
      expect(reads).toBe(before);
      const beforeProduction = completedSweeps;
      const f = await seed();
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(async () => {
        const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id));
        expect(receipt.status).toBe("coalesced");
        expect(completedSweeps).toBeGreaterThan(beforeProduction);
        expect(databaseWorkPending(db, DELIVERY_QUEUES.executionContinuation)).toBe(false);
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
    const f = await seed(false, undefined, false);
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
      await recordRunExecutionReleased(db, f.source.id, f.issueId);
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
    const f = await seed(false);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    await companyService(db).update(f.companyId, { status: "paused" });
    const receipt = await db.transaction(tx => createReviewerAssignmentIntent(tx, { companyId: f.companyId, issueId: f.issueId,
      sourceRunId: f.source.id, requestedByActorType: "agent", requestedByActorId: f.source.agentId }));
    expect(receipt).not.toBeNull();
    f.receipt = receipt!;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const errors: unknown[] = [];
    const c = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const service = heartbeatService(db);
    const lifecycle = startAgentLifecycle(db, { requiredPluginIds: async () => [],
      runHost: async () => "complete", runPlugin: async () => "complete" }, () => true);
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
      const [reviewer] = await db.select().from(agents).where(eq(agents.id, f.agentId));
      expect(reviewer).toMatchObject({ lifecycleState: "ready", lifecycleHolds: [], status: "idle" });
      await service.reconcileReviewerAssignments();
      expect(await read()).toEqual(held);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(async () => expect(await read()).toMatchObject({ status: "coalesced", error: null }), { timeout: 5000 });
      expect(errors).toEqual([]);
    } finally { await c.stop(); await lifecycle.stop(); }
  });

  it.each(["agent", "tree", "dependency"] as const)("releases the real %s gate through the registered deadline", async kind => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const actor = { actorType: "system" as const, actorId: "fixture" };
    const lifecycle = startAgentLifecycle(db, { requiredPluginIds: async () => [],
      runHost: async () => "complete", runPlugin: async () => "complete" }, () => true);
    let release: () => Promise<unknown>;
    if (kind === "agent") {
      await createAgentLifecycle(db).pauseAgent(f.agentId);
      await lifecycle.sweep();
      release = async () => { await createAgentLifecycle(db).resumeAgent(f.agentId); await lifecycle.sweep(); };
    } else if (kind === "tree") {
      const tree = issueTreeControlService(db);
      const { hold } = await tree.createHold(f.companyId, f.issueId, { mode: "pause", actor });
      release = () => tree.releaseHold(f.companyId, f.issueId, hold.id, { actor });
    } else {
      const [blocker] = await db.insert(issues).values({ companyId: f.companyId, title: "Required work", status: "todo" }).returning();
      await issueService(db).update(f.issueId, { blockedByIssueIds: [blocker.id] });
      release = async () => {
        expect(await issueService(db).update(blocker.id, { status: "done" })).toMatchObject({ status: "done" });
        expect((await issueService(db).listDependencyReadiness(f.companyId, [f.issueId])).get(f.issueId)?.isDependencyReady).toBe(true);
      };
    }
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const errors: unknown[] = [];
    const c = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const service = heartbeatService(db);
    let passes = 0;
    const read = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0];
    try {
      await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionContinuation,
        run: async () => { await service.reconcileReviewerAssignments(); passes++; }, next: executionControlSchedule(db).continuation }]).ready;
      const held = await read();
      expect(held).toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(await executionControlSchedule(db).continuation()).toBeGreaterThan(Date.now());
      await release();
      await service.reconcileReviewerAssignments();
      expect(await read()).toEqual(held);
      for (let pass = 0; pass < 2 && (await read()).runId === null; pass++) {
        await vi.waitFor(() => expect(c.nextWakeAt()).not.toBeNull(), { timeout: 5000 });
        const before = passes;
        await vi.advanceTimersByTimeAsync(Math.max(0, c.nextWakeAt()! - Date.now()) + 1);
        await vi.waitFor(() => expect(passes).toBeGreaterThan(before), { timeout: 5000 });
      }
      expect(await read()).toMatchObject({ status: "coalesced", error: null });
      const [current] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(current.executionState).toEqual(f.issue.executionState);
      expect(current.executionPolicy).toEqual(f.issue.executionPolicy);
      expect(current.responsibleUserId).toBe(f.issue.responsibleUserId);
      expect(errors).toEqual([]);
    } finally { await c.stop(); await lifecycle.stop(); }
  });

  it.each(["increase", "period reset"] as const)("observes a real budget %s at the registered deadline", async releaseKind => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const budgets = budgetService(db);
    const policy = { scopeType: "company" as const, scopeId: f.companyId, windowKind: "calendar_month_utc" as const };
    await budgets.upsertPolicy(f.companyId, { ...policy, amount: 100 }, null);
    const [cost] = await db.insert(costEvents).values({ companyId: f.companyId, agentId: f.agentId,
      provider: "fixture", model: "fixture", inputTokens: 0, outputTokens: 0, costCents: 125, occurredAt: new Date() }).returning();
    await budgets.evaluateCostEvent(cost);
    const lifecycle = startAgentLifecycle(db, { requiredPluginIds: async () => [],
      runHost: async () => "complete", runPlugin: async () => "complete" }, () => true);
    await lifecycle.sweep();
    const errors: unknown[] = [];
    const c = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const service = heartbeatService(db);
    const read = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0];
    try {
      await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionContinuation,
        run: service.reconcileReviewerAssignments, next: executionControlSchedule(db).continuation }]).ready;
      const held = await read();
      expect(held).toMatchObject({ status: "deferred_issue_execution", runId: null });
      if (releaseKind === "increase") await budgets.upsertPolicy(f.companyId, { ...policy, amount: 200 }, null);
      else vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));
      expect(await budgets.getInvocationBlock(f.companyId, f.agentId, { issueId: f.issueId })).toBeNull();
      await lifecycle.sweep();
      if (releaseKind === "increase") {
        await service.reconcileReviewerAssignments();
        expect(await read()).toEqual(held);
      }
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(async () => expect(await read()).toMatchObject({ status: "coalesced", error: null }), { timeout: 5000 });
      expect(errors).toEqual([]);
    } finally { await c.stop(); await lifecycle.stop(); }
  });

  it("reconstructs a lost-notification receipt and persisted backoff across coordinator restarts", async () => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const tree = issueTreeControlService(db);
    const actor = { actorType: "system" as const, actorId: "fixture" };
    const { hold } = await tree.createHold(f.companyId, f.issueId, { mode: "pause", actor });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const errors: unknown[] = [];
    const start = async () => {
      const c = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
      const service = heartbeatService(db);
      await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionContinuation,
        run: service.reconcileReviewerAssignments, next: executionControlSchedule(db).continuation }]).ready;
      return c;
    };
    const read = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0];
    const first = await start();
    const held = await read();
    expect(held).toMatchObject({ status: "deferred_issue_execution", runId: null });
    await first.stop();
    await tree.releaseHold(f.companyId, f.issueId, hold.id, { actor });
    const second = await start();
    try {
      expect(await read()).toEqual(held);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(async () => expect(await read()).toMatchObject({ status: "coalesced", error: null }), { timeout: 5000 });
    } finally { await second.stop(); }
    const delivered = await read();
    const third = await start();
    try { expect(await read()).toEqual(delivered); expect(third.nextWakeAt()).toBeNull(); }
    finally { await third.stop(); }
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it("preserves a first producer during drain, resumes once, and unsubscribes on shutdown", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    let canRun = false;
    const errors: unknown[] = [];
    const c = createDeliveryWorkCoordinator({ owner: db, canRun: () => canRun, canReconcile: () => true,
      onError: error => errors.push(error) });
    const service = heartbeatService(db);
    await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionContinuation,
      run: service.reconcileReviewerAssignments, next: executionControlSchedule(db).continuation }], () => canRun).ready;
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const read = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0];
    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await read()).toEqual(f.receipt);
      canRun = true;
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(async () => expect(await read()).toMatchObject({ status: "coalesced", error: null }), { timeout: 5000 });
    } finally { await c.stop(); }
    const later = await seed();
    await vi.advanceTimersByTimeAsync(90_000);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, later.receipt.id)))[0]).toEqual(later.receipt);
    expect(c.nextWakeAt()).toBeNull();
    expect(errors).toEqual([]);
  });

  it("does not duplicate a successor when its transaction commits but the response is lost", async () => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    let dropped = false;
    const unreliable = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      return async (...args: Parameters<typeof db.transaction>) => {
        const result = await Reflect.apply(target.transaction, target, args);
        if (!dropped && result?.kind === "queued") { dropped = true; throw new Error("synthetic commit response loss"); }
        return result;
      };
    } });
    await heartbeatService(unreliable).reconcileReviewerAssignments();
    expect(dropped).toBe(true);
    const [delivered] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id));
    expect(delivered).toMatchObject({ status: "coalesced", error: null });
    await heartbeatService(db).reconcileReviewerAssignments();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0]).toEqual(delivered);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(2);
  });

  it("holds revoked responsible-user authority and retries after real membership restoration", async () => {
    const f = await seed(false);
    const userId = randomUUID();
    await db.insert(authUsers).values({ id: userId, name: "Review sponsor", email: `${userId}@example.test`,
      createdAt: new Date(), updatedAt: new Date() });
    await db.update(issues).set({ responsibleUserId: userId }).where(eq(issues.id, f.issueId));
    const access = accessService(db);
    const member = await access.ensureMembership(f.companyId, "user", userId, "operator", "active");
    const receipt = await db.transaction(tx => createReviewerAssignmentIntent(tx, { companyId: f.companyId, issueId: f.issueId,
      sourceRunId: f.source.id, requestedByActorType: "agent", requestedByActorId: f.source.agentId }));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    await access.updateMember(f.companyId, member.id, { status: "suspended" });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const errors: unknown[] = [];
    const c = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const service = heartbeatService(db);
    const read = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt!.id)))[0];
    try {
      await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionContinuation,
        run: service.reconcileReviewerAssignments, next: executionControlSchedule(db).continuation }]).ready;
      const held = await read();
      expect(held).toMatchObject({ status: "deferred_issue_execution", runId: null });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(1);
      await access.updateMember(f.companyId, member.id, { status: "active" });
      await service.reconcileReviewerAssignments();
      expect(await read()).toEqual(held);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(async () => expect(await read()).toMatchObject({ status: "coalesced", error: null }), { timeout: 5000 });
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, (await read()).runId!));
      expect(run.responsibleUserId).toBe(userId);
      expect(errors).toEqual([]);
    } finally { await c.stop(); }
  });

  it.each(["responsible user", "reviewer", "original actor"] as const)("retains duty until the real project access grant for %s", async subject => {
    vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
    const f = await seed(false);
    const project = await projectService(db).create(f.companyId, { name: "Restricted review", visibility: "private" });
    await issueService(db).update(f.issueId, { projectId: project.id });
    const principals = [
      { subjectType: "user" as const, subjectId: "board", label: "responsible user" },
      { subjectType: "agent" as const, subjectId: f.agentId, label: "reviewer" },
      { subjectType: "agent" as const, subjectId: f.source.agentId, label: "original actor" },
    ];
    for (const principal of principals.filter(principal => principal.label !== subject)) {
      await ensureProjectAccessMember(db, { companyId: f.companyId, projectId: project.id, ...principal });
    }
    const receipt = await db.transaction(tx => createReviewerAssignmentIntent(tx, { companyId: f.companyId, issueId: f.issueId,
      sourceRunId: f.source.id, requestedByActorType: "agent", requestedByActorId: f.source.agentId }));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const errors: unknown[] = [];
    const c = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const service = heartbeatService(db);
    const read = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt!.id)))[0];
    try {
      await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionContinuation,
        run: service.reconcileReviewerAssignments, next: executionControlSchedule(db).continuation }]).ready;
      const held = await read();
      expect(held).toMatchObject({ status: "deferred_issue_execution", runId: null });
      const principal = principals.find(principal => principal.label === subject)!;
      await ensureProjectAccessMember(db, { companyId: f.companyId, projectId: project.id, ...principal });
      await service.reconcileReviewerAssignments();
      expect(await read()).toEqual(held);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(async () => expect(await read()).toMatchObject({ status: "coalesced", error: null }), { timeout: 5000 });
      expect(errors).toEqual([]);
    } finally { await c.stop(); }
  });

  it("retains a first producer notification arriving during the startup sweep", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    let scanned!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { scanned = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const errors: unknown[] = [];
    const c = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const service = heartbeatService(db);
    let passes = 0;
    const ready = registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionContinuation,
      run: async () => { await service.reconcileReviewerAssignments(); if (++passes === 1) { scanned(); await gate; } },
      next: executionControlSchedule(db).continuation }]).ready;
    try {
      await entered;
      const f = await seed();
      await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
      release(); await ready;
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(async () => {
        const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id));
        expect(receipt).toMatchObject({ status: "coalesced", error: null });
      }, { timeout: 5000 });
      await vi.waitFor(() => expect(passes).toBe(2), { timeout: 5000 });
      expect(errors).toEqual([]);
    } finally { release(); await c.stop(); }
  });

  it.each(["foreign company", "foreign source", "borrowed actor"] as const)("rejects %s provenance without foreign mutations", async kind => {
    const f = await seed(), foreign = await seed(false);
    const payload = structuredClone(f.receipt.payload!);
    const intent = payload._paperclipReviewerAssignmentContinuation as { immutable: {
      companyId: string; sourceRunId: string; contextSnapshot: Record<string, unknown> } };
    if (kind === "foreign company") intent.immutable.companyId = foreign.companyId;
    if (kind === "foreign source") {
      intent.immutable.sourceRunId = foreign.source.id;
      intent.immutable.contextSnapshot.interruptedRunId = foreign.source.id;
    }
    await db.update(agentWakeupRequests).set({ payload,
      ...(kind === "borrowed actor" ? { requestedByActorId: foreign.source.agentId } : {}) }).where(eq(agentWakeupRequests.id, f.receipt.id));
    const foreignBefore = {
      issues: await db.select().from(issues).where(eq(issues.companyId, foreign.companyId)),
      runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, foreign.companyId)),
      receipts: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, foreign.companyId)),
    };
    await heartbeatService(db).reconcileReviewerAssignments();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0])
      .toMatchObject({ status: "cancelled", runId: null, payload });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(0);
    expect({
      issues: await db.select().from(issues).where(eq(issues.companyId, foreign.companyId)),
      runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, foreign.companyId)),
      receipts: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, foreign.companyId)),
    }).toEqual(foreignBefore);
    expect(await db.transaction(tx => createReviewerAssignmentIntent(tx, { companyId: f.companyId, issueId: foreign.issueId,
      sourceRunId: foreign.source.id, requestedByActorType: "agent", requestedByActorId: foreign.source.agentId }))).toBeNull();
  });

  it("waits for an actual pending interaction withdrawal and preserves simultaneous tree hold", async () => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const interactions = issueThreadInteractionService(db);
    const task = { id: f.issueId, companyId: f.companyId };
    const card = await interactions.create(task, { kind: "ask_user_questions", addresseeUserId: "board",
      sourceRunId: f.source.id, continuationPolicy: "wake_assignee", payload: { version: 1,
        questions: [{ id: "permission", prompt: "Continue this submission?", selectionMode: "single", required: true,
          options: [{ id: "yes", label: "Continue" }] }] } }, { userId: "board" });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const errors: unknown[] = [];
    const c = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const service = heartbeatService(db);
    const read = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0];
    try {
      await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionContinuation,
        run: service.reconcileReviewerAssignments, next: executionControlSchedule(db).continuation }]).ready;
      const held = await read();
      expect(held).toMatchObject({ status: "deferred_issue_execution", runId: null });
      const actor = { actorType: "system" as const, actorId: "fixture" };
      const tree = issueTreeControlService(db);
      const { hold } = await tree.createHold(f.companyId, f.issueId, { mode: "pause", actor });
      await interactions.withdrawInteraction(task, card.id, { reason: "Question no longer required" }, { userId: "board" });
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(async () => {
        const row = await read();
        expect(row).toMatchObject({ status: "deferred_issue_execution", runId: null });
        expect(row.payload?._paperclipReviewerAssignmentContinuation).toMatchObject({ attempt: 2 });
      }, { timeout: 5000 });
      await tree.releaseHold(f.companyId, f.issueId, hold.id, { actor });
      await service.reconcileReviewerAssignments();
      expect((await read()).runId).toBeNull();
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(async () => expect(await read()).toMatchObject({ status: "coalesced", error: null }), { timeout: 5000 });
      expect(errors).toEqual([]);
    } finally { await c.stop(); }
  });

  it.each(["source release", "workspace lease cleanup"] as const)("waits for the existing owner to record %s before its deadline", async kind => {
    const f = await seed(true, undefined, kind !== "source release");
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const environments = environmentService(db);
    const lease = kind === "workspace lease cleanup" ? await environments.insertPendingCleanupLease({
      companyId: f.companyId, environmentId: randomUUID(), issueId: f.issueId, heartbeatRunId: f.source.id,
      provider: "local", failureReason: "Synthetic pending workspace cleanup" }) : null;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const errors: unknown[] = [];
    const c = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const service = heartbeatService(db);
    const read = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0];
    try {
      await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionContinuation,
        run: service.reconcileReviewerAssignments, next: executionControlSchedule(db).continuation }]).ready;
      const held = await read();
      expect(held).toMatchObject({ status: "deferred_issue_execution", runId: null });
      if (lease) await environments.releaseLease(lease.id, "released", { cleanupStatus: "success" });
      else await recordRunExecutionReleased(db, f.source.id, f.issueId);
      await service.reconcileReviewerAssignments();
      expect(await read()).toEqual(held);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(async () => expect(await read()).toMatchObject({ status: "coalesced", error: null }), { timeout: 5000 });
      expect(errors).toEqual([]);
    } finally { await c.stop(); }
  });

  it.each(["policy", "participant", "submission", "return assignee", "decision", "completed stages", "responsible user", "assignment", "source identity"] as const)("retires a superseded %s without rewriting current state", async kind => {
    const f = await seed();
    const state = structuredClone(f.issue.executionState!);
    const changes: Partial<typeof issues.$inferInsert> = {};
    if (kind === "policy") changes.executionPolicy = { ...f.issue.executionPolicy!, commentRequired: false };
    if (kind === "participant") state.currentParticipant = { type: "agent", agentId: f.source.agentId };
    if (kind === "submission") state.reviewRequest = { instructions: "Review a different submission" };
    if (kind === "return assignee") state.returnAssignee = { type: "user", userId: "board" };
    if (kind === "decision") state.lastDecisionId = randomUUID();
    if (kind === "completed stages") state.completedStageIds = [randomUUID()];
    if (kind === "responsible user") changes.responsibleUserId = "another-sponsor";
    if (kind === "assignment") changes.assigneeAgentId = f.source.agentId;
    await db.update(issues).set({ ...changes, executionState: state }).where(eq(issues.id, f.issueId));
    if (kind === "source identity") await db.update(heartbeatRuns).set({ agentId: f.agentId }).where(eq(heartbeatRuns.id, f.source.id));
    const [current] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    await heartbeatService(db).reconcileReviewerAssignments();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0])
      .toMatchObject({ status: "cancelled", runId: null, payload: f.receipt.payload });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toEqual(current);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect(await executionControlSchedule(db).continuation()).toBeNull();
  });

  it("does not launder an invalid duplicate actor through another receipt's association", async () => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const payload = structuredClone(f.receipt.payload!);
    const record = payload._paperclipReviewerAssignmentContinuation as { immutable: { actorType: string; actorId: string } };
    record.immutable.actorType = "user";
    record.immutable.actorId = "unrelated-user";
    const [invalid] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "assignment", triggerDetail: "system", reason: "execution_review_requested", status: "deferred_issue_execution",
      requestedByActorType: "user", requestedByActorId: "unrelated-user", payload, createdAt: new Date(Date.now() + 1) }).returning();
    await heartbeatService(db).reconcileReviewerAssignments();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0].status).toBe("coalesced");
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, invalid.id)))[0])
      .toMatchObject({ status: "cancelled", runId: null, payload });
  });

  it("bounds each pass to 50 due receipts and gives overflow its next pass", async () => {
    const fixtures = [];
    for (let i = 0; i < 51; i++) {
      const f = await seed();
      await companyService(db).update(f.companyId, { status: "paused" });
      fixtures.push(f);
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    const service = heartbeatService(db);
    await service.reconcileReviewerAssignments();
    const read = () => db.select().from(agentWakeupRequests);
    const attempts = (rows: Awaited<ReturnType<typeof read>>) => rows.map(row =>
      (row.payload?._paperclipReviewerAssignmentContinuation as { attempt: number }).attempt);
    expect(attempts(await read()).filter(attempt => attempt === 1)).toHaveLength(50);
    expect(attempts(await read()).filter(attempt => attempt === 0)).toHaveLength(1);
    expect(await executionControlSchedule(db).continuation()).toBeLessThanOrEqual(Date.now());
    await heartbeatService(db).reconcileReviewerAssignments();
    expect(attempts(await read())).toEqual(Array(51).fill(1));
    expect(await executionControlSchedule(db).continuation()).toBe(Date.now() + 15_000);
  });

  it.each([undefined, null])("delivery preserves decisions, skipped history and the default review limit (%s)", async limit => {
    const f = await seed(false, limit);
    const [decision] = await db.insert(issueExecutionDecisions).values({ companyId: f.companyId, issueId: f.issueId,
      stageId: f.issue.executionState!.currentStageId!, stageType: "review", actorAgentId: f.source.agentId,
      outcome: "changes_requested", body: "Original review decision" }).returning();
    const state = { ...f.issue.executionState!, lastDecisionId: decision.id, lastDecisionOutcome: "changes_requested" as const };
    await db.update(issues).set({ executionState: state }).where(eq(issues.id, f.issueId));
    const receipt = await db.transaction(tx => createReviewerAssignmentIntent(tx, { companyId: f.companyId, issueId: f.issueId,
      sourceRunId: f.source.id, requestedByActorType: "agent", requestedByActorId: f.source.agentId }));
    const [history] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "assignment", status: "skipped", finishedAt: new Date(), payload: receipt!.payload }).returning();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    await heartbeatService(db).reconcileReviewerAssignments();
    const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt!.id));
    expect(after).toMatchObject({ status: "coalesced", error: null });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({
      executionPolicy: f.issue.executionPolicy, executionState: state, responsibleUserId: f.issue.responsibleUserId,
      assigneeAgentId: f.agentId });
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId))).toEqual([decision]);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, history.id)))[0]).toEqual(history);
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
      expect(duplicate).toEqual(receipt);
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


  it.each(["consumer successor", "adopted ordinary turn"])("cancels a queued %s when only the submission changes before capacity release", async kind => {
    const f = await seed();
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" }).returning();
    const service = heartbeatService(db);
    if (kind === "adopted ordinary turn") await service.wakeup(f.agentId, { source: "assignment", reason: "execution_review_requested",
      payload: { issueId: f.issueId }, requestedByActorType: "agent", requestedByActorId: f.source.agentId });
    await service.reconcileReviewerAssignments();
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id));
    expect(receipt.runId).toBeTruthy();
    await db.update(issues).set({ executionState: { ...f.issue.executionState!, reviewRequest: { instructions: "A different submission" } } })
      .where(eq(issues.id, f.issueId));
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
    try {
      await service.resumeQueuedRuns();
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, receipt.runId!));
      expect(run).toMatchObject({ status: "cancelled", startedAt: null, errorCode: "issue_review_participant_changed" });
    } finally { await service.drainActiveRunExecutions(); }
  });


  it("returns bounded database batches even when future receipts precede the due receipt", async () => {
    const f = await seed();
    await companyService(db).update(f.companyId, { status: "paused" });
    const record = f.receipt.payload!._paperclipReviewerAssignmentContinuation as Record<string, unknown>;
    await db.insert(agentWakeupRequests).values(Array.from({ length: 1000 }, () => ({ companyId: f.companyId,
      agentId: f.agentId, source: "assignment", triggerDetail: "system", reason: "execution_review_requested",
      status: "deferred_issue_execution", requestedByActorType: f.receipt.requestedByActorType,
      requestedByActorId: f.receipt.requestedByActorId, createdAt: new Date(Date.now() - 60_000),
      payload: { ...f.receipt.payload, _paperclipReviewerAssignmentContinuation: { ...record,
        nextAttemptAt: Date.now() + 300_000 } },
    })));
    const returned: number[] = [];
    const observed = new Proxy(db, { get(target, key) {
      if (key !== "select") return Reflect.get(target, key);
      return (...args: unknown[]) => {
        const builder = Reflect.apply(target.select, target, args);
        return new Proxy(builder, { get(select, method) {
          if (method !== "from") return Reflect.get(select, method);
          return (table: unknown) => {
            const query = Reflect.apply(select.from, select, [table]);
            if (table !== agentWakeupRequests) return query;
            return new Proxy(query, { get(statement, field, receiver) {
              if (field !== "then") return Reflect.get(statement, field, receiver);
              return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
                statement.then((rows: unknown[]) => { returned.push(rows.length); return resolve(rows); }, reject);
            } });
          };
        } });
      };
    } });
    await heartbeatService(observed).reconcileReviewerAssignments();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0].payload?._paperclipReviewerAssignmentContinuation)
      .toMatchObject({ attempt: 1 });
    await executionControlSchedule(observed).continuation();
    expect(returned.length).toBeGreaterThan(0);
    expect(Math.max(...returned)).toBeLessThanOrEqual(50);
  });


  it("rechecks reviewer generation at the final provider gate even without interaction continuation", async () => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    await heartbeatService(db).reconcileReviewerAssignments();
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id));
    await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, receipt.runId!));
    await db.update(issues).set({ executionRunId: receipt.runId,
      executionState: { ...f.issue.executionState!, reviewRequest: { instructions: "Changed during preparation" } } }).where(eq(issues.id, f.issueId));
    const reservation = await reserveRunBudget(db, f.companyId, receipt.runId!, null);
    const invoke = vi.fn(async () => null);
    const result = await createRunDispatch(db).dispatchResolvedInteractionIfCurrent({ companyId: f.companyId, runId: receipt.runId!,
      expectedStatus: "running", reservationId: reservation.id, enforceContinuationOwnership: false, dispatch: invoke });
    expect(result).toMatchObject({ dispatched: false, cancellation: { outcome: "cancelled", errorCode: "issue_review_participant_changed" } });
    expect(invoke).not.toHaveBeenCalled();
  });


  it("rejects an unchanged review submission when a question appears during preparation", async () => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    await heartbeatService(db).reconcileReviewerAssignments();
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id));
    await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, receipt.runId!));
    await db.update(issues).set({ executionRunId: receipt.runId }).where(eq(issues.id, f.issueId));
    await issueThreadInteractionService(db).create({ id: f.issueId, companyId: f.companyId }, {
      kind: "ask_user_questions", addresseeUserId: "board", sourceRunId: f.source.id,
      continuationPolicy: "wake_assignee", payload: { version: 1, questions: [{ id: "permission",
        prompt: "Continue this submission?", selectionMode: "single", required: true,
        options: [{ id: "yes", label: "Continue" }] }] },
    }, { userId: "board" });
    const reservation = await reserveRunBudget(db, f.companyId, receipt.runId!, null);
    const invoke = vi.fn(async () => null);
    const result = await createRunDispatch(db).dispatchResolvedInteractionIfCurrent({ companyId: f.companyId, runId: receipt.runId!,
      expectedStatus: "running", reservationId: reservation.id, enforceContinuationOwnership: false, dispatch: invoke });
    expect(result).toMatchObject({ dispatched: false, cancellation: { outcome: "cancelled", errorCode: "issue_waiting_for_response" } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["none", "question", "tree", "dependency", "authority", "project", "recovery", "agent chain"] as const)("rechecks a new %s hold between accounting and provider handoff", async kind => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    await heartbeatService(db).reconcileReviewerAssignments();
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id));
    await db.update(heartbeatRuns).set({ status: "running", startedAt: new Date() }).where(eq(heartbeatRuns.id, receipt.runId!));
    await db.update(issues).set({ executionRunId: receipt.runId }).where(eq(issues.id, f.issueId));
    const reservation = await reserveRunBudget(db, f.companyId, receipt.runId!, null);
    let mutated = false;
    const observed = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      return async (...args: Parameters<typeof db.transaction>) => {
        const result = await Reflect.apply(target.transaction, target, args);
        if (!mutated && result?.kind === "value" && result.value?.claim) {
          mutated = true;
          if (kind === "tree") await issueTreeControlService(db).createHold(f.companyId, f.issueId,
            { mode: "pause", actor: { actorType: "system", actorId: "fixture" } });
          else if (kind === "dependency") {
            const [blocker] = await db.insert(issues).values({ companyId: f.companyId, title: "New dependency", status: "todo" }).returning();
            await issueService(db).update(f.issueId, { blockedByIssueIds: [blocker.id] });
          } else if (kind === "authority") await db.update(companyMemberships).set({ status: "suspended" }).where(eq(companyMemberships.companyId, f.companyId));
          else if (kind === "question") await issueThreadInteractionService(db).create({ id: f.issueId, companyId: f.companyId }, {
            kind: "ask_user_questions", addresseeUserId: "board", sourceRunId: f.source.id, continuationPolicy: "wake_assignee",
            payload: { version: 1, questions: [{ id: "permission", prompt: "Continue?", selectionMode: "single", required: true,
              options: [{ id: "yes", label: "Continue" }] }] },
          }, { userId: "board" });
          else if (kind === "project") {
            vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
            const project = await projectService(db).create(f.companyId, { name: "Restricted", visibility: "private" });
            await issueService(db).update(f.issueId, { projectId: project.id });
          } else if (kind === "agent chain") {
            await db.update(agents).set({ status: "terminated" }).where(eq(agents.id, f.source.agentId));
            await db.update(agents).set({ reportsTo: f.source.agentId }).where(eq(agents.id, f.agentId));
          } else if (kind === "recovery") await db.insert(issueRecoveryActions).values({ companyId: f.companyId,
            sourceIssueId: f.issueId, kind: "active_run_watchdog", status: "resolved", outcome: "blocked", ownerType: "board",
            returnOwnerAgentId: f.agentId, cause: "legacy_execution_requires_reconciliation", fingerprint: f.source.id,
            nextAction: "Inspect before continuing", evidence: { runId: f.source.id,
              automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } });
        }
        return result;
      };
    } });
    const invoke = vi.fn(async () => null);
    const result = await createRunDispatch(observed).dispatchResolvedInteractionIfCurrent({ companyId: f.companyId, runId: receipt.runId!,
      expectedStatus: "running", reservationId: reservation.id, enforceContinuationOwnership: false, dispatch: invoke });
    expect(mutated).toBe(true);
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task.executionState).toEqual(f.issue.executionState);
    if (kind === "none") {
      expect(result).toMatchObject({ dispatched: true });
      expect(invoke).toHaveBeenCalledOnce();
      return;
    }
    expect(result).toMatchObject({ dispatched: false });
    expect(invoke).not.toHaveBeenCalled();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, receipt.runId!)))[0].status).toBe("cancelled");
  });

  it("delivers at the registered deadline after real pre-start reviewer reconciliation clears its hold", async () => {
    const f = await seed();
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const [stopped] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "cancelled", errorCode: "issue_assignee_changed", finishedAt: new Date(), contextSnapshot: { issueId: f.issueId } }).returning();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", status: "resolved", outcome: "blocked", ownerType: "board", returnOwnerAgentId: f.agentId,
      cause: "legacy_execution_requires_reconciliation", fingerprint: stopped.id, nextAction: "Preserve without replay",
      evidence: { runId: stopped.id, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } } }).returning();
    const service = heartbeatService(db);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.actor = { type: "board", source: "local_implicit", userId: "board" }; next(); });
    app.use("/api", issueRoutes(db, createStorageService(createLocalDiskStorageProvider(`${process.env.TMPDIR}/recovery-storage`)),
      { recoveryActionEnqueueWakeup: service.wakeup }));
    app.use(errorHandler);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const errors: unknown[] = [];
    const c = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const read = async () => (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0];
    try {
      await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionContinuation,
        run: service.reconcileReviewerAssignments, next: executionControlSchedule(db).continuation }]).ready;
      expect(await read()).toMatchObject({ status: "deferred_issue_execution", runId: null });
      const response = await request(app).post(`/api/issues/${f.issueId}/recovery-actions/resolve`).send({ actionId: action.id,
        outcome: "restored", sourceIssueStatus: "in_review", executionReconciliation: { runId: stopped.id,
          providerStopped: true, actionOutcome: "not_performed", outcomeEvidence: "Cancelled before any provider or process started." } });
      expect(response.status).toBe(200);
      expect(response.body.issue.executionState).toEqual(f.issue.executionState);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(async () => expect(await read()).toMatchObject({ status: "coalesced", error: null }), { timeout: 5000 });
      expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0].evidence).not.toHaveProperty("automaticRecovery");
      expect(errors).toEqual([]);
    } finally { await c.stop(); await service.drainActiveRunExecutions(); }
  });

});
