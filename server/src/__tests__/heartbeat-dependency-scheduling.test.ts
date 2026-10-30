import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  costEvents,
  budgetPolicies,
  budgetIncidents,
  approvals,
  projects,
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companySkills,
  completionContracts,
  nativeRunResults,
  nativeRunFinalizations,
  workAssessments,
  statusDecisions,
  statusDecisionEffects,
  companies,
  authUsers,
  companyMemberships,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  environments,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueRelations,
  issueRecoveryActions,
  issueTreeHolds,
  issues,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { DependencyAdmissionHeld } from "../services/heartbeat/dependency-admission.js";
import { createAgentLifecycle, configureAgentLifecycle } from "../services/agent-lifecycle.js";
import { createLifecycleDriver } from "../services/agent-lifecycle-driver.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { seedNativeDependency } from "./helpers/native-dependency-fixture.js";
import { logger } from "../middleware/logger.js";
import { CROSS_TASK_CONTINUATION_COMMITTER_ID, crossTaskContinuationIntentKey } from "../services/cross-task-continuation.js";
import { budgetService, subscribeBudgetScopeRelease } from "../services/budgets.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Dependency-aware heartbeat test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat dependency scheduling tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("heartbeat dependency-aware queued run selection", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let continuationCwd: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-dependency-scheduling-");
    continuationCwd = await mkdtemp(join(tmpdir(), "dependency-continuation-"));
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
    heartbeat = heartbeatService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const runIds = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .then((runs) => runs.map((run) => run.id));
    await Promise.all(runIds.map((runId) => heartbeat.waitForRunExecutionDrain(runId)));
    mockAdapterExecute.mockReset();
    mockAdapterExecute.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      summary: "Dependency-aware heartbeat test run.",
      provider: "test",
      model: "test-model",
    }));
    runningProcesses.clear();
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(companySkills);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(issueRelations);
    await db.delete(issueTreeHolds);
    await db.delete(statusDecisionEffects);
    await db.delete(nativeRunFinalizations);
    await db.delete(statusDecisions);
    await db.delete(workAssessments);
    await db.delete(nativeRunResults);
    await db.delete(completionContracts);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(budgetIncidents);
    await db.delete(budgetPolicies);
    await db.delete(approvals);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(environments);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(environmentLeases);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await db.transaction(async (tx) => {
          await tx.delete(companySkills);
          await tx.delete(companyMemberships);
          await tx.delete(companies);
        });
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (continuationCwd) await rm(continuationCwd, { recursive: true, force: true });
  });

  it("automatically drains a real native dependency after lifecycle readiness without periodic recovery", async () => {
    const f = await seedNativeDependency(db, "paused", true);
    mockAdapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Dependency input delivered.", provider: "test", model: "test-model" };
    });
    await db.update(agents).set({ lifecycleState: "paused", lifecycleHolds: ["manual"], pauseReason: "manual" })
      .where(eq(agents.id, f.agentId));
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const worker = configureAgentLifecycle(db, { ...createLifecycleDriver(db, null!),
      requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: async () => "complete" });
    try {
      await createAgentLifecycle(db).resumeAgent(f.agentId);
      await worker.process(f.agentId);
      expect(await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1)).toBe(true);
      await heartbeat.drainActiveRunExecutions();
      const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`));
      expect(runs).toHaveLength(1);
      await worker.process(f.agentId);
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    } finally { await worker.stop(); }
  });

  it("automatically drains a native dependency when the real project budget is raised", async () => {
    const f = await seedNativeDependency(db, "idle", true);
    mockAdapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Dependency input delivered.", provider: "test", model: "test-model" };
    });
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Budget release", status: "in_progress" }).returning();
    await db.update(issues).set({ projectId: project!.id }).where(eq(issues.id, f.issueId));
    await db.insert(costEvents).values({ companyId: f.companyId, agentId: f.agentId, projectId: project!.id,
      provider: "test", model: "test", costCents: 100, occurredAt: new Date() });
    const input = { scopeType: "project" as const, scopeId: project!.id, amount: 50, windowKind: "lifetime" as const,
      hardStopEnabled: true, notifyEnabled: false };
    await budgetService(db).upsertPolicy(f.companyId, input, null);
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const unsubscribe = subscribeBudgetScopeRelease(db, async scope => {
      expect(scope).toEqual({ companyId: f.companyId, scopeType: "project", scopeId: project!.id });
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: scope.companyId });
    });
    try {
      await budgetService(db).upsertPolicy(f.companyId, { ...input, amount: 200 }, null);
      expect(await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1)).toBe(true);
      await heartbeat.drainActiveRunExecutions();
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); }
  });

  it("reaches eligible native inputs behind more than a page of stable holds", async () => {
    for (let i = 0; i < 4; i++) await seedNativeDependency(db, "paused", true);
    const f = await seedNativeDependency(db, "idle", true);
    mockAdapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Dependency input delivered.", provider: "test", model: "test-model" };
    });
    for (let i = 0; i < 4; i++) await heartbeat.dispatchPendingNativeStatusWakeups({ limit: 2 });
    expect(await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1)).toBe(true);
    await heartbeat.drainActiveRunExecutions();
    const parked = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.status, "deferred_issue_execution"));
    expect(parked).toHaveLength(4);
    for (let i = 0; i < 4; i++) await heartbeat.dispatchPendingNativeStatusWakeups({ limit: 2 });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.status, "deferred_issue_execution"))).toEqual(parked);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("does not lose a release before an in-flight claim settles into parking", async () => {
    const f = await seedNativeDependency(db, "idle", true);
    let entered!: () => void, release!: () => void;
    const observed = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const transaction = db.transaction.bind(db);
    let intercept = true;
    const spy = vi.spyOn(db, "transaction").mockImplementation(async (callback, config) => {
      const [intent] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.intent.id));
      if (intercept && intent?.status === "claimed") {
        intercept = false; entered(); await held;
        throw new DependencyAdmissionHeld("budget");
      }
      return transaction(callback, config);
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Raced input delivered.", provider: "test", model: "test-model" };
    });
    const first = heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    try {
      await observed;
      const second = heartbeatService(db).dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
      expect(second).toBe(first);
      release();
      await Promise.all([first, second]);
      expect(await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1)).toBe(true);
      await heartbeat.drainActiveRunExecutions();
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
      const [original] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.intent.id));
      expect(original!.runId).not.toBeNull();
    } finally { release(); await first; spy.mockRestore(); }
  });

  it.each(["agent", "project", "company"] as const)("the root hook automatically drains a real %s budget hold", async scopeType => {
    const f = await seedNativeDependency(db, "idle", true);
    const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Root release", status: "in_progress" }).returning();
    await db.update(issues).set({ projectId: project!.id }).where(eq(issues.id, f.issueId));
    await db.insert(costEvents).values({ companyId: f.companyId, agentId: f.agentId, projectId: project!.id,
      provider: "test", model: "test", costCents: 100, occurredAt: new Date() });
    const input = { scopeType, scopeId: scopeType === "company" ? f.companyId : scopeType === "agent" ? f.agentId : project!.id,
      amount: 50, windowKind: "lifetime" as const, hardStopEnabled: true, notifyEnabled: false };
    const worker = configureAgentLifecycle(db, { ...createLifecycleDriver(db, null!),
      requiredPluginIds: async () => [], runPlugin: async () => "complete", runHost: async () => "complete" });
    const stop = heartbeat.startDependencyReleaseNotifications();
    mockAdapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Root release delivered.", provider: "test", model: "test-model" };
    });
    try {
      await budgetService(db).upsertPolicy(f.companyId, input, null);
      await worker.process(f.agentId);
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
      expect(mockAdapterExecute).not.toHaveBeenCalled();
      await budgetService(db).upsertPolicy(f.companyId, { ...input, isActive: false }, null);
      await worker.process(f.agentId);
      expect(await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1)).toBe(true);
      await heartbeat.drainActiveRunExecutions();
      await budgetService(db).upsertPolicy(f.companyId, { ...input, isActive: false }, null);
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    } finally { await worker.stop(); await stop(); await heartbeat.resumeQueuedRunsAfterDrain(); }
  });

  const seedDependency = (status = "paused", nativeProducer = false) => seedNativeDependency(db, status, nativeProducer);

  it("parks a durable dependency input without consuming it or rewriting an unchanged hold", async () => {
    const { companyId, agentId, issueId, intent } = await seedDependency();
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    const parked = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ id: intent!.id, status: "deferred_issue_execution", runId: null, claimedAt: null });
    expect(parked[0]!.payload?._paperclipDependencyAdmission).toMatchObject({ version: 1 });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toEqual(parked);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    mockAdapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Dependency input delivered.", provider: "test", model: "test-model" };
    });
    const other = createDb(tempDb!.connectionString);
    const otherHeartbeat = heartbeatService(other);
    try {
      await db.update(agents).set({ status: "idle" }).where(eq(agents.id, agentId));
      await Promise.all([heartbeat.dispatchPendingNativeStatusWakeups({ companyId }),
        otherHeartbeat.dispatchPendingNativeStatusWakeups({ companyId })]);
      await heartbeat.drainActiveRunExecutions();
      await otherHeartbeat.drainActiveRunExecutions();
      const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
      expect(rows, JSON.stringify(rows.map(row => ({ id: row.id, reason: row.reason, actor: row.requestedByActorId, runId: row.runId, status: row.status })))).toHaveLength(2);
      const original = rows.find(row => row.id === intent!.id)!;
      const receipt = rows.find(row => row.id !== intent!.id)!;
      expect(original).toMatchObject({ status: "completed", runId: receipt.runId });
      expect(receipt.id).toBe((parked[0]!.payload!._paperclipDependencyAdmission as { receiptId: string }).receiptId);
      expect(receipt.runId).not.toBeNull();
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
      await Promise.all([heartbeat.dispatchPendingNativeStatusWakeups({ companyId }),
        otherHeartbeat.dispatchPendingNativeStatusWakeups({ companyId })]);
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toEqual(rows);
    } finally {
      await other.$client.end();
    }
  });

  it("leaves dependency actor text without durable provenance as visible repair work", async () => {
    const f = await seedDependency("idle");
    await db.delete(statusDecisionEffects).where(eq(statusDecisionEffects.targetId, f.intent.id));
    const before = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.intent.id));
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.intent.id))).toEqual(before);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it.each(["company_pause", "revoked_user", "blocker", "checkout", "terminal", "reassigned"])(
    "keeps current %s authority and becomes quiet after settlement", async gate => {
      const f = await seedDependency("idle");
      if (gate === "company_pause") await db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.companyId));
      if (gate === "revoked_user") await db.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.companyId, f.companyId));
      if (gate === "blocker") {
        await db.update(issues).set({ status: "todo" }).where(eq(issues.id, f.blockerId));
        await db.insert(issueRelations).values({ companyId: f.companyId, issueId: f.blockerId, relatedIssueId: f.issueId, type: "blocks" });
      }
      if (gate === "checkout") await db.update(issues).set({ checkoutRunId: f.runId }).where(eq(issues.id, f.issueId));
      if (gate === "terminal") await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
      if (gate === "reassigned") await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: "responsible-user" }).where(eq(issues.id, f.issueId));
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
      const settled = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
      expect(settled).toHaveLength(1);
      expect(settled[0]!.status).toBe(["terminal", "reassigned"].includes(gate) ? "skipped" : "deferred_issue_execution");
      expect(settled[0]!.claimedAt).toBeNull();
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual(settled);
      expect(mockAdapterExecute).not.toHaveBeenCalled();
    });

  it("does not take over or rewrite an unexpired claim", async () => {
    const f = await seedDependency("idle");
    await db.update(agentWakeupRequests).set({ status: "claimed", claimedAt: new Date() }).where(eq(agentWakeupRequests.id, f.intent.id));
    const before = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual(before);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("adopts a verified legacy pause receipt once using its original primary key", async () => {
    const f = await seedDependency();
    const [legacy] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", triggerDetail: "system", reason: "agent.not_invokable", status: "skipped",
      finishedAt: new Date(1000),
      requestedByActorType: "system", requestedByActorId: `native-status-wake-dispatch:${f.intent.id}`,
      idempotencyKey: "execution-wait:legacy-paused", payload: { ...f.intent.payload,
        _paperclipWakeContext: { ...f.intent.payload!._paperclipWakeContext, nativeStatusWakeIntentId: f.intent.id },
        executionWait: { status: "paused", reason: "paused", requestedIdempotencyKey: f.intent.idempotencyKey } },
    }).returning();
    await db.update(agentWakeupRequests).set({ status: "skipped", finishedAt: new Date(1000) }).where(eq(agentWakeupRequests.id, f.intent.id));
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    const parked = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(parked).toHaveLength(2);
    expect(parked.find(row => row.id === legacy!.id)).toMatchObject({ reason: "issue_blockers_resolved", status: "deferred_issue_execution", runId: null, finishedAt: null });
    expect(parked.find(row => row.id === f.intent.id)).toMatchObject({ status: "coalesced", finishedAt: null, payload: {
      _paperclipDependencyAdmission: { receiptId: legacy!.id } } });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual(parked);
    mockAdapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Legacy delivered.", provider: "test", model: "test-model" };
    });
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    const delivered = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(delivered).toHaveLength(2);
    expect(delivered.find(row => row.id === legacy!.id)!.runId).not.toBeNull();
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("a stale losing claimant cannot settle or catch-requeue the winner (catch=%s)", async loseResponse => {
    const f = await seedDependency();
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    const other = createDb(tempDb!.connectionString), otherHeartbeat = heartbeatService(other);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const claimed = new Promise<void>(resolve => { entered = resolve; });
    const originalTransaction = db.transaction.bind(db);
    let intercept = true;
    const spy = vi.spyOn(db, "transaction").mockImplementation(async (callback, config) => {
      const result = await originalTransaction(callback, config);
      const [row] = await other.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.intent.id));
      if (intercept && row?.status === "claimed" && !row.runId) {
        intercept = false;
        entered();
        await held;
        if (loseResponse) throw new Error("Controlled losing claimant response failure");
      }
      return result;
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    let observedClaimAt = 0;
    const otherTransaction = other.transaction.bind(other);
    const otherSpy = vi.spyOn(other, "transaction").mockImplementation(async (callback, config) => {
      const result = await otherTransaction(callback, config);
      const [row] = await other.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.intent.id));
      if (observedClaimAt > 0 && row?.status === "claimed" && row.claimedAt!.getTime() > observedClaimAt) clock.mockRestore();
      return result;
    });
    const first = heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    try {
      await claimed;
      const [firstClaim] = await other.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.intent.id));
      observedClaimAt = firstClaim!.claimedAt!.getTime();
      mockAdapterExecute.mockImplementationOnce(async () => {
        await other.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
        return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Winner delivered.", provider: "test", model: "test-model" };
      });
      await otherHeartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
      const [winningIntent] = await other.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.intent.id));
      await otherHeartbeat.waitForRunExecutionDrain(winningIntent!.runId!);
      const winner = await other.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
      const intent = winner.find(row => row.id === f.intent.id)!;
      expect(intent.runId, JSON.stringify(winner.map(row => ({ status: row.status, runId: row.runId, error: row.error })))).not.toBeNull();
      expect(intent.claimedAt!.getTime()).toBeGreaterThan(firstClaim!.claimedAt!.getTime());
      release();
      await first;
      expect(await other.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual(winner);
      expect(winner, JSON.stringify(winner.map(row => ({ id: row.id, reason: row.reason, actor: row.requestedByActorId, status: row.status })))).toHaveLength(2);
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    } finally {
      release();
      clock.mockRestore();
      otherSpy.mockRestore();
      await first;
      spy.mockRestore();
      await other.$client.end();
    }
  }, 15_000);

  it("never adopts a receipt bound to a foreign company or target", async () => {
    const own = await seedDependency(), foreign = await seedDependency();
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: own.companyId });
    const [parked] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, own.intent.id));
    const receiptId = (parked!.payload!._paperclipDependencyAdmission as { receiptId: string }).receiptId;
    await db.insert(agentWakeupRequests).values({ id: receiptId, companyId: foreign.companyId, agentId: foreign.agentId,
      source: "automation", triggerDetail: "system", reason: "issue_blockers_resolved", status: "deferred_issue_execution",
      requestedByActorType: "system", requestedByActorId: `native-status-wake-dispatch:${own.intent.id}`,
      idempotencyKey: own.intent.idempotencyKey, payload: { ...own.intent.payload, issueId: foreign.issueId,
        _paperclipWakeContext: { issueId: foreign.issueId, nativeStatusWakeIntentId: own.intent.id } } });
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, own.agentId));
    const before = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, foreign.companyId));
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: own.companyId });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, foreign.companyId))).toEqual(before);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, own.intent.id))).toEqual([parked]);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("does not invent an owner for ambiguous legacy receipts", async () => {
    const f = await seedDependency();
    await db.insert(agentWakeupRequests).values([0, 1].map(index => ({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", triggerDetail: "system", reason: "agent.not_invokable", status: "skipped",
      requestedByActorType: "system", requestedByActorId: `native-status-wake-dispatch:${f.intent.id}`,
      idempotencyKey: `execution-wait:ambiguous-${index}`, payload: { ...f.intent.payload,
        _paperclipWakeContext: { issueId: f.issueId, taskId: f.issueId, source: "native_status_decision", nativeStatusWakeIntentId: f.intent.id },
        executionWait: { status: "paused", reason: "paused", requestedIdempotencyKey: f.intent.idempotencyKey } } })));
    const before = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual(before);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it.each(["verified", "missing_provenance", "corrupt_reservation", "other_native", "conflicting_run"])("keeps a historical %s run-linked dependency out of generic local-child replay", async proof => {
    const f = await seedDependency("idle"), receiptId = randomUUID(), runId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: receiptId, companyId: f.companyId, agentId: f.agentId,
      source: "automation", triggerDetail: "system", reason: "issue_blockers_resolved", status: "claimed",
      requestedByActorType: "system", requestedByActorId: `native-status-wake-dispatch:${f.intent.id}`,
      idempotencyKey: f.intent.idempotencyKey, payload: { ...f.intent.payload,
        _paperclipWakeContext: { issueId: f.issueId, taskId: f.issueId, source: "native_status_decision", nativeStatusWakeIntentId: f.intent.id } } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "running",
      invocationSource: "automation", triggerDetail: "system", wakeupRequestId: receiptId,
      contextSnapshot: { issueId: f.issueId, nativeStatusWakeIntentId: f.intent.id, wakeReason: "issue_blockers_resolved" },
      runtimeMode: "legacy", controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(0), executionStage: "dispatching",
      processPid: proof === "conflicting_run" ? null : 2_147_483_647, startedAt: new Date(0), updatedAt: new Date(0) });
    await db.update(agentWakeupRequests).set({ runId, status: "completed" }).where(eq(agentWakeupRequests.id, f.intent.id));
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, receiptId));
    await db.update(issues).set({ executionRunId: runId, status: "in_progress" }).where(eq(issues.id, f.issueId));
    if (proof === "conflicting_run") {
      await db.update(heartbeatRuns).set({ executionStage: "preparing" }).where(eq(heartbeatRuns.id, runId));      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.issueId));

      await db.update(agentWakeupRequests).set({ runId: f.runId }).where(eq(agentWakeupRequests.id, f.intent.id));
    }
    if (proof === "missing_provenance") await db.delete(statusDecisionEffects).where(eq(statusDecisionEffects.targetId, f.intent.id));
    if (proof === "corrupt_reservation") await db.update(agentWakeupRequests).set({
      payload: { ...f.intent.payload, _paperclipDependencyAdmission: { version: 1, intentId: randomUUID() } },
    }).where(eq(agentWakeupRequests.id, f.intent.id));
    if (proof === "other_native") {
      await db.update(agentWakeupRequests).set({ reason: "issue_status_changed" }).where(inArray(agentWakeupRequests.id, [f.intent.id, receiptId]));
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issueId, nativeStatusWakeIntentId: f.intent.id,
        wakeReason: "issue_status_changed" } }).where(eq(heartbeatRuns.id, runId));
    }
    await heartbeat.reapOrphanedRuns({ staleThresholdMs: 0 });
    await heartbeat.drainActiveRunExecutions();
    const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(rows, JSON.stringify(rows.map(row => ({ id: row.id, status: row.status, reason: row.contextSnapshot?.wakeReason, retryOf: row.retryOfRunId })))).toHaveLength(2);
    expect(rows.find(row => row.id === runId)).toMatchObject({ status: "failed", errorCode: "process_lost",
      resultJson: { processLossDiagnostic: { retryEligible: proof === "other_native" } } });
    const [original] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.intent.id));
    expect(original).toMatchObject({ status: "completed", runId: proof === "conflicting_run" ? f.runId : runId });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  }, 20_000);

  it.each(["running", "failed", "succeeded"].flatMap(runStatus => [false, true].map(scopeValid => ({ runStatus, scopeValid }))))(
    "preserves historical $runStatus ownership with authoritative issue match=$scopeValid", async ({ runStatus, scopeValid }) => {
    const f = await seedDependency();
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    const [parked] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.intent.id));
    const receiptId = (parked!.payload!._paperclipDependencyAdmission as { receiptId: string }).receiptId;
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: receiptId, companyId: f.companyId, agentId: f.agentId,
      source: "automation", triggerDetail: "system", reason: "issue_blockers_resolved", status: "claimed",
      requestedByActorType: "system", requestedByActorId: `native-status-wake-dispatch:${f.intent.id}`,
      idempotencyKey: f.intent.idempotencyKey, payload: { ...f.intent.payload,
        _paperclipWakeContext: { ...f.intent.payload!._paperclipWakeContext as object, nativeStatusWakeIntentId: f.intent.id } } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: runStatus,
      invocationSource: "automation", wakeupRequestId: receiptId, scopeKind: "issue", issueId: scopeValid ? f.issueId : f.blockerId,
      contextSnapshot: { issueId: f.issueId, nativeStatusWakeIntentId: f.intent.id, wakeReason: "issue_blockers_resolved" } });
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, receiptId));
    const before = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    const after = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    if (scopeValid) {
      expect(after).toHaveLength(2);
      expect(after.find(row => row.id === f.intent.id)).toMatchObject({ status: "completed", runId });
      expect(after.find(row => row.id === receiptId)).toMatchObject({ runId });
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual(after);
    } else expect(after).toEqual(before);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, runId));
  });

  it.each(["restore", "cancel", "pause", "revoke"])("revalidates a %s change between observation and admission locks", async change => {
    const f = await seedDependency("idle");
    if (change === "restore") await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
    const other = createDb(tempDb!.connectionString);
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const observed = new Promise<void>(resolve => { entered = resolve; });
    const transaction = db.transaction.bind(db);
    let intercept = true;
    const spy = vi.spyOn(db, "transaction").mockImplementation(async (callback, config) => {
      if (intercept) { intercept = false; entered(); await held; }
      return transaction(callback, config);
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await other.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Restored before lock.", provider: "test", model: "test-model" };
    });
    const dispatch = heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    try {
      await observed;
      if (change === "restore") await other.update(issues).set({ status: "todo" }).where(eq(issues.id, f.issueId));
      if (change === "cancel") await other.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
      if (change === "pause") await other.update(agents).set({ status: "paused" }).where(eq(agents.id, f.agentId));
      if (change === "revoke") await other.update(companyMemberships).set({ status: "inactive" }).where(eq(companyMemberships.companyId, f.companyId));
      release(); await dispatch; await heartbeat.drainActiveRunExecutions();
      const rows = await other.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
      expect(rows.find(row => row.id === f.intent.id)).toMatchObject({ status: change === "restore" ? "completed" : change === "cancel" ? "skipped" : "deferred_issue_execution" });
      expect(mockAdapterExecute).toHaveBeenCalledTimes(change === "restore" ? 1 : 0);
      if (change !== "restore") expect(rows[0]).toMatchObject({ claimedAt: null, runId: null });
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
      expect(await other.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual(rows);
    } finally {
      release(); await dispatch; spy.mockRestore(); await other.$client.end();
    }
  }, 15_000);

  it.each(["valid", "forged_target", "superseded_claim"])("fences terminal receipt recovery with %s evidence", async evidence => {
    const f = await seedDependency();
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    const [parked] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.intent.id));
    const receiptId = (parked!.payload!._paperclipDependencyAdmission as { receiptId: string }).receiptId;
    const runId = randomUUID(), claimedAt = new Date(1000);
    await db.insert(agentWakeupRequests).values({ id: receiptId, companyId: f.companyId, agentId: f.agentId,
      source: "automation", triggerDetail: "system", reason: "issue_blockers_resolved", status: "claimed", claimedAt,
      requestedByActorType: "system", requestedByActorId: `native-status-wake-dispatch:${f.intent.id}`,
      idempotencyKey: f.intent.idempotencyKey, payload: { ...f.intent.payload,
        issueId: evidence === "forged_target" ? f.blockerId : f.issueId,
        _paperclipWakeContext: { ...f.intent.payload!._paperclipWakeContext as object, nativeStatusWakeIntentId: f.intent.id } } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "succeeded",
      invocationSource: "automation", wakeupRequestId: receiptId, scopeKind: "issue", issueId: f.issueId,
      finishedAt: new Date(2000), resultJson: { summary: "Persisted result" }, contextSnapshot: { issueId: f.issueId } });
    await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, receiptId));
    await db.update(agentWakeupRequests).set({ runId, status: "completed" }).where(eq(agentWakeupRequests.id, f.intent.id));
    const before = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    const other = createDb(tempDb!.connectionString), otherHeartbeat = heartbeatService(other);
    const transaction = db.transaction.bind(db);
    let intercept = true;
    const spy = vi.spyOn(db, "transaction").mockImplementation(async (callback, config) => {
      if (intercept && evidence === "superseded_claim") {
        intercept = false;
        await other.update(agentWakeupRequests).set({ claimedAt: new Date(3000) }).where(eq(agentWakeupRequests.id, receiptId));
      }
      return transaction(callback, config);
    });
    try {
      if (evidence === "superseded_claim") {
        await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
        const [stale] = await other.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receiptId));
        expect(stale).toMatchObject({ status: "claimed", claimedAt: new Date(3000) });
      }
      await Promise.all([heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId }), otherHeartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId })]);
      const after = await other.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
      if (evidence === "forged_target") expect(after).toEqual(before);
      else {
        expect(after.find(row => row.id === receiptId)).toMatchObject({ status: "completed", runId,
          claimedAt: evidence === "superseded_claim" ? new Date(3000) : claimedAt, finishedAt: new Date(2000) });
        expect(after.find(row => row.id === f.intent.id)).toEqual(before.find(row => row.id === f.intent.id));
      }
      expect(mockAdapterExecute).not.toHaveBeenCalled();
      await otherHeartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
      expect(await other.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual(after);
    } finally { spy.mockRestore(); await other.$client.end(); }
  });

  it("retains the real native completion producer input through a pause", async () => {
    const f = await seedDependency("paused", true);
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    const [parked] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.intent.id));
    expect(parked).toMatchObject({ status: "deferred_issue_execution", runId: null });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual([parked]);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("takes over a null claim timestamp using the same reserved receipt", async () => {
    const f = await seedDependency("idle");
    await db.update(agentWakeupRequests).set({ status: "claimed", claimedAt: null }).where(eq(agentWakeupRequests.id, f.intent.id));
    mockAdapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Null claim delivered.", provider: "test", model: "test-model" };
    });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(rows).toHaveLength(2);
    const intent = rows.find(row => row.id === f.intent.id)!;
    expect(intent).toMatchObject({ status: "completed" });
    expect(intent.claimedAt).not.toBeNull();
    expect(intent.runId).not.toBeNull();
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual(rows);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("retires both owners once when a deferred receipt target is cancelled", async () => {
    const f = await seedDependency();
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    const [parked] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.intent.id));
    const receiptId = (parked!.payload!._paperclipDependencyAdmission as { receiptId: string }).receiptId;
    await db.insert(agentWakeupRequests).values({ id: receiptId, companyId: f.companyId, agentId: f.agentId,
      source: "automation", triggerDetail: "system", reason: "issue_blockers_resolved", status: "deferred_issue_execution",
      requestedByActorType: "system", requestedByActorId: `native-status-wake-dispatch:${f.intent.id}`,
      idempotencyKey: f.intent.idempotencyKey, payload: { ...f.intent.payload,
        _paperclipWakeContext: { issueId: f.issueId, taskId: f.issueId, source: "native_status_decision", nativeStatusWakeIntentId: f.intent.id } } });
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    const retired = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(retired).toHaveLength(2);
    expect(retired.every(row => row.status === "skipped" && row.runId === null)).toBe(true);
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual(retired);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it.each(["retired", "historical", "unfinished_historical"])("excludes %s dependency history from a limit-one native batch", async kind => {
    const f = await seedDependency("idle");
    if (kind === "retired") {
      await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issueId));
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    } else {
      await db.update(agentWakeupRequests).set({ status: "skipped", finishedAt: kind === "historical" ? new Date() : null })
        .where(eq(agentWakeupRequests.id, f.intent.id));
    }
    await db.update(agentWakeupRequests).set({ requestedAt: new Date(0) }).where(eq(agentWakeupRequests.id, f.intent.id));
    const [old] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.intent.id));
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "New native work", status: "todo",
      assigneeAgentId: f.agentId, responsibleUserId: "responsible-user" });
    const [fresh] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", triggerDetail: "system", reason: "issue_children_completed", status: "queued",
      requestedByActorType: "system", requestedByActorId: "native-status-committer", payload: { issueId } }).returning();
    mockAdapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "New native work delivered.", provider: "test", model: "test-model" };
    });
    const warn = vi.spyOn(logger, "warn");
    try {
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId, limit: 1 });
      await heartbeat.drainActiveRunExecutions();
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
      const [delivered] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, fresh!.id));
      expect(delivered!.runId).not.toBeNull();
      const transaction = vi.spyOn(db, "transaction");
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId, limit: 1 });
        }
        expect(transaction).not.toHaveBeenCalled();
      } finally { transaction.mockRestore(); }
      expect(warn.mock.calls.filter(args => JSON.stringify(args).includes(f.intent.id))).toHaveLength(0);
      expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.intent.id)))[0]).toEqual(old);
    } finally { warn.mockRestore(); }
  });

  it.each(["parked", "conflicting_intent", "unrecoverable_result"].flatMap(dependency =>
    ["native", "cross_task"].map(source => ({ dependency, source }))))(
    "dispatches $source work beside an older $dependency dependency with limit one", async ({ dependency, source }) => {
    const f = await seedDependency("idle");
    await db.insert(issueTreeHolds).values({ companyId: f.companyId, rootIssueId: f.issueId,
      mode: "pause", status: "active", reason: "Fixture dependency hold" });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    if (dependency === "conflicting_intent") {
      await db.update(agentWakeupRequests).set({ payload: { ...f.intent.payload,
        _paperclipDependencyAdmission: { version: 1, intentId: randomUUID() } } }).where(eq(agentWakeupRequests.id, f.intent.id));
    }
    if (dependency === "unrecoverable_result") {
      const [intent] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.intent.id));
      const receiptId = (intent!.payload!._paperclipDependencyAdmission as { receiptId: string }).receiptId;
      const runId = randomUUID();
      await db.insert(agentWakeupRequests).values({ id: receiptId, companyId: f.companyId, agentId: f.agentId,
        source: "automation", triggerDetail: "system", reason: "issue_blockers_resolved", status: "claimed",
        requestedByActorType: "system", requestedByActorId: `native-status-wake-dispatch:${f.intent.id}`,
        idempotencyKey: f.intent.idempotencyKey, payload: { ...f.intent.payload, issueId: f.blockerId,
          _paperclipWakeContext: { nativeStatusWakeIntentId: f.intent.id } }, requestedAt: new Date(0) });
      await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId, status: "succeeded",
        invocationSource: "automation", wakeupRequestId: receiptId, scopeKind: "issue", issueId: f.issueId,
        finishedAt: new Date(), resultJson: { summary: "Persisted dependency result" }, contextSnapshot: { issueId: f.issueId } });
      await db.update(agentWakeupRequests).set({ runId }).where(eq(agentWakeupRequests.id, receiptId));
      await db.update(agentWakeupRequests).set({ runId, status: "completed" }).where(eq(agentWakeupRequests.id, f.intent.id));
    }
    await db.update(agentWakeupRequests).set({ requestedAt: new Date(0) }).where(eq(agentWakeupRequests.id, f.intent.id));
    const old = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)).orderBy(agentWakeupRequests.id);
    const issueId = randomUUID(), commentId = randomUUID();
    const workspaceId = source === "cross_task" ? randomUUID() : null;
    if (workspaceId) await db.insert(executionWorkspaces).values({ id: workspaceId, companyId: f.companyId,
      name: "Active continuation workspace", mode: "isolated_workspace", strategyType: "git_worktree",
      status: "active", cwd: continuationCwd });
    await db.insert(issues).values({ id: issueId, companyId: f.companyId, title: "Fresh native work", status: "todo",
      assigneeAgentId: f.agentId, responsibleUserId: "responsible-user", executionWorkspaceId: workspaceId });
    if (source === "cross_task") await db.insert(issueComments).values({ id: commentId, companyId: f.companyId,
      issueId, authorUserId: "responsible-user", body: "Continue this task." });
    const [fresh] = await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId,
      source: "automation", triggerDetail: "system", status: "queued", requestedByActorType: "system",
      reason: source === "native" ? "issue_children_completed" : "issue_reopened_via_comment",
      requestedByActorId: source === "native" ? "native-status-committer" : CROSS_TASK_CONTINUATION_COMMITTER_ID,
      idempotencyKey: source === "native" ? null : crossTaskContinuationIntentKey(issueId, commentId),
      payload: source === "native" ? { issueId } : { issueId, taskId: issueId, commentId,
        _paperclipWakeContext: { issueId, taskId: issueId, wakeReason: "issue_reopened_via_comment",
          wakeCommentId: commentId, source: "cross_task_continuation" },
        reopenedFrom: "done", mutation: "comment", resumeIntent: true,
        followUpRequested: true, crossTaskContinuation: { requestedByAgentId: f.agentId, sourceRunId: randomUUID(),
          sourceIssueId: randomUUID(), workspaceId, workspaceGeneration: 0, expectedAssigneeAgentId: f.agentId,
          expectedResponsibleUserId: "responsible-user", requestDigest: "digest" } } }).returning();
    mockAdapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Fresh work delivered.", provider: "test", model: "test-model" };
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId, limit: 1 });
      await heartbeat.drainActiveRunExecutions();
      const [delivered] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, fresh!.id));
      expect(delivered).toMatchObject({ error: null });
      expect(delivered!.runId).not.toBeNull();
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
      const history = await db.select().from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, old.map(row => row.id))).orderBy(agentWakeupRequests.id);
      expect(history).toEqual(old);
    }
  });

  it("keeps one provenance binding when repeated native effects reference the same intent", async () => {
    const f = await seedDependency();
    const [effect] = await db.select().from(statusDecisionEffects).where(eq(statusDecisionEffects.targetId, f.intent.id));
    await db.insert(statusDecisionEffects).values({ ...effect!, id: randomUUID(), ordinal: 1, idempotencyKey: randomUUID() });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    const [parked] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.intent.id));
    expect(parked).toMatchObject({ status: "deferred_issue_execution", runId: null });
    const binding = parked!.payload!._paperclipDependencyAdmission;
    await db.insert(statusDecisionEffects).values({ ...effect!, id: randomUUID(), ordinal: 2,
      idempotencyKey: randomUUID(), createdAt: new Date(0) });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Repeated effects delivered once.", provider: "test", model: "test-model" };
    });
    await db.update(agents).set({ status: "idle" }).where(eq(agents.id, f.agentId));
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    const [delivered] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.intent.id));
    expect(delivered!.payload!._paperclipDependencyAdmission).toEqual(binding);
    expect(delivered!.runId).not.toBeNull();
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it.each(["maxDailyRuns", "maxDailyCostCents"])("keeps unchanged %s policy holds quiet before a claim", async limit => {
    const f = await seedDependency("idle");
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true, [limit]: 0 } } }).where(eq(agents.id, f.agentId));
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    const parked = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ id: f.intent.id, status: "deferred_issue_execution", claimedAt: null, runId: null });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual(parked);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("keeps an actual positive project budget hold quiet and reuses its input after legal release", async () => {
    const f = await seedDependency("idle"), projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Budget dependency", status: "in_progress" });
    await db.update(issues).set({ projectId }).where(eq(issues.id, f.issueId));
    const budgets = budgetService(db);
    await budgets.upsertPolicy(f.companyId, { scopeType: "project", scopeId: projectId, amount: 100, windowKind: "lifetime" }, "responsible-user");
    const [cost] = await db.insert(costEvents).values({ companyId: f.companyId, agentId: f.agentId, projectId,
      provider: "openai", biller: "openai", billingType: "metered_api", model: "test-model", costCents: 125,
      inputTokens: 100, cachedInputTokens: 0, outputTokens: 20, occurredAt: new Date() }).returning();
    await budgets.evaluateCostEvent(cost!);
    expect((await db.select().from(projects).where(eq(projects.id, projectId)))[0]).toMatchObject({ pauseReason: "budget" });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    const parked = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ id: f.intent.id, status: "deferred_issue_execution", runId: null, claimedAt: null });
    const policy = await db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, f.companyId));
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual(parked);
    expect(await db.select().from(budgetPolicies).where(eq(budgetPolicies.companyId, f.companyId))).toEqual(policy);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    await budgets.upsertPolicy(f.companyId, { scopeType: "project", scopeId: projectId, amount: 200, windowKind: "lifetime" }, "responsible-user");
    mockAdapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null, summary: "Budget release delivered.", provider: "test", model: "test-model" };
    });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    await heartbeat.drainActiveRunExecutions();
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(rows).toHaveLength(2);
    expect(rows.find(row => row.id === f.intent.id)).toMatchObject({ status: "completed" });
  });

  it("does not turn a dependency input into pending review authority", async () => {
    const f = await seedDependency("idle"), executorId = randomUUID();
    await db.insert(agents).values({ id: executorId, companyId: f.companyId, name: "Review executor", role: "engineer",
      status: "idle", adapterType: "http", adapterConfig: {} });
    const policy = normalizeIssueExecutionPolicy({ mode: "normal", commentRequired: true, stages: [{ type: "review",
      participants: [{ type: "agent", agentId: f.agentId }], approvalsNeeded: 1 }] });
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    const transition = applyIssueExecutionPolicyTransition({ issue: { ...task!, assigneeAgentId: executorId }, policy,
      previousPolicy: null, requestedStatus: "done", requestedAssigneePatch: {}, actor: { agentId: executorId, userId: null },
      allowBoardOverride: false, commentBody: "Ready for independent review." });
    await db.update(issues).set({ ...transition.patch, executionPolicy: policy }).where(eq(issues.id, f.issueId));
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    const before = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    expect(before[0]).toMatchObject({ status: "deferred_issue_execution", error: "review", runId: null });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toEqual(before);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("delivers a revised native child completion after the running parent blocks", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const childId = randomUUID();
    const decisionId = randomUUID();
    let finishParent!: () => void;
    const parentFinished = new Promise<void>((resolve) => { finishParent = resolve; });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await parentFinished;
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Waiting for the child revision.", provider: "test", model: "test-model" };
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      const [run] = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.status, "running"),
      ));
      await db.insert(issueComments).values({ companyId, issueId, authorAgentId: agentId,
        authorType: "agent", createdByRunId: run!.id, body: "Reviewed and delivered the revised ZIP." });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Reviewed and delivered the revised ZIP.", provider: "test", model: "test-model" };
    });
    await db.insert(companies).values({ id: companyId, name: "Native handoff",
      issuePrefix: `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Parent", role: "engineer",
      status: "active", adapterType: "codex_local", adapterConfig: {}, permissions: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Deliver the revised ZIP", status: "todo",
        assigneeAgentId: agentId, responsibleUserId: "responsible-user" },
      { id: childId, companyId, parentId: issueId, title: "Revise the ZIP", status: "done",
        responsibleUserId: "responsible-user" },
    ]);
    try {
      const parentRun = await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system",
        reason: "issue_assigned", payload: { issueId }, contextSnapshot: { issueId, wakeReason: "issue_assigned" } });
      expect(parentRun).not.toBeNull();
      await db.insert(issueComments).values({ companyId, issueId, authorAgentId: agentId,
        authorType: "agent", createdByRunId: parentRun!.id, body: "Waiting for the child revision." });
      expect(await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1, 30_000)).toBe(true);
      const [intent] = await db.insert(agentWakeupRequests).values({ companyId, agentId,
        source: "automation", triggerDetail: "system", reason: "issue_children_completed",
        requestedByActorType: "system", requestedByActorId: "native-status-committer",
        idempotencyKey: `issue_children_completed:${issueId}:${childId}:${decisionId}`,
        payload: { issueId, taskId: issueId, _paperclipWakeContext: {
          issueId, taskId: issueId, source: "native_status_decision",
          nativeChildCompletionDecisionId: decisionId, completedChildIssueId: childId,
          childIssueIds: [childId], childIssueSummaries: [{ id: childId, summary: "Revised ZIP: 11 tests." }],
        } },
      }).returning();
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
      const deferred = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
      ));
      expect(deferred).toHaveLength(1);
      expect(deferred[0]!.runId).toBeNull();
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
      finishParent();
      expect(await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 2, 10_000)).toBe(true);
      await heartbeat.drainActiveRunExecutions();
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      expect(runs.map((run) => ({ id: run.id, status: run.status, context: run.contextSnapshot, error: run.error }))).toHaveLength(2);
      const continuation = runs.find((run) => run.id !== parentRun!.id)!;
      expect(continuation.contextSnapshot).toMatchObject({
        wakeReason: "issue_children_completed", nativeChildCompletionDecisionId: decisionId,
        nativeStatusWakeIntentId: intent!.id, completedChildIssueId: childId,
        childIssueSummaries: [{ id: childId, summary: "Revised ZIP: 11 tests." }],
      });
      expect(continuation.status).toBe("succeeded");
      const first = runs.find((run) => run.id === parentRun!.id)!;
      expect(continuation.startedAt!.getTime()).toBeGreaterThanOrEqual(first.finishedAt!.getTime());
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(2);
    } finally {
      finishParent();
    }
  }, 45_000);

  it("keeps a saved native continuation behind its active predecessor without retagging that run", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    let finishPredecessor!: () => void;
    const predecessorFinished = new Promise<void>(resolve => { finishPredecessor = resolve; });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await predecessorFinished;
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "The repository is staged; continue on the saved admission.", provider: "test", model: "test-model" };
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Verified and delivered the prepared repository.", provider: "test", model: "test-model" };
    });
    await db.insert(companies).values({ id: companyId, name: "Saved repository continuation",
      issuePrefix: `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Repository worker", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, permissions: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Continue repository verification", status: "todo",
      assigneeAgentId: agentId, responsibleUserId: "responsible-user" });
    try {
      const predecessor = await heartbeat.wakeup(agentId, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
        payload: { issueId }, contextSnapshot: { issueId, source: "initial-repository-request" } });
      expect(predecessor).not.toBeNull();
      expect(await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1, 30_000)).toBe(true);
      const contractId = randomUUID(), resultId = randomUUID(), assessmentId = randomUUID(), decisionId = randomUUID();
      await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1,
        schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard",
        completionAuthority: "server_arbiter", incompleteCriteriaPolicy: "preserve_non_terminal",
        contractJson: {}, canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
      await db.update(heartbeatRuns).set({ nativeIssueId: issueId, completionContractId: contractId }).where(eq(heartbeatRuns.id, predecessor!.id));
      await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId, runId: predecessor!.id,
        completionContractId: contractId, serverFingerprint: resultId, schemaStatus: "accepted", resultJson: {}, canonicalSha256: resultId });
      await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId, runId: predecessor!.id,
        contractId, resultId, triggerKind: "turn_finished", triggerActorCompanyId: companyId,
        priorIssueStatus: "in_progress", priorStatusVersion: 0, policyVersion: "test", assessmentJson: {}, inputDigest: assessmentId });
      await db.insert(statusDecisions).values({ id: decisionId, companyId, issueId, runId: predecessor!.id,
        assessmentId, decisionVersion: 1, policyVersion: "test", fromStatus: "in_progress", toStatus: "in_progress",
        reasonCode: "live_continuation_registered", decisionJson: {}, decisionDigest: decisionId, applicationState: "applied", appliedAt: new Date() });
      const [intent] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system",
        reason: "issue_status_changed", requestedByActorType: "system", requestedByActorId: "native-status-committer",
        idempotencyKey: `native-status:${decisionId}:continuation`, payload: { issueId, taskId: issueId, nativeDecisionId: decisionId, continuationKind: "same_agent",
          _paperclipWakeContext: { issueId, taskId: issueId, source: "native_status_decision", continuationKind: "same_agent" } } }).returning();
      await db.insert(statusDecisionEffects).values({ companyId, issueId, decisionId, ordinal: 0,
        effectKind: "enqueue_continuation", targetType: "agent_wakeup_request", targetId: intent!.id,
        idempotencyKey: `native-status:${decisionId}:continuation`, payload: { continuationKind: "same_agent" }, deliveryState: "delivered", deliveredAt: new Date() });
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
      const queued = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
      expect(queued.filter(row => row.status === "deferred_issue_execution"), JSON.stringify(queued.map(row => ({ status: row.status, reason: row.reason, runId: row.runId, error: row.error })))).toHaveLength(1);
      expect(queued.find(row => row.id === intent!.id)).toMatchObject({ status: "coalesced", runId: null });
      const [unchanged] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, predecessor!.id));
      expect(unchanged!.contextSnapshot).toMatchObject({ source: "initial-repository-request" });
      expect(unchanged!.contextSnapshot?.nativeStatusWakeIntentId).toBeUndefined();
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
      finishPredecessor();
      expect(await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 2, 10_000)).toBe(true);
      await heartbeat.drainActiveRunExecutions();
      const completed = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      expect(completed).toHaveLength(2);
      const successor = completed.find(run => run.id !== predecessor!.id)!;
      expect(successor).toMatchObject({ status: "succeeded", contextSnapshot: { source: "native_status_decision", nativeStatusWakeIntentId: intent!.id } });
      expect(successor.startedAt!.getTime()).toBeGreaterThanOrEqual(completed.find(run => run.id === predecessor!.id)!.finishedAt!.getTime());
      await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(2);
    } finally { finishPredecessor(); }
  }, 45_000);

  it("dispatches and coalesces durable native status wake intents into one heartbeat run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "NativeWakeRunner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Resume after native child completion",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    const nativeWakePayload = {
      issueId,
      taskId: issueId,
      _paperclipWakeContext: {
        issueId,
        taskId: issueId,
        source: "native_status_decision",
      },
    };
    const intents = await db.insert(agentWakeupRequests).values([
      {
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_children_completed",
        payload: nativeWakePayload,
        requestedByActorType: "system",
        requestedByActorId: "native-status-committer",
        idempotencyKey: `native-parent:${issueId}`,
      },
      {
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "issue_status_changed",
        payload: nativeWakePayload,
        requestedByActorType: "system",
        requestedByActorId: "native-status-committer",
        idempotencyKey: `native-owner-status:${issueId}`,
      },
    ]).returning({ id: agentWakeupRequests.id });

    const result = await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect(result).toMatchObject({ scanned: 2, dispatched: 1, recovered: 1 });

    await heartbeat.drainActiveRunExecutions();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    const dispatchedRequests = await db.select().from(agentWakeupRequests).where(
      sql`${agentWakeupRequests.requestedByActorId} like 'native-status-wake-dispatch:%'`,
    );
    expect(dispatchedRequests).toHaveLength(1);
    const dispatchedRun = runs.find((run) => run.id === dispatchedRequests[0]!.runId);
    expect(dispatchedRun).toMatchObject({
      status: "succeeded",
      agentId,
      contextSnapshot: {
        source: "native_status_decision",
        statusDecisionSource: "native_status_decision",
      },
    });

    const persistedIntents = await db.select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      runId: agentWakeupRequests.runId,
    }).from(agentWakeupRequests).where(inArray(agentWakeupRequests.id, intents.map((intent) => intent.id)));
    expect(persistedIntents).toHaveLength(2);
    expect(persistedIntents).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "coalesced", runId: dispatchedRun!.id }),
      expect.objectContaining({ status: "coalesced", runId: dispatchedRun!.id }),
    ]));
    expect(dispatchedRequests[0]).toMatchObject({ runId: dispatchedRun!.id });
  });

  it.each(["onboarding", "ordinary", "cancelled"])("dispatches only a verified completed onboarding report: %s", async kind => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), childId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Completion", issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Lead", role: "engineer", status: "active", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Parent", status: kind === "cancelled" ? "cancelled" : "done",
      originKind: kind === "ordinary" ? "manual" : "onboarding_first_task", assigneeAgentId: agentId, responsibleUserId: "responsible-user" });
    await db.insert(issues).values({ id: childId, companyId, title: "Saved result", parentId: issueId, status: "done", assigneeAgentId: agentId });
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system", reason: "issue_children_completed",
      requestedByActorType: "system", requestedByActorId: "native-status-committer", idempotencyKey: `onboarding-completed:${issueId}`,
      payload: { issueId, _paperclipWakeContext: { issueId, completedChildIssueId: childId, onboardingCompletion: true } } });
    const result = await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect(result.dispatched).toBe(kind === "onboarding" ? 1 : 0);
    await heartbeat.drainActiveRunExecutions();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toHaveLength(kind === "onboarding" ? 1 : 0);
    if (kind === "onboarding") {
      expect({ status: runs[0].status, errorCode: runs[0].errorCode, error: runs[0].error })
        .toEqual({ status: "succeeded", errorCode: null, error: null });
      expect(runs[0].contextSnapshot).toMatchObject({
        onboardingCompletion: true, chatCompletionUpdates: [expect.objectContaining({ id: childId, status: "done" })],
      });
      expect(mockAdapterExecute).toHaveBeenCalledOnce();
    }
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).toBe(kind === "cancelled" ? "cancelled" : "done");
  });

  it("coalesces the native intent when dispatch admission defers behind an active issue run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const activeRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "NativeWakeRunner",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      triggerDetail: "system",
      contextSnapshot: { issueId },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Native wake behind active run",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      executionRunId: activeRunId,
      executionLockedAt: new Date(),
    });
    await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId: issueId,
      kind: "active_run_watchdog",
      status: "active",
      ownerType: "board",
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: activeRunId,
      evidence: { runId: activeRunId },
      nextAction: "Wait for the active execution to stop.",
    });
    const [intent] = await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_children_completed",
      payload: { issueId, taskId: issueId, _paperclipWakeContext: { issueId, taskId: issueId } },
      requestedByActorType: "system",
      requestedByActorId: "native-status-committer",
      idempotencyKey: `native-race:${issueId}`,
    }).returning();

    const result = await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect(result).toMatchObject({ scanned: 1, dispatched: 0, deferred: 1 });

    const rows = await db.select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      runId: agentWakeupRequests.runId,
      requestedByActorId: agentWakeupRequests.requestedByActorId,
    }).from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(rows.find((row) => row.id === intent!.id)).toMatchObject({
      status: "coalesced",
      runId: null,
    });
    expect(rows.filter((row) => row.status === "deferred_issue_execution")).toHaveLength(1);
    expect(rows.filter((row) => row.requestedByActorId?.startsWith("native-status-wake-dispatch:"))).toHaveLength(1);

    // Simulate the process crash window after the dispatch receipt was written
    // but before the committer intent was reconciled.
    await db.update(agentWakeupRequests).set({ status: "queued", updatedAt: new Date() })
      .where(eq(agentWakeupRequests.id, intent!.id));
    const recovered = await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect(recovered).toMatchObject({ scanned: 1, recovered: 1 });
    const recoveredIntent = await db.select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests).where(eq(agentWakeupRequests.id, intent!.id))
      .then((result) => result[0]);
    expect(recoveredIntent).toMatchObject({ status: "coalesced" });
  });

  it("keeps blocked descendants idle until their blockers resolve", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerId = randomUUID();
    const blockedIssueId = randomUUID();
    const readyIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Mission 0",
        status: "todo",
        priority: "high",
        responsibleUserId: "responsible-user",
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Mission 2",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      {
        id: readyIssueId,
        companyId,
        title: "Mission 1",
        status: "todo",
        priority: "critical",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const blockedWake = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: blockedIssueId },
      contextSnapshot: { issueId: blockedIssueId, wakeReason: "issue_assigned" },
    });
    expect(blockedWake).toBeNull();

    const blockedWakeRequest = await waitForCondition(async () => {
      const wakeup = await db
        .select({
          status: agentWakeupRequests.status,
          reason: agentWakeupRequests.reason,
        })
        .from(agentWakeupRequests)
        .where(
          and(
            eq(agentWakeupRequests.agentId, agentId),
            sql`${agentWakeupRequests.payload} ->> 'issueId' = ${blockedIssueId}`,
          ),
        )
        .orderBy(agentWakeupRequests.requestedAt)
        .then((rows) => rows[0] ?? null);
      return Boolean(
        wakeup &&
        wakeup.status === "skipped" &&
        wakeup.reason === "issue_dependencies_blocked",
      );
    });
    expect(blockedWakeRequest).toBe(true);

    const blockedRunsBeforeResolution = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${blockedIssueId}`)
      .then((rows) => rows[0]?.count ?? 0);
    expect(blockedRunsBeforeResolution).toBe(0);

    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId, companyId, issueId: blockedIssueId,
      authorType: "user", authorUserId: "responsible-user",
      body: "Explain the current dependency without starting blocked work.",
    });
    const interactionWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: blockedIssueId, commentId },
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "issue_commented",
      },
    });
    expect(interactionWake).not.toBeNull();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, interactionWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const interactionRun = await db
      .select({
        status: heartbeatRuns.status,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, interactionWake!.id))
      .then((rows) => rows[0] ?? null);

    expect(interactionRun?.status).toBe("succeeded");
    expect(interactionRun?.contextSnapshot).toMatchObject({
      dependencyBlockedInteraction: true,
      unresolvedBlockerIssueIds: [blockerId],
    });

    let finishReadyRun!: () => void;
    const readyRunCanFinish = new Promise<void>((resolve) => {
      finishReadyRun = resolve;
    });
    mockAdapterExecute.mockImplementationOnce(async () => {
      await readyRunCanFinish;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "Ready dependency scheduling run complete.",
        provider: "test",
        model: "test-model",
      };
    });

    const readyWake = await heartbeat.wakeup(agentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: readyIssueId },
      contextSnapshot: { issueId: readyIssueId, wakeReason: "issue_assigned" },
    });
    expect(readyWake).not.toBeNull();
    await db.insert(issueComments).values({
      companyId,
      issueId: readyIssueId,
      authorAgentId: agentId,
      authorType: "agent",
      createdByRunId: readyWake!.id,
      body: "Ready dependency scheduling run complete.",
    });
    finishReadyRun();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, readyWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const readyRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, readyWake!.id))
      .then((rows) => rows[0] ?? null);

    expect(readyRun?.status).toBe("succeeded");

    await db
      .update(issues)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(issues.id, blockerId));

    const promotedWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: blockedIssueId, resolvedBlockerIssueId: blockerId },
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "issue_blockers_resolved",
        resolvedBlockerIssueId: blockerId,
      },
    });
    expect(promotedWake).not.toBeNull();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, promotedWake!.id))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const promotedBlockedRun = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, promotedWake!.id))
      .then((rows) => rows[0] ?? null);
    const blockedWakeRequestCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${blockedIssueId}`,
        ),
      )
      .then((rows) => rows[0]?.count ?? 0);

    expect(promotedBlockedRun?.status).toBe("succeeded");
    expect(blockedWakeRequestCount).toBeGreaterThanOrEqual(2);

    const noActiveRuns = await waitForCondition(async () => {
      const rows = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns);
      return rows.every((run) => run.status !== "queued" && run.status !== "running");
    }, 10_000);
    expect(noActiveRuns).toBe(true);
  });

  it("defers issue_blockers_resolved as a follow-up when the same issue is already running", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerId = randomUUID();
    const blockedIssueId = randomUUID();
    const activeRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: activeRunId,
      companyId,
      agentId,
      status: "running",
      invocationSource: "on_demand",
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "manual_test_active_run",
      },
    });
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Completed prerequisite",
        status: "done",
        priority: "medium",
      },
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
        executionRunId: activeRunId,
        executionLockedAt: new Date(),
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });
    runningProcesses.set(activeRunId, {
      child: {} as import("node:child_process").ChildProcess,
      graceSec: 1,
      processGroupId: null,
    });

    const idempotencyKey = `issue_blockers_resolved:${blockedIssueId}:${blockerId}`;
    const wake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerId,
      },
      idempotencyKey,
      contextSnapshot: {
        issueId: blockedIssueId,
        wakeReason: "issue_blockers_resolved",
        resolvedBlockerIssueId: blockerId,
      },
    });

    expect(wake).toBeNull();

    const wakeRequests = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
        runId: agentWakeupRequests.runId,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.idempotencyKey, idempotencyKey));

    expect(wakeRequests).toEqual([
      expect.objectContaining({
        status: "deferred_issue_execution",
        reason: "issue_execution_deferred",
        idempotencyKey,
        runId: null,
      }),
    ]);

    runningProcesses.delete(activeRunId);
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(heartbeatRuns.id, activeRunId));
  });

  it("honors maxConcurrentRuns 1 by leaving a second assignment wake queued", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const firstIssueId = randomUUID();
    const secondIssueId = randomUUID();
    let finishFirstRun!: () => void;
    const firstRunFinished = new Promise<void>((resolve) => {
      finishFirstRun = resolve;
    });

    mockAdapterExecute.mockImplementationOnce(async () => {
      await firstRunFinished;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        errorMessage: null,
        summary: "First assignment run completed.",
        provider: "test",
        model: "test-model",
      };
    });

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: firstIssueId,
        companyId,
        title: "First assignment",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      {
        id: secondIssueId,
        companyId,
        title: "Second assignment",
        status: "todo",
        priority: "high",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
    ]);

    try {
      const firstWake = await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: firstIssueId },
        contextSnapshot: { issueId: firstIssueId, wakeReason: "issue_assigned" },
      });
      expect(firstWake).not.toBeNull();
      await db.insert(issueComments).values({
        companyId,
        issueId: firstIssueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: firstWake!.id,
        body: "First assignment run completed.",
      });

      const firstRunStarted = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstWake!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "running";
      });
      expect(firstRunStarted).toBe(true);
      const firstAdapterStarted = await waitForCondition(async () => mockAdapterExecute.mock.calls.length === 1, 30_000);
      expect(firstAdapterStarted).toBe(true);

      const secondWake = await heartbeat.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: secondIssueId },
        contextSnapshot: { issueId: secondIssueId, wakeReason: "issue_assigned" },
      });
      expect(secondWake).not.toBeNull();
      await db.insert(issueComments).values({
        companyId,
        issueId: secondIssueId,
        authorAgentId: agentId,
        authorType: "agent",
        createdByRunId: secondWake!.id,
        body: "Second assignment run completed.",
      });

      const secondRunWhileFirstRunning = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, secondWake!.id))
        .then((rows) => rows[0] ?? null);
      expect(secondRunWhileFirstRunning?.status).toBe("queued");
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);

      finishFirstRun();

      const firstRunSucceeded = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, firstWake!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "succeeded";
      });
      expect(firstRunSucceeded).toBe(true);

      const secondRunSucceeded = await waitForCondition(async () => {
        const run = await db
          .select({ status: heartbeatRuns.status })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, secondWake!.id))
          .then((rows) => rows[0] ?? null);
        return run?.status === "succeeded";
      }, 10_000);
      expect(secondRunSucceeded).toBe(true);
      expect(mockAdapterExecute.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      finishFirstRun();
    }
  }, 40_000);

  it("cancels stale queued runs when issue blockers are still unresolved", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const blockerId = randomUUID();
    const blockedIssueId = randomUUID();
    const readyIssueId = randomUUID();
    const blockedWakeupRequestId = randomUUID();
    const readyWakeupRequestId = randomUUID();
    const blockedRunId = randomUUID();
    const readyRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "QAChecker",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 2,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: blockerId,
        companyId,
        title: "Security review",
        status: "blocked",
        priority: "high",
        responsibleUserId: "responsible-user",
      },
      {
        id: blockedIssueId,
        companyId,
        title: "QA validation",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      {
        id: readyIssueId,
        companyId,
        title: "Ready QA task",
        status: "todo",
        priority: "low",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });
    await db.insert(agentWakeupRequests).values([
      {
        id: blockedWakeupRequestId,
        companyId,
        agentId,
        source: "automation",
        triggerDetail: "system",
        reason: "transient_failure_retry",
        payload: { issueId: blockedIssueId },
        status: "queued",
      },
      {
        id: readyWakeupRequestId,
        companyId,
        agentId,
        source: "assignment",
        triggerDetail: "system",
        reason: "issue_assigned",
        payload: { issueId: readyIssueId },
        status: "queued",
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: blockedRunId,
        companyId,
        agentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: blockedWakeupRequestId,
        contextSnapshot: {
          issueId: blockedIssueId,
          wakeReason: "transient_failure_retry",
        },
      },
      {
        id: readyRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
        wakeupRequestId: readyWakeupRequestId,
        contextSnapshot: {
          issueId: readyIssueId,
          wakeReason: "issue_assigned",
        },
      },
    ]);
    await db
      .update(agentWakeupRequests)
      .set({ runId: blockedRunId })
      .where(eq(agentWakeupRequests.id, blockedWakeupRequestId));
    await db
      .update(agentWakeupRequests)
      .set({ runId: readyRunId })
      .where(eq(agentWakeupRequests.id, readyWakeupRequestId));
    await db.insert(issueComments).values({
      companyId,
      issueId: readyIssueId,
      authorAgentId: agentId,
      authorType: "agent",
      createdByRunId: readyRunId,
      body: "Ready queued run completed.",
    });
    await db
      .update(issues)
      .set({
        executionRunId: blockedRunId,
        executionAgentNameKey: "qa-checker",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, blockedIssueId));

    await heartbeat.resumeQueuedRuns();

    await waitForCondition(async () => {
      const run = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, readyRunId))
        .then((rows) => rows[0] ?? null);
      return run?.status === "succeeded";
    });

    const [blockedRun, blockedWakeup, blockedIssue, readyRun] = await Promise.all([
      db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          finishedAt: heartbeatRuns.finishedAt,
          resultJson: heartbeatRuns.resultJson,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, blockedRunId))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          status: agentWakeupRequests.status,
          error: agentWakeupRequests.error,
        })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, blockedWakeupRequestId))
        .then((rows) => rows[0] ?? null),
      db
        .select({
          executionRunId: issues.executionRunId,
          executionAgentNameKey: issues.executionAgentNameKey,
          executionLockedAt: issues.executionLockedAt,
        })
        .from(issues)
        .where(eq(issues.id, blockedIssueId))
        .then((rows) => rows[0] ?? null),
      db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, readyRunId))
        .then((rows) => rows[0] ?? null),
    ]);

    expect(blockedRun?.status).toBe("cancelled");
    expect(blockedRun?.errorCode).toBe("issue_dependencies_blocked");
    expect(blockedRun?.finishedAt).toBeTruthy();
    expect(blockedRun?.resultJson).toMatchObject({ stopReason: "issue_dependencies_blocked" });
    expect(blockedWakeup?.status).toBe("skipped");
    expect(blockedWakeup?.error).toContain("dependencies are still blocked");
    expect(blockedIssue).toMatchObject({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });
    expect(readyRun?.status).toBe("succeeded");
    expect(mockAdapterExecute.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("suppresses normal wakeups while allowing comment interaction wakes under a pause hold", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();
    const issueChain = Array.from({ length: 17 }, () => randomUUID());
    const deepDescendantIssueId = issueChain.at(-1)!;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SecurityEngineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: rootIssueId,
        companyId,
        title: "Paused root",
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      },
      ...issueChain.map((issueId, index) => ({
        id: issueId,
        companyId,
        parentId: index === 0 ? rootIssueId : issueChain[index - 1],
        title: `Paused desc ${index + 1}`,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
        responsibleUserId: "responsible-user",
      })),
    ]);
    const [hold] = await db
      .insert(issueTreeHolds)
      .values({
        companyId,
        rootIssueId,
        mode: "pause",
        status: "active",
        reason: "security test hold",
        releasePolicy: { strategy: "manual" },
      })
      .returning();

    const blockedWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: { issueId: deepDescendantIssueId },
      contextSnapshot: { issueId: deepDescendantIssueId, wakeReason: "issue_blockers_resolved" },
    });

    expect(blockedWake).toBeNull();
    const skippedWake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.payload} ->> 'issueId' = ${deepDescendantIssueId}`)
      .then((rows) => rows[0] ?? null);
    expect(skippedWake).toMatchObject({ status: "skipped", reason: "issue_tree_hold_active" });

    const childCommentId = randomUUID();
    await db.insert(issueComments).values({
      id: childCommentId,
      companyId,
      issueId: deepDescendantIssueId,
      authorUserId: "board-user",
      body: "Please respond while this hold is active.",
    });

    const forgedChildCommentWake = await heartbeat.wakeup(agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_commented",
      payload: { issueId: deepDescendantIssueId, commentId: childCommentId },
      requestedByActorType: "agent",
      requestedByActorId: agentId,
    });
    expect(forgedChildCommentWake).toBeNull();

    const childCommentWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: deepDescendantIssueId, commentId: childCommentId },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: {
        issueId: deepDescendantIssueId,
        commentId: childCommentId,
        wakeCommentId: childCommentId,
        wakeReason: "issue_commented",
        source: "issue.comment",
      },
    });

    expect(childCommentWake).not.toBeNull();
    const childRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, childCommentWake!.id))
      .then((rows) => rows[0] ?? null);
    expect(childRun?.contextSnapshot).toMatchObject({
      treeHoldInteraction: true,
      activeTreeHold: {
        holdId: hold.id,
        rootIssueId,
        mode: "pause",
        interaction: true,
      },
    });
  });

  it("allows comment interaction wakes when a legacy hold has a full_pause note", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const rootIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "SecurityEngineer",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    await db.insert(issues).values({
      id: rootIssueId,
      companyId,
      title: "Paused root",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
    });
    await db.insert(issueTreeHolds).values({
      companyId,
      rootIssueId,
      mode: "pause",
      status: "active",
      reason: "full pause",
      releasePolicy: { strategy: "manual", note: "full_pause" },
    });

    const rootCommentId = randomUUID();
    await db.insert(issueComments).values({
      id: rootCommentId,
      companyId,
      issueId: rootIssueId,
      authorUserId: "board-user",
      body: "Please respond while this hold is active.",
    });

    const rootCommentWake = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: rootIssueId, commentId: rootCommentId },
      requestedByActorType: "user",
      requestedByActorId: "board-user",
      contextSnapshot: {
        issueId: rootIssueId,
        commentId: rootCommentId,
        wakeCommentId: rootCommentId,
        wakeReason: "issue_commented",
        source: "issue.comment",
      },
    });

    expect(rootCommentWake).not.toBeNull();
    const rootRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, rootCommentWake!.id))
      .then((rows) => rows[0] ?? null);
    expect(rootRun?.contextSnapshot).toMatchObject({
      treeHoldInteraction: true,
      activeTreeHold: {
        rootIssueId,
        mode: "pause",
        interaction: true,
      },
    });
  });
});
