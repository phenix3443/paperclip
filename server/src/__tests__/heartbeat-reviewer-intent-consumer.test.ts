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
import { agents, authUsers, agentWakeupRequests, companies, companyMemberships, costEvents, createDb, databaseWorkPending, heartbeatRuns, issueExecutionDecisions, issues } from "@paperclipai/db";
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

  async function seed(produce = true, limit?: null | number, released = true) {
    const companyId = randomUUID(), agentId = randomUUID(), authorId = randomUUID(), issueId = randomUUID(), stageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Consumer fixture", issuePrefix: "C" + companyId.slice(0, 7), defaultResponsibleUserId: "board" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board",
      membershipRole: "operator", status: "active" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
      { id: authorId, companyId, name: "Author", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
    ]);
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Pending review", status: "in_review",
      responsibleUserId: "board", assigneeAgentId: agentId,
      executionPolicy: { mode: "normal", commentRequired: true, ...(limit === undefined ? {} : { maxReviewRounds: limit }), stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId }] }] },
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", agentId }, returnAssignee: { type: "agent", agentId: authorId },
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, changesRequestedCount: 2,
        reviewRequest: { instructions: "Review the same submission" } } }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId: authorId, status: "cancelled",
      errorCode: "issue_reassigned", finishedAt: new Date(), responsibleUserId: "board", contextSnapshot: { issueId },
      resultJson: { executionCancellation: { state: "acknowledged" }, reassignmentStopConfirmed: true } }).returning();
    if (released) await recordRunExecutionReleased(db, source.id, issueId);
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
      release = () => issueService(db).update(blocker.id, { status: "done" });
    }
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
      expect(await executionControlSchedule(db).continuation()).toBeGreaterThan(Date.now());
      await release();
      await service.reconcileReviewerAssignments();
      expect(await read()).toEqual(held);
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.waitFor(async () => expect(await read()).toMatchObject({ status: "coalesced", error: null }), { timeout: 5000 });
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
      await vi.advanceTimersByTimeAsync(15_000);
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
    if (kind === "source identity") await db.update(heartbeatRuns).set({ nativeIssueId: randomUUID() }).where(eq(heartbeatRuns.id, f.source.id));
    const [current] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    await heartbeatService(db).reconcileReviewerAssignments();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.receipt.id)))[0])
      .toMatchObject({ status: "cancelled", runId: null, payload: f.receipt.payload });
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toEqual(current);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(0);
    expect(await executionControlSchedule(db).continuation()).toBeNull();
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
