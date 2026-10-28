import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, costEvents, createDb, heartbeatRuns, issueExecutionDecisions, issues, projects, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { companyService } from "../services/companies.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import { createAgentLifecycle } from "../services/agent-lifecycle.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { budgetService, deliverBudgetEnforcement } from "../services/budgets.js";
import { lockReviewerIntentCompany } from "../services/heartbeat/reviewer-assignment-continuation.js";
import { DELIVERY_QUEUES, subscribeDeliveryWork } from "../services/delivery-work-notifications.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("reviewer intent retirement through owning services", () => {
  let db: ReturnType<typeof createDb>;
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("reviewer-intent-retirement-");
    db = createDb(fixture.connectionString);
    await db.insert(authUsers).values({ id: "retirement-user", name: "Receipt sponsor", email: "retirement@example.test",
      createdAt: new Date(), updatedAt: new Date() });
  }, 60_000);
  afterAll(async () => { await fixture?.cleanup(); });

  async function seed(namespace: unknown = { version: 1, immutable: { reviewer: "original" }, attempt: 2 }, limit?: number | null) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const decisionId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Retirement fixture", issuePrefix: `R${companyId.slice(0, 7)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Original reviewer", role: "engineer",
      status: "idle", lifecycleState: "ready", adapterType: "process", adapterConfig: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Pending review", status: "in_review",
      responsibleUserId: "retirement-user", assigneeAgentId: agentId,
      executionPolicy: { mode: "normal", commentRequired: false, stages: [{ id: stageId, type: "review",
        approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "agent", agentId }] }],
        ...(limit === undefined ? {} : { maxReviewRounds: limit }) },
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", agentId }, returnAssignee: { type: "agent", agentId },
        reviewRequest: { instructions: "Review the same submission" }, completedStageIds: [],
        lastDecisionId: decisionId, lastDecisionOutcome: "changes_requested", changesRequestedCount: 2 } });
    await db.insert(issueExecutionDecisions).values({ id: decisionId, companyId, issueId, stageId, stageType: "review",
      actorAgentId: agentId, outcome: "changes_requested", body: "Original decision" });
    const [receipt] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment",
      reason: "issue_assigned", status: "deferred_issue_execution", requestedByActorType: "system",
      requestedByActorId: "native_review", payload: { issueId, _paperclipReviewerAssignmentContinuation: namespace } }).returning();
    return { companyId, agentId, issueId, receipt };
  }

  async function readReceipt(id: string) {
    return (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)))[0];
  }

  async function contract(issueId: string) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    return { policy: issue.executionPolicy, state: issue.executionState, reviewer: issue.assigneeAgentId,
      responsibleUserId: issue.responsibleUserId,
      decisions: await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, issueId)) };
  }

  it("archive retires reserved intent with its original context, and unarchive cannot replay it", async () => {
    const { companyId, receipt } = await seed();
    const service = companyService(db);
    await service.archive(companyId);
    const retired = await readReceipt(receipt.id);
    expect(retired).toMatchObject({ status: "cancelled", runId: null, payload: receipt.payload,
      reason: receipt.reason, requestedByActorId: receipt.requestedByActorId });
    expect(retired.error).toMatch(/archived/i);
    expect(retired.finishedAt).toBeInstanceOf(Date);
    await service.update(companyId, { status: "active" });
    expect(await readReceipt(receipt.id)).toEqual(retired);
  });

  it.each([null, undefined])("explicit Stop preserves full review contract (limit=%s)", async limit => {
    const { companyId, agentId, issueId, receipt } = await seed(undefined, limit);
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "queued",
      runtimeMode: "legacy", runtimeModeResolvedAt: new Date(), invocationSource: "assignment",
      contextSnapshot: { issueId } }).returning();
    const before = await contract(issueId);
    await heartbeatService(db).cancelRun(run.id, "Stopped by operator", {
      reviewerIntentDisposition: "retire",
      resultJson: { cancelledByActorType: "user" },
    });
    expect(await readReceipt(receipt.id)).toMatchObject({ status: "cancelled", payload: receipt.payload,
      error: "Stopped by operator", runId: null });
    expect(await contract(issueId)).toEqual(before);
  });

  it("task cancellation retires its intent through the common issue service", async () => {
    const { issueId, receipt } = await seed();
    await issueService(db).update(issueId, { status: "cancelled" });
    expect(await readReceipt(receipt.id)).toMatchObject({ status: "cancelled", payload: receipt.payload });
  });

  it("agent pause keeps intent but permanent termination retires it", async () => {
    const { agentId, receipt } = await seed();
    const lifecycle = createAgentLifecycle(db);
    await lifecycle.pauseAgent(agentId);
    expect(await readReceipt(receipt.id)).toEqual(receipt);
    await lifecycle.terminateAgent(agentId);
    expect(await readReceipt(receipt.id)).toMatchObject({ status: "cancelled", payload: receipt.payload });
  });

  it.each([null, "malformed", { version: 99 }])("archive retires reserved presence (%j), ordinary work, and leaves historical/foreign rows", async namespace => {
    const { companyId, agentId, issueId, receipt } = await seed(namespace);
    const foreign = await seed();
    const [ordinary, history] = await db.insert(agentWakeupRequests).values([
      { companyId, agentId, source: "automation", status: "queued", payload: { issueId, commentId: randomUUID() } },
      { companyId, agentId, source: "assignment", status: "skipped", finishedAt: new Date(), payload: receipt.payload },
    ]).returning();
    const before = await contract(issueId);
    await companyService(db).update(companyId, { status: "archived" });
    expect(await readReceipt(receipt.id)).toMatchObject({ status: "cancelled", payload: receipt.payload });
    expect(await readReceipt(ordinary.id)).toMatchObject({ status: "cancelled" });
    expect(await readReceipt(history.id)).toEqual(history);
    expect(await readReceipt(foreign.receipt.id)).toEqual(foreign.receipt);
    expect(await contract(issueId)).toEqual(before);
  });

  it("company pause and ordinary bulk agent cancellation preserve the reviewer duty", async () => {
    const { companyId, agentId, receipt } = await seed();
    const [ordinary] = await db.insert(agentWakeupRequests).values({ companyId, agentId,
      source: "automation", status: "queued", payload: { commentId: randomUUID() } }).returning();
    await companyService(db).update(companyId, { status: "paused" });
    await heartbeatService(db).cancelInvocationsForAgents([agentId], "Temporary company pause");
    expect(await readReceipt(receipt.id)).toEqual(receipt);
    expect(await readReceipt(ordinary.id)).toMatchObject({ status: "cancelled" });
  });

  it.each(["company", "agent", "project"] as const)("real %s budget enforcement cancels ordinary work and preserves the intent", async scopeType => {
    const { companyId, agentId, issueId, receipt } = await seed();
    const [project] = await db.insert(projects).values({ companyId, name: "Budget project" }).returning();
    await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, issueId));
    const [ordinary] = await db.insert(agentWakeupRequests).values({ companyId, agentId,
      source: "automation", status: "deferred_issue_execution", payload: { issueId, projectId: project.id } }).returning();
    const service = budgetService(db);
    await service.upsertPolicy(companyId, { scopeType,
      scopeId: scopeType === "company" ? companyId : scopeType === "agent" ? agentId : project.id,
      amount: 100, windowKind: "lifetime" }, "retirement-user");
    const [cost] = await db.insert(costEvents).values({ companyId, agentId, projectId: project.id,
      provider: "fixture", model: "fixture", inputTokens: 0, outputTokens: 0, costCents: 125, occurredAt: new Date() }).returning();
    await service.evaluateCostEvent(cost);
    await deliverBudgetEnforcement(db, { cancelWorkForScope: heartbeatService(db).cancelBudgetScopeWork }, companyId);
    expect(await readReceipt(receipt.id)).toEqual(receipt);
    expect(await readReceipt(ordinary.id)).toMatchObject({ status: "cancelled", error: "Cancelled due to budget pause" });
  });

  it("a subtree pause retains intent, while subtree cancellation retires it through the issue service", async () => {
    const { companyId, issueId, receipt } = await seed();
    const service = issueTreeControlService(db);
    const actor = { actorType: "system" as const, actorId: "fixture" };
    await service.createHold(companyId, issueId, { mode: "pause", actor });
    await service.cancelUnclaimedWakeupsForTree(companyId, issueId, "Temporary subtree pause");
    expect(await readReceipt(receipt.id)).toEqual(receipt);
    const { hold } = await service.createHold(companyId, issueId, { mode: "cancel", actor });
    await service.cancelIssueStatusesForHold(companyId, issueId, hold.id);
    expect(await readReceipt(receipt.id)).toMatchObject({ status: "cancelled", payload: receipt.payload });
  });

  it("temporary operator-attributed run cancellation does not retire intent", async () => {
    const { companyId, agentId, issueId, receipt } = await seed();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "queued", runtimeMode: "legacy",
      runtimeModeResolvedAt: new Date(), contextSnapshot: { issueId } }).returning();
    await heartbeatService(db).cancelRun(run.id, "Temporary subtree pause", {
      reviewerIntentDisposition: "preserve", resultJson: { cancelledByActorType: "user" },
    });
    expect(await readReceipt(receipt.id)).toEqual(receipt);
  });

  it("archive excludes future synthetic creation at the company-before-issue seam", async () => {
    const { companyId, issueId, receipt } = await seed();
    await companyService(db).archive(companyId);
    await db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      expect(await lockReviewerIntentCompany(tx, companyId)).toBe("archived");
      await tx.select().from(issues).where(eq(issues.id, issueId)).for("update");
    });
    expect(await readReceipt(receipt.id)).toMatchObject({ status: "cancelled" });
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRunsForAgent(companyId, receipt.agentId);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toEqual([]);
  });

  function lockBoundedDatabase() {
    return new Proxy(db, { get(target, key, receiver) {
      if (key === "transaction") return (work: Parameters<Db["transaction"]>[0]) => target.transaction(async tx => {
        await tx.execute(sql`set local lock_timeout = '100ms'`);
        return work(tx);
      });
      return Reflect.get(target, key, receiver);
    } });
  }

  it.each(["creation", "adoption"])("archive serializes with synthetic %s and settles its committed work", async operation => {
    const { companyId, agentId, issueId, receipt: original } = await seed();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const creation = db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      expect(await lockReviewerIntentCompany(tx, companyId)).toBe("active");
      await tx.select().from(issues).where(eq(issues.id, issueId)).for("update");
      const [created] = await tx.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment",
        status: "deferred_issue_execution", payload: { issueId, _paperclipReviewerAssignmentContinuation: { version: 1 } } }).returning();
      if (operation === "adoption") {
        const [run] = await tx.insert(heartbeatRuns).values({ companyId, agentId, status: "queued", runtimeMode: "legacy",
          runtimeModeResolvedAt: new Date(), contextSnapshot: { issueId } }).returning();
        await tx.update(agentWakeupRequests).set({ status: "coalesced", runId: run.id, finishedAt: new Date() })
          .where(eq(agentWakeupRequests.id, original.id));
      }
      entered.resolve();
      await release.promise;
      return created;
    });
    await entered.promise;
    try {
      await expect(companyService(lockBoundedDatabase()).archive(companyId)).rejects.toMatchObject({ cause: { code: "55P03" } });
    } finally { release.resolve(); }
    const receipt = await creation;
    await companyService(db).archive(companyId);
    await heartbeatService(db).stopInvocationsForAgents([agentId], "Cancelled because the company was archived");
    expect(await readReceipt(receipt.id)).toMatchObject({ status: "cancelled", payload: receipt.payload });
    if (operation === "adoption") {
      const adopted = await readReceipt(original.id);
      expect(adopted).toMatchObject({ status: "coalesced", payload: original.payload });
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, adopted.runId!)))[0])
        .toMatchObject({ status: "cancelled", startedAt: null });
    }
  });

  it("an adoption that wins commits one linked ordinary run, which archive cancels without starting a provider", async () => {
    const { companyId, agentId, issueId, receipt } = await seed();
    const before = await contract(issueId);
    const adoptedRun = await db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      expect(await lockReviewerIntentCompany(tx, companyId)).toBe("active");
      await tx.select().from(issues).where(eq(issues.id, issueId)).for("update");
      const [wake] = await tx.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment",
        status: "queued", payload: { issueId }, idempotencyKey: `review-assignment-continuation:${receipt.id}` }).returning();
      const [run] = await tx.insert(heartbeatRuns).values({ companyId, agentId, wakeupRequestId: wake.id,
        status: "queued", runtimeMode: "legacy", runtimeModeResolvedAt: new Date(), contextSnapshot: { issueId } }).returning();
      await tx.update(agentWakeupRequests).set({ status: "coalesced", runId: run.id, finishedAt: new Date() })
        .where(eq(agentWakeupRequests.id, receipt.id));
      return run;
    });
    const adoptedReceipt = await readReceipt(receipt.id);
    await companyService(db).archive(companyId);
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRunsForAgent(companyId, agentId);
    await heartbeat.stopInvocationsForAgents([agentId], "Cancelled because the company was archived");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, adoptedRun.id)))[0])
      .toMatchObject({ status: "cancelled", startedAt: null });
    expect(await readReceipt(receipt.id)).toEqual(adoptedReceipt);
    expect(await contract(issueId)).toEqual(before);
  });

  it.each(["creation", "adoption"])("Stop serializes with synthetic %s under the issue lock", async operation => {
    const { companyId, agentId, issueId, receipt } = await seed();
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, status: "queued", runtimeMode: "legacy",
      runtimeModeResolvedAt: new Date(), contextSnapshot: { issueId } }).returning();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const mutation = db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      expect(await lockReviewerIntentCompany(tx, companyId)).toBe("active");
      await tx.select().from(issues).where(eq(issues.id, issueId)).for("update");
      if (operation === "creation") {
        await tx.insert(agentWakeupRequests).values({ companyId, agentId, source: "assignment", status: "deferred_issue_execution",
          payload: { issueId, _paperclipReviewerAssignmentContinuation: { version: 1 } } });
      } else {
        await tx.update(agentWakeupRequests).set({ status: "coalesced", runId: run.id, finishedAt: new Date() })
          .where(eq(agentWakeupRequests.id, receipt.id));
      }
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const stopOptions = { reviewerIntentDisposition: "retire" as const, resultJson: { cancelledByActorType: "user" } };
    try {
      await expect(heartbeatService(lockBoundedDatabase()).cancelRun(run.id, "Explicit Stop", stopOptions))
        .rejects.toMatchObject({ status: 409, message: "Native retry cancellation is busy; retry the same request" });
    } finally { release.resolve(); }
    await mutation;
    await heartbeatService(db).cancelRun(run.id, "Explicit Stop", stopOptions);
    const all = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(all.filter(row => row.status === "deferred_issue_execution")).toEqual([]);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0])
      .toMatchObject({ status: "cancelled", startedAt: null });
    if (operation === "adoption") expect(await readReceipt(receipt.id)).toMatchObject({ status: "coalesced", runId: run.id, payload: receipt.payload });
  });

  it("archive notification settles only with its transaction and rollback preserves intent", async () => {
    const { companyId, receipt } = await seed();
    const snapshots: string[] = [];
    const unsubscribe = subscribeDeliveryWork(db, DELIVERY_QUEUES.executionContinuation, () => { snapshots.push("settled"); });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const rollbackDb = new Proxy(db, { get(target, key, receiver) {
      if (key === "transaction") return (work: Parameters<Db["transaction"]>[0]) => target.transaction(async tx => {
        await work(tx);
        entered.resolve();
        await release.promise;
        throw new Error("Injected archive rollback");
      });
      return Reflect.get(target, key, receiver);
    } });
    const archive = companyService(rollbackDb).archive(companyId);
    const rejected = expect(archive).rejects.toThrow("Injected archive rollback");
    await entered.promise;
    expect(snapshots).toEqual([]);
    release.resolve();
    await rejected;
    expect(await readReceipt(receipt.id)).toEqual(receipt);
    snapshots.length = 0;
    await companyService(db).archive(companyId);
    expect(snapshots).toEqual(["settled"]);
    expect(await readReceipt(receipt.id)).toMatchObject({ status: "cancelled" });
    unsubscribe();
  });
});
