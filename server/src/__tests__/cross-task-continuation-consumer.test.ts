import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  companySkills,
  environmentLeases,
  environments,
  executionWorkspaces,
  workspaceOperations,
  costEvents,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issues,
  issueTreeHolds,
  issueRecoveryActions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { LEGACY_RECOVERY_CAUSE } from "../services/legacy-execution-recovery.js";
import { readCrossTaskContinuationWork, registerCrossTaskContinuationWork } from "../services/cross-task-continuation-worker.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { runningProcesses } from "../adapters/index.ts";
import {
  CROSS_TASK_CONTINUATION_COMMITTER_ID,
  CROSS_TASK_CONTINUATION_GATE_CHANGED,
  crossTaskContinuationDispatchKey,
  crossTaskContinuationIntentKey,
  DEFERRED_RECEIPT_READMISSION_DECLINED,
  listPromotableDeferredDispatchReceipts,
} from "../services/cross-task-continuation.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Cross-task continuation consumer test run.",
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
    `Skipping embedded Postgres cross-task continuation consumer tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("cross-task continuation intent consumer", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-cross-task-continuation-consumer-");
    db = createDb(tempDb.connectionString);
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
    await db.insert(authUsers).values({ id: "other-user", name: "Other owner", email: "other@example.test", createdAt: new Date(), updatedAt: new Date() });
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    runningProcesses.clear();
    mockAdapterExecute.mockClear();
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(environmentLeases);
    await db.delete(environments);
    await db.delete(workspaceOperations);
    await db.delete(executionWorkspaces);
    await db.delete(companySkills);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedTarget(overrides: { status?: string; responsibleUserId?: string } = {}) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const commentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Continuation",
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TargetOwner",
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
      title: "Archived parent",
      status: overrides.status ?? "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: overrides.responsibleUserId ?? "responsible-user",
    });
    const [intent] = await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_reopened_via_comment",
      status: "queued",
      requestedByActorType: "system",
      requestedByActorId: CROSS_TASK_CONTINUATION_COMMITTER_ID,
      idempotencyKey: crossTaskContinuationIntentKey(issueId, commentId),
      payload: {
        issueId,
        taskId: issueId,
        commentId,
        reopenedFrom: "done",
        mutation: "comment",
        resumeIntent: true,
        followUpRequested: true,
        _paperclipWakeContext: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_reopened_via_comment",
          wakeCommentId: commentId,
          source: "cross_task_continuation",
        },
        crossTaskContinuation: {
          requestedByAgentId: agentId,
          sourceRunId: randomUUID(),
          sourceIssueId: randomUUID(),
          workspaceId: null,
          workspaceGeneration: 0,
          expectedAssigneeAgentId: agentId,
          expectedResponsibleUserId: "responsible-user",
          requestDigest: "digest",
        },
      },
    }).returning();
    return { companyId, agentId, issueId, intent: intent! };
  }

  async function readIntent(id: string) {
    return db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, id)).then((rows) => rows[0]!);
  }

  async function dispatchReceipts(intentId: string) {
    return db.select().from(agentWakeupRequests).where(
      eq(agentWakeupRequests.idempotencyKey, crossTaskContinuationDispatchKey(intentId)),
    );
  }

  it("dispatches one target-bound run under the dispatch key and links the intent", async () => {
    const { companyId, agentId, issueId, intent } = await seedTarget();

    const first = await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect(first).toMatchObject({ dispatched: 1 });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    await heartbeat.drainActiveRunExecutions();

    const receipts = await dispatchReceipts(intent.id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      requestedByActorType: "system",
      requestedByActorId: crossTaskContinuationDispatchKey(intent.id),
    });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ agentId, wakeupRequestId: receipts[0]!.id });
    expect(runs[0]!.contextSnapshot).toMatchObject({
      issueId,
      taskId: issueId,
      source: "cross_task_continuation",
      crossTaskContinuationIntentId: intent.id,
    });
    expect(runs[0]!.contextSnapshot).not.toHaveProperty("nativeStatusWakeIntentId");
    expect(await readIntent(intent.id)).toMatchObject({ status: "coalesced", runId: runs[0]!.id });
  });

  it("recovers a committed dispatch receipt (K3) without a second run", async () => {
    const { companyId, intent } = await seedTarget();
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    await heartbeat.drainActiveRunExecutions();
    const [receipt] = await dispatchReceipts(intent.id);
    await db.update(agentWakeupRequests)
      .set({ status: "claimed", runId: null, claimedAt: new Date(Date.now() - 120_000), finishedAt: null })
      .where(eq(agentWakeupRequests.id, intent.id));

    const result = await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect(result).toMatchObject({ dispatched: 0, recovered: 1 });
    expect(await dispatchReceipts(intent.id)).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
    expect(await readIntent(intent.id)).toMatchObject({ status: "coalesced", runId: receipt!.runId });
  });

  it("recovers a skipped dispatch receipt (K8) and the dispatch index rejects a second receipt", async () => {
    const { companyId, agentId, issueId, intent } = await seedTarget();
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_reopened_via_comment",
      status: "skipped",
      error: "concurrent sweep skipped",
      requestedByActorType: "system",
      requestedByActorId: crossTaskContinuationDispatchKey(intent.id),
      idempotencyKey: crossTaskContinuationDispatchKey(intent.id),
      payload: { issueId },
    });
    await expect(db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_reopened_via_comment",
      requestedByActorType: "system",
      requestedByActorId: crossTaskContinuationDispatchKey(intent.id),
      idempotencyKey: crossTaskContinuationDispatchKey(intent.id),
      payload: { issueId },
    })).rejects.toThrow();

    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect(await dispatchReceipts(intent.id)).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    expect(await readIntent(intent.id)).toMatchObject({ status: "skipped", error: "concurrent sweep skipped" });
  });

  it.each([
    ["assignee changed", async (issueId: string, companyId: string) => {
      const otherAgentId = randomUUID();
      await db.insert(agents).values({
        id: otherAgentId, companyId, name: "Other", role: "engineer", status: "active",
        adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
      });
      await db.update(issues).set({ assigneeAgentId: otherAgentId }).where(eq(issues.id, issueId));
    }, "Native status wake target has a different assignee"],
    ["responsible user changed", async (issueId: string) => {
      await db.update(issues).set({ responsibleUserId: "other-user" }).where(eq(issues.id, issueId));
    }, CROSS_TASK_CONTINUATION_GATE_CHANGED],
    ["status in review", async (issueId: string) => {
      await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, issueId));
    }, CROSS_TASK_CONTINUATION_GATE_CHANGED],
    ["target done again", async (issueId: string) => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    }, "Native status wake target is already done"],
  ] as const)("skips delivery when the %s after commit", async (_label, mutate, expectedError) => {
    const { companyId, issueId, intent } = await seedTarget();
    await mutate(issueId, companyId);

    const result = await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect(result).toMatchObject({ dispatched: 0 });
    expect(await dispatchReceipts(intent.id)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    expect(await readIntent(intent.id)).toMatchObject({ status: "skipped", error: expectedError });
  });

  it("V1: a pause hold added between commit and dispatch starts no run and settles the intent by the existing pause rule", async () => {
    const { companyId, issueId, intent } = await seedTarget();
    await db.insert(issueTreeHolds).values({ companyId, rootIssueId: issueId, mode: "pause", status: "active", reason: "fixture pause" });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    await heartbeat.drainActiveRunExecutions();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    const receipts = await dispatchReceipts(intent.id);
    expect(receipts.length).toBeLessThanOrEqual(1);
    const settled = await readIntent(intent.id);
    expect(["skipped", "coalesced"]).toContain(settled.status);
    if (settled.status === "coalesced") expect(receipts[0]?.status).toBe("deferred_issue_execution");
    expect(settled.runId).toBeNull();
  });

  it("K6: two concurrent sweeps that read the same stale claim deliver exactly one receipt and one run", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { companyId, intent } = await seedTarget();
      await db.update(agentWakeupRequests)
        .set({ status: "claimed", claimedAt: new Date(Date.now() - 120_000) })
        .where(eq(agentWakeupRequests.id, intent.id));
      const sweeps = [heartbeatService(db), heartbeatService(db)];
      await Promise.all(sweeps.map((sweep) => sweep.dispatchPendingNativeStatusWakeups({ companyId })));
      await Promise.all(sweeps.map((sweep) => sweep.drainActiveRunExecutions()));
      const receipts = await dispatchReceipts(intent.id);
      expect(receipts).toHaveLength(1);
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      expect(runs).toHaveLength(1);
      expect(runs[0]!.wakeupRequestId).toBe(receipts[0]!.id);
      expect(await readIntent(intent.id)).toMatchObject({ status: "coalesced", runId: runs[0]!.id });
    }
  });

  it("K6 with a barrier: two sweeps reclaim the same stale claim while delivery is held; one receipt, one run, no orphan run", async () => {
    const { companyId, issueId, intent } = await seedTarget();
    await db.update(agentWakeupRequests)
      .set({ status: "claimed", claimedAt: new Date(Date.now() - 120_000) })
      .where(eq(agentWakeupRequests.id, intent.id));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const barrier = db.transaction(async (tx) => {
      await tx.execute(sql`select id from issues where id = ${issueId} for update`);
      locked();
      await held;
    });
    await lockTaken;
    const sweeps = [heartbeatService(db), heartbeatService(db)];
    const results = Promise.all(sweeps.map((sweep) => sweep.dispatchPendingNativeStatusWakeups({ companyId })));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    release();
    await barrier;
    await results;
    await Promise.all(sweeps.map((sweep) => sweep.drainActiveRunExecutions()));
    const receipts = await dispatchReceipts(intent.id);
    expect(receipts).toHaveLength(1);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.wakeupRequestId).toBe(receipts[0]!.id);
    expect(await readIntent(intent.id)).toMatchObject({ status: "coalesced", runId: runs[0]!.id });
  });

  it("K6 without the claim fence: two concurrent deliveries under the same dispatch key commit one receipt and one run", async () => {
    const { companyId, agentId, issueId, intent } = await seedTarget();
    const dispatchKey = crossTaskContinuationDispatchKey(intent.id);
    const deliver = () => heartbeatService(db).wakeup(agentId, {
      allowRunCoalescing: false,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_reopened_via_comment",
      payload: { issueId, taskId: issueId },
      idempotencyKey: dispatchKey,
      requestedByActorType: "system",
      requestedByActorId: dispatchKey,
      contextSnapshot: { issueId, taskId: issueId, source: "cross_task_continuation", crossTaskContinuationIntentId: intent.id },
    }).then((run) => ({ run, error: null as unknown }), (error: unknown) => ({ run: null, error }));
    await Promise.all([deliver(), deliver()]);
    await heartbeat.drainActiveRunExecutions();
    expect(await dispatchReceipts(intent.id)).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
  });

  it("K8 (b): a recovery hold defers delivery; while it holds nothing runs, and once resolved a sweep promotes the same receipt to the intent's only run", async () => {
    const { companyId, agentId, issueId, intent } = await seedTarget();
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      ownerType: "board", returnOwnerAgentId: agentId, cause: LEGACY_RECOVERY_CAUSE, fingerprint: `k8:${issueId}`,
      evidence: {}, nextAction: "Reconcile stopped work" }).returning();
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    const [receipt, ...extra] = await dispatchReceipts(intent.id);
    expect(extra).toHaveLength(0);
    expect(receipt).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(await readIntent(intent.id)).toMatchObject({ status: "coalesced" });

    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect(await dispatchReceipts(intent.id)).toMatchObject([{ id: receipt!.id, status: "deferred_issue_execution", runId: null }]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    expect((await readCrossTaskContinuationWork(db)).pending).toBe(false);

    await db.update(issueRecoveryActions).set({ status: "resolved", outcome: "restored", resolvedAt: new Date() })
      .where(eq(issueRecoveryActions.id, action!.id));
    expect((await readCrossTaskContinuationWork(db)).pending).toBe(true);
    const result = await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect(result).toMatchObject({ promoted: 1 });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    await heartbeat.drainActiveRunExecutions();

    const receipts = await dispatchReceipts(intent.id);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.id).toBe(receipt!.id);
    expect(receipts[0]!.status).not.toBe("deferred_issue_execution");
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.wakeupRequestId).toBe(receipt!.id);
    expect(await readIntent(intent.id)).toMatchObject({ runId: runs[0]!.id });
    const { reopenTargetBoundSuccessorWorkspace } = await import("../services/heartbeat/target-bound-successor-reopen.js");
    const run = runs[0]!;
    await expect(reopenTargetBoundSuccessorWorkspace(db, {
      run: { id: run.id, companyId: run.companyId, agentId: run.agentId, wakeupRequestId: run.wakeupRequestId,
        issueId: run.issueId, nativeIssueId: run.nativeIssueId, contextSnapshot: run.contextSnapshot as Record<string, unknown> },
      responsibleUserId: "responsible-user", externalProvider: false, hasPersistedNativeExecutionInput: false,
      freshIsolatedWorkspaceRequested: false,
      executionWorkspacesSvc: { reopenClosedIsolatedExecutionWorkspaceForIssue: vi.fn(), clearReopenPendingConsumptionForUnconsumedReopen: vi.fn() } as never,
    })).rejects.toThrow(/workspace binding changed/);
  });

  async function deferUnderRecoveryHold() {
    const seeded = await seedTarget();
    await db.insert(issueRecoveryActions).values({ companyId: seeded.companyId, sourceIssueId: seeded.issueId, kind: "active_run_watchdog",
      ownerType: "board", returnOwnerAgentId: seeded.agentId, cause: LEGACY_RECOVERY_CAUSE, fingerprint: `k8:${seeded.issueId}:${randomUUID()}`,
      evidence: {}, nextAction: "Reconcile stopped work" });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: seeded.companyId });
    const [receipt] = await dispatchReceipts(seeded.intent.id);
    expect(receipt).toMatchObject({ status: "deferred_issue_execution", runId: null });
    const resolve = () => issueRecoveryActionService(db).resolveActiveForIssue({
      companyId: seeded.companyId, sourceIssueId: seeded.issueId, status: "resolved", outcome: "restored",
    } as never);
    const runsFor = () => db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, receipt!.id));
    return { ...seeded, receipt: receipt!, resolve, runsFor };
  }

  it("K8 (b) notification path: the real resolution notifies the worker, which promotes the same receipt without a manual sweep", async () => {
    const f = await deferUnderRecoveryHold();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: () => {} });
    try {
      const worker = registerCrossTaskContinuationWork(db, coordinator, () => heartbeatService(db).dispatchPendingNativeStatusWakeups());
      await worker.ready;
      expect(await f.runsFor()).toHaveLength(0);
      expect(coordinator.nextWakeAt()).toBeNull();
      await f.resolve();
      await vi.waitFor(async () => expect(await f.runsFor()).toHaveLength(1), { timeout: 10_000 });
      expect(await dispatchReceipts(f.intent.id)).toHaveLength(1);
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull(), { timeout: 10_000 });
    } finally {
      await coordinator.stop();
    }
    await heartbeat.drainActiveRunExecutions();
  });

  it("K8 (b) a blocker that reappears before re-admission keeps the receipt deferred with no run", async () => {
    const f = await deferUnderRecoveryHold();
    await f.resolve();
    await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
      ownerType: "board", returnOwnerAgentId: f.agentId, cause: LEGACY_RECOVERY_CAUSE, fingerprint: `k8-again:${f.issueId}`,
      evidence: {}, nextAction: "Reconcile stopped work" });
    expect(await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId })).toMatchObject({ promoted: 0 });
    expect(await dispatchReceipts(f.intent.id)).toMatchObject([{ id: f.receipt.id, status: "deferred_issue_execution", runId: null }]);
    expect(await f.runsFor()).toHaveLength(0);
  });

  it("K8 (b) concurrent releases promote the receipt once", async () => {
    const f = await deferUnderRecoveryHold();
    await f.resolve();
    const sweeps = [heartbeatService(db), heartbeatService(db), heartbeatService(db)];
    await Promise.all(sweeps.map((sweep) => sweep.dispatchPendingNativeStatusWakeups({ companyId: f.companyId })));
    await Promise.all(sweeps.map((sweep) => sweep.drainActiveRunExecutions()));
    expect(await dispatchReceipts(f.intent.id)).toHaveLength(1);
    expect(await f.runsFor()).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
  });

  it("K8 (b) a receipt whose intent no longer names the same target is not re-admitted and nothing changes", async () => {
    const f = await deferUnderRecoveryHold();
    await db.update(agentWakeupRequests).set({ payload: sql`jsonb_set(${agentWakeupRequests.payload}, '{issueId}', to_jsonb(${randomUUID()}::text))` })
      .where(eq(agentWakeupRequests.id, f.intent.id));
    await f.resolve();
    const before = await dispatchReceipts(f.intent.id);
    expect(await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId })).toMatchObject({ promoted: 0 });
    expect(await dispatchReceipts(f.intent.id)).toEqual(before);
    expect(await f.runsFor()).toHaveLength(0);
  });

  it("status committer, same path: a receipt deferred by a recovery hold is promoted as the same row to one run once the hold is resolved", async () => {
    const { companyId, agentId, issueId } = await seedTarget();
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      ownerType: "board", returnOwnerAgentId: agentId, cause: LEGACY_RECOVERY_CAUSE, fingerprint: `sc:${issueId}`,
      evidence: {}, nextAction: "Reconcile stopped work" });
    const [statusIntent] = await db.insert(agentWakeupRequests).values({
      companyId, agentId, source: "automation", triggerDetail: "system", reason: "issue_blockers_resolved",
      requestedByActorType: "system", requestedByActorId: "native-status-committer",
      idempotencyKey: `native-dependency:${issueId}`,
      payload: { issueId, taskId: issueId, _paperclipWakeContext: { issueId, taskId: issueId } },
    }).returning();
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    const statusReceipts = () => db.select().from(agentWakeupRequests).where(
      eq(agentWakeupRequests.requestedByActorId, `native-status-wake-dispatch:${statusIntent!.id}`));
    const [deferred, ...extra] = await statusReceipts();
    expect(extra).toHaveLength(0);
    expect(deferred).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(await heartbeat.dispatchPendingNativeStatusWakeups({ companyId })).toMatchObject({ promoted: 0 });

    await issueRecoveryActionService(db).resolveActiveForIssue({ companyId, sourceIssueId: issueId, status: "resolved", outcome: "restored" } as never);
    expect(await heartbeat.dispatchPendingNativeStatusWakeups({ companyId })).toMatchObject({ promoted: 1 });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    await heartbeat.drainActiveRunExecutions();
    const receipts = await statusReceipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.id).toBe(deferred!.id);
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, deferred!.id));
    expect(runs).toHaveLength(1);
    expect(await readIntent(statusIntent!.id)).toMatchObject({ runId: runs[0]!.id });
  });

  it("a long-held receipt ahead in the batch does not starve a ready one behind it", async () => {
    const held = await deferUnderRecoveryHold();
    const ready = await deferUnderRecoveryHold();
    await ready.resolve();
    expect(await heartbeat.dispatchPendingNativeStatusWakeups({ limit: 1 })).toMatchObject({ promoted: 1 });
    expect(await ready.runsFor()).toHaveLength(1);
    expect(await held.runsFor()).toHaveLength(0);
    expect(await dispatchReceipts(held.intent.id)).toMatchObject([{ status: "deferred_issue_execution", runId: null }]);
  });

  it("the worker counts an unblocked native status receipt as pending, and is quiet again once it is promoted", async () => {
    const { companyId, agentId, issueId } = await seedTarget();
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "active_run_watchdog",
      ownerType: "board", returnOwnerAgentId: agentId, cause: LEGACY_RECOVERY_CAUSE, fingerprint: `sc-worker:${issueId}`,
      evidence: {}, nextAction: "Reconcile stopped work" });
    await db.insert(agentWakeupRequests).values({
      companyId, agentId, source: "automation", triggerDetail: "system", reason: "issue_blockers_resolved",
      requestedByActorType: "system", requestedByActorId: "native-status-committer",
      idempotencyKey: `native-dependency:${issueId}`,
      payload: { issueId, taskId: issueId, _paperclipWakeContext: { issueId, taskId: issueId } },
    });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect((await readCrossTaskContinuationWork(db)).pending).toBe(false);
    await issueRecoveryActionService(db).resolveActiveForIssue({ companyId, sourceIssueId: issueId, status: "resolved", outcome: "restored" } as never);
    expect((await readCrossTaskContinuationWork(db)).pending).toBe(true);
    expect(await heartbeat.dispatchPendingNativeStatusWakeups({ companyId })).toMatchObject({ promoted: 1 });
    expect((await readCrossTaskContinuationWork(db)).pending).toBe(false);
    await heartbeat.drainActiveRunExecutions();
  });

  it("never dispatches a coalesced intent", async () => {
    const { companyId, intent } = await seedTarget();
    await db.update(agentWakeupRequests).set({ status: "coalesced" }).where(eq(agentWakeupRequests.id, intent.id));

    const result = await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    expect(result).toMatchObject({ dispatched: 0 });
    expect(await dispatchReceipts(intent.id)).toHaveLength(0);
  });

  it("keeps the native status committer on its own dispatch identity", async () => {
    const { companyId, agentId, issueId } = await seedTarget();
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    const [statusIntent] = await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      requestedByActorType: "system",
      requestedByActorId: "native-status-committer",
      idempotencyKey: `native-dependency:${issueId}`,
      payload: { issueId, taskId: issueId, _paperclipWakeContext: { issueId, taskId: issueId } },
    }).returning();

    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId });
    await heartbeat.drainActiveRunExecutions();
    const receipts = await db.select().from(agentWakeupRequests).where(
      sql`${agentWakeupRequests.requestedByActorId} = ${`native-status-wake-dispatch:${statusIntent!.id}`}`,
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.idempotencyKey).toBe(`native-dependency:${issueId}`);
  });

  async function startNewConversation(f: { companyId: string; agentId: string; issueId: string }) {
    const [boundary] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      authorUserId: "responsible-user", body: "/new", createdAt: new Date(Date.now() + 1000) }).returning();
    await db.update(issues).set({ conversationState: "active", conversationAgentId: f.agentId,
      conversationUserId: "responsible-user", conversationBoundaryCommentId: boundary!.id }).where(eq(issues.id, f.issueId));
  }

  it("a recovery action from before a newer /new boundary no longer holds a deferred continuation receipt, which is promoted to its one run", async () => {
    const f = await deferUnderRecoveryHold();
    expect((await readCrossTaskContinuationWork(db)).pending).toBe(false);
    await instanceSettingsService(db).updateExperimental({ enableAgentChat: true });
    try {
      await startNewConversation(f);
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
      expect((await listPromotableDeferredDispatchReceipts(db, { companyId: f.companyId, limit: 100 })).promotable)
        .toMatchObject([{ id: f.receipt.id }]);
      expect((await readCrossTaskContinuationWork(db)).pending).toBe(true);
      expect(await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId })).toMatchObject({ promoted: 1 });
      const runs = await f.runsFor();
      expect(runs).toHaveLength(1);
      expect(await dispatchReceipts(f.intent.id)).toMatchObject([{ id: f.receipt.id, runId: runs[0]!.id }]);
      expect(await readIntent(f.intent.id)).toMatchObject({ runId: runs[0]!.id });
      expect((await readCrossTaskContinuationWork(db)).pending).toBe(false);
      await heartbeat.drainActiveRunExecutions();
    } finally {
      await instanceSettingsService(db).updateExperimental({ enableAgentChat: false });
    }
  });

  it("a native status receipt released by a newer /new boundary is attempted, kept deferred by the conversation wake rule, and leaves the worker quiet", async () => {
    const f = await deferUnderRecoveryHold();
    await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      triggerDetail: "system", reason: "issue_blockers_resolved", requestedByActorType: "system",
      requestedByActorId: "native-status-committer", idempotencyKey: `native-dependency:${f.issueId}`,
      payload: { issueId: f.issueId, taskId: f.issueId, _paperclipWakeContext: { issueId: f.issueId, taskId: f.issueId } } });
    await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId });
    const receipts = await db.select().from(agentWakeupRequests)
      .where(sql`${agentWakeupRequests.requestedByActorId} like 'native-status-wake-dispatch:%'`);
    expect(receipts).toMatchObject([{ status: "deferred_issue_execution", runId: null }]);
    expect((await readCrossTaskContinuationWork(db)).pending).toBe(false);
    await startNewConversation(f);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    expect((await listPromotableDeferredDispatchReceipts(db, { companyId: f.companyId, limit: 100 })).promotable)
      .toMatchObject([{ id: receipts[0]!.id }]);
    expect((await readCrossTaskContinuationWork(db)).pending).toBe(true);
    for (let pass = 0; pass < 2; pass += 1) {
      expect(await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId })).toMatchObject({ promoted: 0 });
    }
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipts[0]!.id)))
      .toMatchObject([{ status: "deferred_issue_execution", runId: null, error: DEFERRED_RECEIPT_READMISSION_DECLINED }]);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.wakeupRequestId, receipts[0]!.id))).toHaveLength(0);
    expect((await readCrossTaskContinuationWork(db)).pending).toBe(false);
  });

  it("a receipt marked declined by an earlier attempt is not counted as pending, and the real resolution notification still promotes it", async () => {
    const f = await deferUnderRecoveryHold();
    await db.update(agentWakeupRequests).set({ error: DEFERRED_RECEIPT_READMISSION_DECLINED }).where(eq(agentWakeupRequests.id, f.receipt.id));
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: () => {} });
    try {
      const worker = registerCrossTaskContinuationWork(db, coordinator, () => heartbeatService(db).dispatchPendingNativeStatusWakeups());
      await worker.ready;
      await f.resolve();
      expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
      await vi.waitFor(async () => expect(await f.runsFor()).toHaveLength(1), { timeout: 10_000 });
      expect(await dispatchReceipts(f.intent.id)).toMatchObject([{ id: f.receipt.id, error: null }]);
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull(), { timeout: 10_000 });
    } finally {
      await coordinator.stop();
    }
    await heartbeat.drainActiveRunExecutions();
  });

  it("an untrusted deferred receipt is neither a candidate nor pending work, and a sweep leaves it untouched", async () => {
    const f = await deferUnderRecoveryHold();
    await f.resolve();
    await db.update(agentWakeupRequests).set({ payload: { issueId: randomUUID() } }).where(eq(agentWakeupRequests.id, f.intent.id));
    const [before] = await dispatchReceipts(f.intent.id);
    expect((await listPromotableDeferredDispatchReceipts(db, { limit: 100 })).promotable).toHaveLength(0);
    expect((await readCrossTaskContinuationWork(db)).pending).toBe(false);
    expect(await heartbeat.dispatchPendingNativeStatusWakeups({})).toMatchObject({ promoted: 0 });
    expect(await dispatchReceipts(f.intent.id)).toEqual([before]);
    expect(await f.runsFor()).toHaveLength(0);
  });

  it("a workspace restore hold survives a newer /new boundary and keeps the receipt deferred with no run", async () => {
    const f = await deferUnderRecoveryHold();
    await db.update(issueRecoveryActions).set({ evidence: { workspaceRestoreFailure: "restore_unsafe_archive" } })
      .where(eq(issueRecoveryActions.sourceIssueId, f.issueId));
    await startNewConversation(f);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).not.toBeNull();
    expect((await listPromotableDeferredDispatchReceipts(db, { companyId: f.companyId, limit: 100 })).promotable).toHaveLength(0);
    expect((await readCrossTaskContinuationWork(db)).pending).toBe(false);
    expect(await heartbeat.dispatchPendingNativeStatusWakeups({ companyId: f.companyId })).toMatchObject({ promoted: 0 });
    expect(await dispatchReceipts(f.intent.id)).toMatchObject([{ id: f.receipt.id, status: "deferred_issue_execution", runId: null }]);
    expect(await f.runsFor()).toHaveLength(0);
  });

  it("ready work behind more than one worker page and one promotion pass of ownership-held receipts is found and promoted once", async () => {
    const f = await seedTarget();
    await db.update(agentWakeupRequests).set({ status: "coalesced" }).where(eq(agentWakeupRequests.id, f.intent.id));
    const oldest = new Date(Date.now() - 60_000);
    const heldIssues = Array.from({ length: 520 }, () => ({ id: randomUUID(), companyId: f.companyId,
      title: "Ownership-held", status: "todo" as const, assigneeAgentId: f.agentId, responsibleUserId: "responsible-user" }));
    await db.insert(issues).values(heldIssues);
    const heldIntents = heldIssues.map(row => ({ id: randomUUID(), companyId: f.companyId, agentId: f.agentId,
      source: "automation" as const, triggerDetail: "system" as const, status: "coalesced", requestedByActorType: "system" as const,
      requestedByActorId: CROSS_TASK_CONTINUATION_COMMITTER_ID,
      idempotencyKey: crossTaskContinuationIntentKey(row.id, randomUUID()), payload: { issueId: row.id } }));
    await db.insert(agentWakeupRequests).values(heldIntents);
    await db.insert(agentWakeupRequests).values(heldIntents.map(intent => ({ companyId: f.companyId, agentId: f.agentId,
      source: "automation" as const, triggerDetail: "system" as const, status: "deferred_issue_execution", requestedAt: oldest,
      requestedByActorType: "system" as const, requestedByActorId: crossTaskContinuationDispatchKey(intent.id),
      idempotencyKey: crossTaskContinuationDispatchKey(intent.id), payload: { issueId: intent.payload.issueId } })));
    await db.insert(heartbeatRuns).values(heldIssues.map(row => ({ companyId: f.companyId, agentId: f.agentId,
      invocationSource: "assignment" as const, triggerDetail: "system" as const, status: "failed", runtimeMode: "legacy",
      processPid: process.pid, contextSnapshot: { issueId: row.id },
      runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } } })));
    expect(await getExecutionBlocker(db, f.companyId, heldIssues[0]!.id)).toMatchObject({ cause: "execution_owner_active" });
    expect((await readCrossTaskContinuationWork(db)).pending).toBe(false);
    const ready = await deferUnderRecoveryHold();
    await ready.resolve();
    expect(await getExecutionBlocker(db, ready.companyId, ready.issueId)).toBeNull();
    expect((await readCrossTaskContinuationWork(db)).pending).toBe(true);
    let promoted = 0;
    for (let pass = 0; pass < 3 && (await ready.runsFor()).length === 0; pass += 1) {
      promoted += (await heartbeat.dispatchPendingNativeStatusWakeups({ limit: 1 })).promoted;
    }
    expect(promoted).toBe(1);
    expect(await ready.runsFor()).toHaveLength(1);
    expect(await dispatchReceipts(ready.intent.id)).toHaveLength(1);
    const heldReceipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.requestedAt, oldest));
    expect(heldReceipts).toHaveLength(520);
    expect(heldReceipts.every(row => row.status === "deferred_issue_execution" && row.runId === null)).toBe(true);
    expect((await readCrossTaskContinuationWork(db)).pending).toBe(false);
    expect((await heartbeat.dispatchPendingNativeStatusWakeups({ limit: 1 })).promoted).toBe(0);
    await heartbeat.drainActiveRunExecutions();
  }, 120_000);
});
