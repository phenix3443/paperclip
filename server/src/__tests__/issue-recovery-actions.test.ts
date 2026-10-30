import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { issueApprovalService } from "../services/issue-approvals.js";
import { approvalService } from "../services/approvals.js";
import { issueExecutionGeneration, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import {
  costEvents,
  agents,
  agentRuntimeState,
  approvals,
  budgetPolicies,
  authUsers,
  agentWakeupRequests,
  activityLog,
  caseHandoffs,
  cases,
  chatConversations,
  chatEndpoints,
  companies,
  createDb,
  executionReconciliationReceipts,
  documentRevisions,
  issueDocumentDecisions,
  issueDocuments,
  documents,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueExecutionDecisions,
  issueInboxArchives,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issueTreeHolds,
  nativeRunFinalizations,
  projects,
  toolApplications,
  toolConnections,
  workspaceOperations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { buildPaperclipWakePayload, heartbeatService } from "../services/heartbeat.js";
import { deliverReconciledExecutions } from "../services/execution-recovery-resolution.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { workspaceOperationService, isNativeWorkspaceFinalizationOperationActive } from "../services/workspace-operations.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import { recoveryService } from "../services/recovery/service.js";
import { issueService } from "../services/issues.js";
import { caseHandoffService } from "../services/case-handoffs.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { withNativeWorkspaceFinalizationOwnership } from "../services/native-runtime/native-workspace-finalization-ownership.js";
import { noticeMetadataReferencesRecoveryAction } from "../services/recovery/successful-run-handoff.js";
import { buildExpectedReconciliationState, listUnstartedHoldRunIds } from "../services/execution-reconciliation-receipts.js";
import { lockExecutionReconciliationAuthority } from "../services/execution-reconciliation-authority-lock.js";
import {
  canonicalReconciliationDigest,
  canonicalizeReconciliationJson,
  sha256HexOfText,
} from "@paperclipai/shared/execution-reconciliation-canonical";
import { executionReconciliationRequestIntent } from "@paperclipai/shared";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

function makeRecoveryActionRow(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-05-09T19:30:00.000Z");
  return {
    id: randomUUID(),
    companyId: "company-1",
    sourceIssueId: "source-1",
    recoveryIssueId: null,
    kind: "missing_disposition",
    status: "active",
    ownerType: "agent",
    ownerAgentId: "agent-1",
    ownerUserId: null,
    previousOwnerAgentId: null,
    returnOwnerAgentId: null,
    cause: "successful_run_missing_issue_disposition",
    fingerprint: "missing-disposition:fingerprint",
    evidence: {},
    nextAction: "Choose a valid issue disposition.",
    wakePolicy: null,
    monitorPolicy: null,
    attemptCount: 1,
    maxAttempts: null,
    timeoutAt: null,
    lastAttemptAt: now,
    outcome: null,
    resolutionNote: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("issueRecoveryActionService", () => {
  it("does not reactivate an action resolved between the active read and update", async () => {
    const existingRow = makeRecoveryActionRow({ id: "existing-action", attemptCount: 1 });
    const createdRow = makeRecoveryActionRow({ id: "new-action", attemptCount: 1 });
    const selectResults = [[existingRow], []];

    const makeSelectQuery = (rows: unknown[]) => ({
      from() {
        return this;
      },
      where() {
        return this;
      },
      orderBy() {
        return this;
      },
      limit() {
        return Promise.resolve(rows);
      },
    });

    const fakeDb = {
      async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> { return fn(fakeDb); },
      select: vi.fn(() => makeSelectQuery(selectResults.shift() ?? [])),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => []),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => [createdRow]),
        })),
      })),
    };

    const result = await issueRecoveryActionService(fakeDb as never).upsertSourceScoped({
      companyId: "company-1",
      sourceIssueId: "source-1",
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: "agent-1",
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      nextAction: "Choose a valid issue disposition.",
    });

    expect(result).toMatchObject({ id: "new-action", status: "active" });
    expect(fakeDb.update).toHaveBeenCalledTimes(1);
    expect(fakeDb.insert).toHaveBeenCalledTimes(1);
  });
});

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue recovery action tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue recovery actions", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let operationLogRoot: string;
  const priorOperationLogRoot = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;

  beforeAll(async () => {
    operationLogRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-recovery-operation-logs-"));
    process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = operationLogRoot;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-recovery-actions-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    // A delivered wake starts its run in the background. Let it finish its
    // writes (for example agent_runtime_state) before the tables are cleared.
    await heartbeatService(db).drainActiveRunExecutions();
    await db.delete(executionReconciliationReceipts);
    await db.delete(issueDocumentDecisions);
    await db.delete(caseHandoffs);
    await db.delete(cases);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(workspaceOperations);
    await db.delete(issueThreadInteractions);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(environmentLeases);
    await db.delete(activityLog);
    await db.delete(costEvents);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(environments);
    await db.delete(issueInboxArchives);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
    if (priorOperationLogRoot === undefined) delete process.env.WORKSPACE_OPERATION_LOG_BASE_PATH;
    else process.env.WORKSPACE_OPERATION_LOG_BASE_PATH = priorOperationLogRoot;
    await fs.rm(operationLogRoot, { recursive: true, force: true });
  });

  async function seedCompany() {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const sourceIssueId = randomUUID();
    const prefix = `RA${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Recovery Co",
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Implement backend recovery",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: coderId,
      issueNumber: 1,
      identifier: `${prefix}-1`,
    });
    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    return { companyId, managerId, coderId, sourceIssueId, prefix, sourceIssue: sourceIssue! };
  }

  async function seedHeartbeatRun(input: {
    companyId: string;
    agentId: string;
    runId: string;
    issueId?: string;
    status?: string;
  }) {
    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "manual",
      status: input.status ?? "running",
      startedAt: new Date("2026-05-13T18:00:00.000Z"),
      contextSnapshot: input.issueId ? { issueId: input.issueId } : undefined,
    });
  }

  function createApp(
    actor: any = { type: "board", source: "local_implicit" },
    opts: Parameters<typeof issueRoutes>[2] = {},
  ) {
    const app = express();
    app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any, opts));
    app.use(errorHandler);
    return app;
  }

  async function seedNativeFinalizationRecovery(status: string) {
    const fixture = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: fixture.companyId,
      agentId: fixture.coderId,
      status,
      runtimeMode: "native",
      nativeIssueId: fixture.sourceIssueId,
      nativePhase: "finalizing",
      // Native coordinator retries resume this original run, without creating
      // the legacy scheduled_retry_reason projection.
      scheduledRetryReason: null,
      contextSnapshot: { issueId: fixture.sourceIssueId },
    });
    const svc = issueRecoveryActionService(db);
    await svc.upsertSourceScoped({
      companyId: fixture.companyId,
      sourceIssueId: fixture.sourceIssueId,
      kind: "active_run_watchdog",
      ownerType: "agent",
      ownerAgentId: fixture.coderId,
      cause: "native_finalization_invalid",
      fingerprint: `native:${runId}`,
      nextAction: "Finish the existing run.",
      wakePolicy: { kind: "resume_native_run", runId, notBefore: "2020-01-01T00:00:00Z" },
      maxAttempts: 3,
    });
    return { ...fixture, runId, svc };
  }

  it.each(["queued", "running"])("projects the exact %s native run without a legacy scheduled retry", async (status) => {
    const { companyId, sourceIssueId, runId, svc } = await seedNativeFinalizationRecovery(status);
    const expected = { runId, status, workspaceOperationId: null };
    expect((await svc.getActiveForIssue(companyId, sourceIssueId))?.nativeRunActivity).toEqual(expected);
    expect((await svc.listActiveForIssues(companyId, [sourceIssueId])).get(sourceIssueId)?.nativeRunActivity).toEqual(expected);
    const response = await request(createApp()).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(response.body.scheduledRetry).toBeNull();
    expect(response.body.activeRecoveryAction.nativeRunActivity).toEqual(expected);
  });

  it("projects an actual long-running export while its original heartbeat remains failed, then clears it", async () => {
    const { companyId, sourceIssueId, runId, svc } = await seedNativeFinalizationRecovery("failed");
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const work = workspaceOperationService(db).createRecorder({ companyId, issueId: sourceIssueId, heartbeatRunId: runId }).recordOperation({
      phase: "workspace_finalize", metadata: { owningService: "native_workspace_finalizer" },
      run: async () => { started(); await held; return { status: "succeeded" }; },
    });
    await entered;
    let operationId: string;
    try {
      const [operation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.heartbeatRunId, runId));
      operationId = operation!.id;
      // A slow callback remains live independently of elapsed wall-clock time.
      await db.update(workspaceOperations).set({ startedAt: new Date("2000-01-01T00:00:00Z") }).where(eq(workspaceOperations.id, operationId));
      const scope = { companyId, issueId: sourceIssueId, runId, operationId };
      expect(isNativeWorkspaceFinalizationOperationActive(scope)).toBe(true);
      expect(isNativeWorkspaceFinalizationOperationActive({ ...scope, companyId: randomUUID() })).toBe(false);
      expect((await svc.getActiveForIssue(companyId, sourceIssueId))?.nativeRunActivity).toEqual({
        runId, status: "running", workspaceOperationId: operationId,
      });
    } finally { release(); await work; }
    expect((await svc.getActiveForIssue(companyId, sourceIssueId))?.nativeRunActivity).toBeNull();
    // Even a stranded DB row cannot turn a joined callback back into activity.
    await db.update(workspaceOperations).set({ status: "running", finishedAt: null }).where(eq(workspaceOperations.id, operationId!));
    expect((await svc.getActiveForIssue(companyId, sourceIssueId))?.nativeRunActivity).toBeNull();
  });

  it("keeps the activity claim until a timed-out export callback actually joins", async () => {
    const { companyId, sourceIssueId, runId } = await seedNativeFinalizationRecovery("failed");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const work = workspaceOperationService(db).createRecorder({ companyId, issueId: sourceIssueId, heartbeatRunId: runId }).recordOperation({
      phase: "workspace_finalize", metadata: { owningService: "native_workspace_finalizer" }, timeoutMs: 10,
      run: async () => { await held; return { status: "succeeded" }; },
    });
    try {
      await expect(work).rejects.toThrow("exceeded");
      const [operation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.heartbeatRunId, runId));
      const scope = { companyId, issueId: sourceIssueId, runId, operationId: operation!.id };
      expect(isNativeWorkspaceFinalizationOperationActive(scope)).toBe(true);
      release();
      await held;
      await new Promise((resolve) => setImmediate(resolve));
      expect(isNativeWorkspaceFinalizationOperationActive(scope)).toBe(false);
    } finally { release(); }
  });

  it("does not treat an orphaned running export record as live after controller loss", async () => {
    const { companyId, sourceIssueId, runId, svc } = await seedNativeFinalizationRecovery("failed");
    await db.insert(workspaceOperations).values({
      companyId, issueId: sourceIssueId, heartbeatRunId: runId,
      phase: "workspace_finalize", status: "running",
      metadata: { owningService: "native_workspace_finalizer" },
    });
    expect((await svc.getActiveForIssue(companyId, sourceIssueId))?.nativeRunActivity).toBeNull();
  });

  it.each(["company", "issue", "legacy", "finished"])("rejects an apparently live run with the wrong %s authority", async (mismatch) => {
    const { companyId, sourceIssueId, runId, svc } = await seedNativeFinalizationRecovery("running");
    const other = await seedCompany();
    // Exercise service rejection of historical corruption behind the immutable binding trigger.
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.update(heartbeatRuns).set({
      ...(mismatch === "company" ? { companyId: other.companyId, agentId: other.coderId } : {}),
      ...(mismatch === "issue" ? { nativeIssueId: other.sourceIssueId } : {}),
      ...(mismatch === "legacy" ? { runtimeMode: "legacy" } : {}),
      ...(mismatch === "finished" ? { finishedAt: new Date() } : {}),
    }).where(eq(heartbeatRuns.id, runId));
    });
    expect((await svc.getActiveForIssue(companyId, sourceIssueId))?.nativeRunActivity).toBeNull();
  });

  it.each(["company", "issue", "run", "phase", "owner", "finished"])(
    "does not borrow native finalization activity with a different %s binding", async (mismatch) => {
      const { companyId, sourceIssueId, runId, svc } = await seedNativeFinalizationRecovery("failed");
      const other = await seedNativeFinalizationRecovery("running");
      await db.insert(workspaceOperations).values({
        companyId: mismatch === "company" ? other.companyId : companyId,
        issueId: mismatch === "issue" ? other.sourceIssueId : sourceIssueId,
        heartbeatRunId: mismatch === "run" ? other.runId : runId,
        phase: mismatch === "phase" ? "workspace_prepare" : "workspace_finalize",
        status: "running", finishedAt: mismatch === "finished" ? new Date() : null,
        metadata: { owningService: mismatch === "owner" ? "different_service" : "native_workspace_finalizer" },
      });
      expect((await svc.getActiveForIssue(companyId, sourceIssueId))?.nativeRunActivity).toBeNull();
      expect((await svc.listActiveForIssues(companyId, [sourceIssueId, other.sourceIssueId])).get(sourceIssueId)?.nativeRunActivity).toBeNull();
    },
  );

  it("upserts one active source-scoped action per issue and keeps company scoping explicit", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);

    const first = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: "recovery:fingerprint",
      evidence: { latestRunId: "run-1" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });
    const second = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "stranded_assigned_issue",
      fingerprint: "recovery:fingerprint",
      evidence: { latestRunId: "run-2" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "wake_owner" },
    });

    expect(second.id).toBe(first.id);
    expect(second.attemptCount).toBe(2);
    expect(second.evidence).toMatchObject({ latestRunId: "run-2" });
    expect(await svc.getActiveForIssue(companyId, sourceIssueId)).toMatchObject({ id: first.id });
    expect(await svc.getActiveForIssue(randomUUID(), sourceIssueId)).toBeNull();
  });

  it("enforces maxAttempts once and removes every automatic recovery path", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);
    const base = {
      companyId,
      sourceIssueId,
      kind: "active_run_watchdog" as const,
      ownerType: "agent" as const,
      ownerAgentId: managerId,
      returnOwnerAgentId: managerId,
      cause: "process_lost",
      fingerprint: "run-process-lost",
      nextAction: "Resume the same run.",
      wakePolicy: { kind: "resume_native_run", runId: "run-1" },
      monitorPolicy: { kind: "watch_run", runId: "run-1" },
      maxAttempts: 3,
    };

    const first = await svc.upsertSourceScoped(base);
    const second = await svc.upsertSourceScoped(base);
    const exhausted = await svc.upsertSourceScoped(base);
    const replay = await svc.upsertSourceScoped(base);

    expect(first.attemptCount).toBe(1);
    expect(second.attemptCount).toBe(2);
    expect(exhausted).toMatchObject({
      id: first.id,
      status: "escalated",
      ownerType: "board",
      ownerAgentId: null,
      returnOwnerAgentId: managerId,
      attemptCount: 3,
      maxAttempts: 3,
      wakePolicy: null,
      monitorPolicy: null,
      outcome: "escalated",
      evidence: {
        recoveryBudget: {
          state: "exhausted",
          attemptsUsed: 3,
          maxAttempts: 3,
        },
      },
    });
    expect(replay).toEqual(exhausted);
  });

  it("preserves legacy recovery ownership when new evidence is folded into an active action", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const svc = issueRecoveryActionService(db);
    const legacy = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "process_lost",
      fingerprint: "legacy-recovery",
      evidence: { latestRunId: "run-1" },
      nextAction: "Repair the execution path.",
      wakePolicy: { type: "bounded_recovery_owner", ownerAgentId: managerId, attempt: 1, maxAttempts: 5 },
      attemptCount: 1,
      maxAttempts: 5,
    });

    const updated = await svc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "stranded_assigned_issue",
      ownerType: "board",
      ownerAgentId: null,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "process_lost",
      fingerprint: "legacy-recovery",
      evidence: { latestRunId: "run-2" },
      evidenceOnCreate: { routingPolicy: "board_escalation_no_takeover_v1" },
      nextAction: "Board decision required.",
      wakePolicy: { type: "board_escalation" },
      preserveExistingOwner: true,
    });

    expect(updated).toMatchObject({
      id: legacy.id,
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      attemptCount: 2,
      maxAttempts: 5,
      nextAction: "Repair the execution path.",
      evidence: expect.objectContaining({ latestRunId: "run-2" }),
      wakePolicy: expect.objectContaining({ type: "bounded_recovery_owner" }),
    });
    expect(updated.evidence).not.toHaveProperty("routingPolicy");
  });

  it("escalates stranded assigned work into a source action instead of a recovery issue", async () => {
    const { companyId, coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const latestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    const results = await Promise.all([
      recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun,
        comment: "Automatic continuation recovery failed.",
      }),
      recovery.escalateStrandedAssignedIssue({
        issue: sourceIssue,
        previousStatus: "in_progress",
        latestRun,
        comment: "Automatic continuation recovery failed.",
      }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      ownerType: "board",
      ownerAgentId: null,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 1,
      evidence: expect.objectContaining({
        routingPolicy: "board_escalation_no_takeover_v1",
      }),
    });

    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(updatedIssue).toMatchObject({
      status: "blocked",
    });
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(0);
    expect(updatedIssue?.assigneeAgentId).toBe(coderId);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it.each(["done", "cancelled", "reassigned", "returned_to_todo"] as const)(
    "preserves a concurrent %s decision when stale stranded recovery waits for the issue lock",
    async (decision) => {
      const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
      const issuesSvc = issueService(db);
      const observed = (await issuesSvc.update(sourceIssue.id, { status: "todo" }))!;
      await db.update(agents).set({ status: "paused" }).where(eq(agents.id, coderId));
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });
      const operatorDb = createDb(tempDb!.connectionString, { maxConnections: 1 });
      const probeDb = createDb(tempDb!.connectionString, { maxConnections: 1 });
      let release!: () => void;
      let ready!: () => void;
      let holderPid = 0;
      const locked = new Promise<void>((resolve) => { ready = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const operator = operatorDb.transaction(async (tx) => {
        await tx.select({ id: issues.id }).from(issues)
          .where(eq(issues.id, observed.id)).for("update");
        holderPid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0]!.pid;
        ready();
        await gate;
        if (decision === "returned_to_todo") {
          await issuesSvc.update(observed.id, { status: "in_progress" }, tx);
          return issuesSvc.update(observed.id, { status: "todo" }, tx);
        }
        return issuesSvc.update(observed.id, decision === "reassigned"
          ? { assigneeAgentId: managerId }
          : { status: decision }, tx);
      });
      await locked;
      const escalation = recovery.escalateStrandedAssignedIssue({
        issue: observed,
        previousStatus: "todo",
        latestRun: null,
        comment: "The original assignee is not invokable.",
      });
      let waiting = false;
      let winner: Awaited<typeof operator>;
      try {
        const deadline = Date.now() + 5_000;
        while (!waiting && Date.now() < deadline) {
          const [state] = await probeDb.execute<{ waiting: boolean }>(sql`
            select exists (select 1 from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'
                and ${holderPid} = any(pg_blocking_pids(pid))) as waiting
          `);
          waiting = state!.waiting;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally {
        release();
        winner = await operator;
      }
      const result = await escalation;
      expect(waiting, "recovery must contend with the actual operator row lock").toBe(true);
      expect(result).toBeNull();
      const [saved] = await db.select().from(issues).where(eq(issues.id, observed.id));
      expect(winner).toMatchObject(saved!);
      expect(saved).toMatchObject({
        status: decision === "done" || decision === "cancelled" ? decision : "todo",
        assigneeAgentId: decision === "reassigned" ? managerId : coderId,
      });
      expect(await db.select().from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, observed.id))).toEqual([]);
      expect(await db.select().from(issueComments)
        .where(eq(issueComments.issueId, observed.id))).toEqual([]);
      expect(await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, companyId))).toEqual([]);
      expect(await db.select().from(activityLog)
        .where(eq(activityLog.entityId, observed.id))).toEqual([]);
      expect(enqueueWakeup).not.toHaveBeenCalled();
    },
  );

  it("escalates an unchanged paused-assignee snapshot and publishes its committed notice", async () => {
    const { companyId, coderId, sourceIssue } = await seedCompany();
    const observed = (await issueService(db).update(sourceIssue.id, { status: "todo" }))!;
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, coderId));
    const enqueueWakeup = vi.fn(async () => null);
    const result = await recoveryService(db, { enqueueWakeup }).reconcileStrandedAssignedIssues();
    expect(result).toMatchObject({ escalated: 1, issueIds: [observed.id] });
    expect(await db.select().from(issues).where(eq(issues.id, observed.id)))
      .toMatchObject([{ status: "blocked", assigneeAgentId: coderId }]);
    expect(await db.select().from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, observed.id)))
      .toMatchObject([{ status: "active", previousOwnerAgentId: coderId }]);
    expect(await db.select().from(issueComments)
      .where(eq(issueComments.issueId, observed.id))).toHaveLength(1);
    expect(await db.select().from(activityLog)
      .where(eq(activityLog.entityId, observed.id)))
      .toMatchObject([{ details: expect.objectContaining({ status: "blocked" }) }]);
    expect(await db.select().from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.companyId, companyId))).toEqual([]);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it.each(["awaiting_release", "pending_dispatch"] as const)("preserves an accepted %s agent transfer at both recovery boundaries", async state => {
    const { companyId, coderId, managerId, sourceIssue } = await seedCompany();
    await instanceSettingsService(db).updateExperimental({ enableCases: true });
    if (state === "awaiting_release") {
      const runId = randomUUID();
      await seedHeartbeatRun({ companyId, agentId: coderId, runId, issueId: sourceIssue.id, status: "failed" });
      await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId })
        .where(eq(issues.id, sourceIssue.id));
    }
    const [observed] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, coderId));
    const toAgentId = state === "awaiting_release" ? managerId : coderId;
    const receipt = await caseHandoffService(db).handoff(companyId,
      { type: "board", source: "local_implicit" }, {
        idempotencyKey: randomUUID(),
        case: { create: { caseType: "work", title: "Continue accepted work" } },
        bindIssueId: observed!.id,
        expectedIssueStatusVersion: observed!.statusVersion,
        toAgentId,
        phase: "verification",
        instructions: "Verify the saved work after the source execution settles.",
        workflow_document_text: "Implementation → verification → done.",
      });
    expect(receipt.state).toBe(state);
    const [pending] = await db.select().from(issues).where(eq(issues.id, observed!.id));
    if (state === "awaiting_release") expect(pending).toMatchObject({
      status: observed!.status,
      statusVersion: observed!.statusVersion,
      lastStatusDecisionId: observed!.lastStatusDecisionId,
      assigneeAgentId: observed!.assigneeAgentId,
      executionRunId: observed!.executionRunId,
      checkoutRunId: observed!.checkoutRunId,
    });
    else expect(pending).toMatchObject({ status: "todo", assigneeAgentId: coderId });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, pending!.id));
    const activities = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)).orderBy(activityLog.id);
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    // A fresh issue snapshot alone cannot identify the ledger's successor.
    // The locked mutation boundary must consult the accepted handoff too.
    expect(await recovery.escalateStrandedAssignedIssue({
      issue: pending!, previousStatus: state === "awaiting_release" ? "in_progress" : "todo", latestRun: null,
      comment: "The original assignee is not invokable.",
    })).toBeNull();
    expect(await recovery.reconcileStrandedAssignedIssues()).toMatchObject({ escalated: 0, issueIds: [] });
    expect(await db.select().from(issues).where(eq(issues.id, pending!.id))).toEqual([pending]);
    expect(await db.select().from(caseHandoffs).where(eq(caseHandoffs.id, receipt.handoffId)))
      .toMatchObject([{ state, toAgentId }]);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, pending!.id))).toEqual(comments);
    expect(await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)).orderBy(activityLog.id)).toEqual(activities);
    expect(await db.select().from(issueRecoveryActions)).toEqual([]);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toEqual([]);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it.each([false, true])("settles escalation on a one-connection pool (legacy recovery issue: %s)", async (legacyRecoveryIssue) => {
    const { sourceIssue } = await seedCompany();
    if (legacyRecoveryIssue) {
      await db.update(issues).set({ originKind: "stranded_issue_recovery", originId: sourceIssue.id })
        .where(eq(issues.id, sourceIssue.id));
    }
    const [observed] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    const singleConnectionDb = createDb(tempDb!.connectionString, { maxConnections: 1 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = recoveryService(singleConnectionDb, { enqueueWakeup: async () => null })
        .escalateStrandedAssignedIssue({ issue: observed!, previousStatus: "in_progress", latestRun: null });
      const result = await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("escalation borrowed its own exhausted connection pool")), 2_000);
        }),
      ]);
      expect(result).toMatchObject({ id: observed!.id, status: "blocked" });
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, observed!.id))).toHaveLength(1);
      expect(await db.select().from(activityLog).where(eq(activityLog.entityId, observed!.id))).toHaveLength(1);
    } finally {
      clearTimeout(timer);
      await singleConnectionDb.$client.end({ timeout: 0 });
    }
  });

  // Model the production payload: `requestedRef` keeps the operator spelling,
  // and the fingerprint carries the canonical remote ref. Two equivalent
  // spellings of one remote branch share `identityRef`, so they share one
  // fingerprint. A different branch gets a different `identityRef`.
  const makeUnresolvedBaseRefRun = (agentId: string, issueId: string) =>
    (requestedRef: string, identityRef: string) =>
      ({
        id: randomUUID(),
        agentId,
        status: "failed",
        error: `Configured workspace base ref "${requestedRef}" did not resolve to a commit on origin after an authenticated fetch.`,
        errorCode: "configuration_incomplete",
        contextSnapshot: { issueId },
        livenessState: "needs_followup",
        resultJson: {
          configurationIncomplete: {
            reason: "workspace_base_ref_unresolved",
            requestedRef,
            attemptedRefs: [identityRef],
            fingerprint: `workspace_base_ref:${identityRef}`,
          },
        },
      }) as const;

  it("bounds configuration-incomplete recovery by the unresolved base ref fingerprint", async () => {
    const { coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const makeRun = makeUnresolvedBaseRefRun(coderId, sourceIssue.id);

    // Two reconciliations with the same unresolved ref reuse one active action.
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: (await issueService(db).getById(sourceIssue.id))!,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      cause: "configuration_incomplete",
      status: "active",
      attemptCount: 2,
    });
    // The fingerprint carries the canonical remote ref, so the same branch stays
    // one action and a different branch would make a distinct fingerprint.
    expect(actions[0]?.fingerprint).toBe(
      `source_scoped_recovery:${sourceIssue.companyId}:${sourceIssue.id}:configuration_incomplete:workspace_base_ref:origin/fix/foo`,
    );
  });

  it("keeps equivalent spellings of one unresolved base ref under one recovery identity", async () => {
    const { coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const makeRun = makeUnresolvedBaseRefRun(coderId, sourceIssue.id);

    // The operator retries the same remote branch under two spellings. Both map
    // to the canonical `origin/fix/foo` identity, so recovery must not reset the
    // attempt count. Each failed run still needs its own actionable notice.
    const firstRun = makeRun("fix/foo", "origin/fix/foo");
    const secondRun = makeRun("origin/fix/foo", "origin/fix/foo");
    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstRun,
      recoveryCause: "configuration_incomplete",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: (await issueService(db).getById(sourceIssue.id))!,
      previousStatus: "in_progress",
      latestRun: secondRun,
      recoveryCause: "configuration_incomplete",
    });

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    // One identity, one active action, the attempt count advances.
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      cause: "configuration_incomplete",
      status: "active",
      attemptCount: 2,
    });
    expect(actions[0]?.fingerprint).toBe(
      `source_scoped_recovery:${sourceIssue.companyId}:${sourceIssue.id}:configuration_incomplete:workspace_base_ref:origin/fix/foo`,
    );

    // Each run gets one notice bound to the same action; reconciling the
    // latest run again must not duplicate its notice.
    await recovery.escalateStrandedAssignedIssue({
      issue: (await issueService(db).getById(sourceIssue.id))!, previousStatus: "in_progress", latestRun: secondRun,
      recoveryCause: "configuration_incomplete",
    });
    const notices = await db
      .select({ metadata: issueComments.metadata })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, sourceIssue.id),
          eq(issueComments.authorType, "system"),
        ),
      );
    expect(
      notices.filter((row) =>
        noticeMetadataReferencesRecoveryAction(row.metadata, actions[0]!.id),
      ),
    ).toHaveLength(2);
    expect(notices.map((row) => row.metadata?.sourceRunId).sort()).toEqual([firstRun.id, secondRun.id].sort());
  });

  it("gives a distinct recovery identity and a new operator notice when the unresolved base ref changes", async () => {
    const { coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const makeRun = makeUnresolvedBaseRefRun(coderId, sourceIssue.id);

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/foo", "origin/fix/foo"),
      recoveryCause: "configuration_incomplete",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: (await issueService(db).getById(sourceIssue.id))!,
      previousStatus: "in_progress",
      latestRun: makeRun("fix/bar", "origin/fix/bar"),
      recoveryCause: "configuration_incomplete",
    });

    const actions = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    // The prior ref keeps its own record and the new ref gets a fresh identity.
    expect(actions).toHaveLength(2);
    const priorAction = actions.find((row) =>
      row.fingerprint.endsWith("workspace_base_ref:origin/fix/foo"),
    );
    const newAction = actions.find((row) =>
      row.fingerprint.endsWith("workspace_base_ref:origin/fix/bar"),
    );
    expect(priorAction?.status).toBe("cancelled");
    expect(priorAction?.outcome).toBe("cancelled");
    expect(newAction?.status).toBe("active");
    expect(newAction?.attemptCount).toBe(1);
    expect(newAction?.id).not.toBe(priorAction?.id);

    // The operator gets one notice per distinct ref, each bound to its action.
    const systemComments = await db
      .select({ metadata: issueComments.metadata })
      .from(issueComments)
      .where(
        and(
          eq(issueComments.issueId, sourceIssue.id),
          eq(issueComments.authorType, "system"),
        ),
      );
    expect(
      systemComments.some((row) =>
        noticeMetadataReferencesRecoveryAction(row.metadata, priorAction!.id),
      ),
    ).toBe(true);
    expect(
      systemComments.some((row) =>
        noticeMetadataReferencesRecoveryAction(row.metadata, newAction!.id),
      ),
    ).toBe(true);
  });

  it.each([
    ["process_lost", undefined],
    ["adapter_failed", "successful_run_missing_state"],
    ["codex_output_inactivity_monitor", undefined],
    ["workspace_validation_failed", "workspace_validation_failed"],
    ["adapter_failed", undefined],
  ] as const)(
    "routes %s recovery through the cause-keyed playbook",
    async (errorCode, explicitCause) => {
      const { coderId, sourceIssue } = await seedCompany();
      const enqueueWakeup = vi.fn(async () => null);
      const recovery = recoveryService(db, { enqueueWakeup });
      const latestRun = {
        id: randomUUID(),
        agentId: coderId,
        status: errorCode === "adapter_failed" && explicitCause === "successful_run_missing_state"
          ? "succeeded"
          : "failed",
        error: `${errorCode} failure`,
        errorCode,
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
        resultJson: errorCode === "workspace_validation_failed"
          ? { workspaceValidation: { reason: "missing_workspace", fingerprint: "workspace:test" } }
          : null,
      } as const;

      await recovery.escalateStrandedAssignedIssue({
        issue: (await issueService(db).getById(sourceIssue.id))!,
        previousStatus: "in_progress",
        latestRun,
        ...(explicitCause ? { recoveryCause: explicitCause } : {}),
      });

      const [action] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
      expect(action).toMatchObject({
        ownerType: "board",
        ownerAgentId: null,
        previousOwnerAgentId: coderId,
        returnOwnerAgentId: coderId,
        evidence: expect.objectContaining({
          routingPolicy: "board_escalation_no_takeover_v1",
        }),
        wakePolicy: expect.objectContaining({
          type: "board_escalation",
          preservesSourceAssignee: true,
        }),
      });
      expect(enqueueWakeup).not.toHaveBeenCalled();
    },
  );

  it("stands down while the latest run was cancelled by a board operator", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "cancelled",
      error: "Cancelled by a board operator",
      errorCode: "cancelled",
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "board-user" },
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.operatorCancelExempted).toBe(1);
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("stands down after an operator interrupt cancellation", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "cancelled",
      error: "Interrupted by board comment",
      errorCode: "operator_interrupted",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.operatorCancelExempted).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("still recovers system-cancelled runs with no operator attribution", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "cancelled",
      error: "Cancelled because the workspace lease expired",
      errorCode: "cancelled",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.operatorCancelExempted).toBe(0);
    expect(result.escalated).toBe(1);
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(await db.select().from(issueRecoveryActions)).toEqual([expect.objectContaining({
      cause: "legacy_execution_requires_reconciliation", ownerType: "board", returnOwnerAgentId: coderId,
    })]);
  });

  it("schedules a provider-quota monitor for the original assignee without creating recovery work", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "You've hit your usage limit for GPT-5. Try again at 12:00 AM (UTC).",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.providerQuotaMonitored).toBe(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
      monitorScheduledBy: "assignee",
      monitorNotes: "Provider usage quota reached; retry the original assignee at the provider reset time.",
    });
    expect(updatedIssue?.monitorNextCheckAt).toBeInstanceOf(Date);
    expect(updatedIssue?.executionPolicy).toMatchObject({
      monitor: {
        serviceName: "AI provider quota",
        externalRef: runId,
        maxAttempts: null,
        recoveryPolicy: "wake_owner",
      },
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun).toMatchObject({ errorCode: "provider_quota" });
    expect(updatedRun?.resultJson).toMatchObject({ errorFamily: "provider_quota" });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();

    const secondResult = await recovery.reconcileStrandedAssignedIssues();
    expect(secondResult).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
  });

  it("schedules another provider-quota monitor after a prior quota monitor fired", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ monitorAttemptCount: 1 }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T21:00:00.000Z"),
      finishedAt: new Date("2026-07-15T21:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.providerQuotaMonitored).toBe(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue?.executionPolicy).toMatchObject({
      monitor: {
        maxAttempts: null,
        externalRef: runId,
      },
    });
  });

  it("skips provider-quota monitor scheduling for todo issues without aborting reconciliation", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "todo",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("adapter_failed");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not create takeover recovery when a quota monitor cannot be scheduled", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "in_review" }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("adapter_failed");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it.each([true, false])("schedules a quota monitor for a cross-agent active review participant only with submission proof (%s)", async (proven) => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: coderId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        changesRequestedCount: 0,
      },
    }).where(eq(issues.id, sourceIssueId));
    const [reviewIssueBeforeRecovery] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(reviewIssueBeforeRecovery).toMatchObject({
      assigneeAgentId: coderId,
      executionState: {
        currentParticipant: { type: "agent", agentId: managerId },
        returnAssignee: { type: "agent", agentId: coderId },
      },
    });
    const runId = randomUUID();
    const [submission] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId, ...(proven ? { reviewerAssignmentGeneration: issueExecutionGeneration(submission) } : {}) },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    if (!proven) {
      expect(result).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
      expect((await db.select().from(issues).where(eq(issues.id, sourceIssueId)))[0]).toMatchObject({
        monitorNextCheckAt: null, executionPolicy: submission.executionPolicy, executionState: submission.executionState,
      });
      expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0].contextSnapshot)
        .toEqual({ issueId: sourceIssueId });
      expect(enqueueWakeup).not.toHaveBeenCalled();
      return;
    }
    expect(result).toMatchObject({ providerQuotaMonitored: 1, reviewParticipantRequeued: 0 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: coderId,
      monitorNextCheckAt: expect.any(Date),
      monitorNotes: "Provider usage quota reached; retry the active review participant after the default recovery backoff.",
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("provider_quota");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not restamp an in_review quota monitor when the assignee has a newer terminal run", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: coderId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        changesRequestedCount: 0,
      },
    }).where(eq(issues.id, sourceIssueId));
    const participantRunId = randomUUID();
    const [submission] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    await db.insert(heartbeatRuns).values({
      id: participantRunId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId, reviewerAssignmentGeneration: issueExecutionGeneration(submission) },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const firstResult = await recovery.reconcileStrandedAssignedIssues();

    expect(firstResult).toMatchObject({ providerQuotaMonitored: 1 });
    const [monitoredIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    const firstNextCheckAt = monitoredIssue?.monitorNextCheckAt;
    expect(firstNextCheckAt).toBeInstanceOf(Date);
    expect(monitoredIssue?.executionPolicy).toMatchObject({
      monitor: {
        serviceName: "AI provider quota",
        externalRef: participantRunId,
      },
    });

    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "automation",
      status: "failed",
      error: "Stale assignee wake fired after the issue entered review.",
      errorCode: "issue_assignee_changed",
      startedAt: new Date("2026-07-15T20:02:00.000Z"),
      finishedAt: new Date("2026-07-15T20:03:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });

    const secondResult = await recovery.reconcileStrandedAssignedIssues();

    expect(secondResult).toMatchObject({ providerQuotaMonitored: 0, skipped: 1 });
    const [unchangedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(unchangedIssue?.monitorNextCheckAt?.getTime()).toBe(firstNextCheckAt?.getTime());
    expect(unchangedIssue?.executionPolicy).toMatchObject({
      monitor: {
        serviceName: "AI provider quota",
        externalRef: participantRunId,
      },
    });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("classifies review recovery from the active participant run instead of a newer assignee run", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      assigneeAgentId: coderId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const participantRunId = randomUUID();
    const assigneeRunId = randomUUID();
    await db.insert(heartbeatRuns).values([{
      id: participantRunId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      error: "review process exited unexpectedly",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    }, {
      id: assigneeRunId,
      companyId,
      agentId: coderId,
      invocationSource: "automation",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "You've hit your usage limit. Try again at 11:00 PM (UTC)",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:02:00.000Z"),
      finishedAt: new Date("2026-07-15T20:03:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    }]);
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() } as never));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ providerQuotaMonitored: 0, reviewParticipantRequeued: 0, escalated: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_review",
      assigneeAgentId: coderId,
      monitorNextCheckAt: null,
    });
    const [assigneeRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, assigneeRunId));
    expect(assigneeRun?.errorCode).toBe("adapter_failed");
    expect(enqueueWakeup).not.toHaveBeenCalled();
    expect(await db.select().from(issueRecoveryActions)).toEqual([expect.objectContaining({
      cause: "legacy_execution_requires_reconciliation", ownerType: "board", returnOwnerAgentId: coderId,
      evidence: expect.objectContaining({ runId: participantRunId }),
    })]);
  });

  it("blocks a cross-agent review participant with incomplete configuration", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const stageId = randomUUID();
    await db.update(issues).set({
      status: "in_review",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: managerId, userId: null }],
        }],
      },
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: managerId, userId: null },
        returnAssignee: { type: "agent", agentId: coderId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, sourceIssueId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "automation",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "model_not_found: requested review model does not exist",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => ({ id: randomUUID() } as never));
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 1, reviewParticipantRequeued: 0 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "blocked",
      assigneeAgentId: coderId,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("configuration_incomplete");
    const [action] = await db.select().from(issueRecoveryActions);
    expect(action).toMatchObject({
      sourceIssueId,
      ownerType: "board",
      ownerAgentId: null,
      previousOwnerAgentId: coderId,
      cause: "configuration_incomplete",
      recoveryIssueId: null,
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("uses the default quota backoff when the provider does not state a reset time", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "Provider quota exceeded for this model.",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.providerQuotaMonitored).toBe(1);
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
      monitorNotes: "Provider usage quota reached; retry the original assignee after the default recovery backoff.",
    });
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
  });

  it("classifies model lookup failures as configuration incomplete without waking a recovery owner", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: coderId,
      invocationSource: "manual",
      status: "failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      error: "model_not_found: requested model does not exist",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 1, skipped: 0 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue?.status).toBe("blocked");
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("configuration_incomplete");
    const [action] = await db.select().from(issueRecoveryActions);
    expect(action).toMatchObject({
      sourceIssueId,
      cause: "configuration_incomplete",
      recoveryIssueId: null,
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("does not classify stale configuration failures from a non-assignee run", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId: managerId,
      invocationSource: "manual",
      status: "failed",
      error: "model_not_found: previous assignee model does not exist",
      errorCode: "adapter_failed",
      startedAt: new Date("2026-07-15T20:00:00.000Z"),
      finishedAt: new Date("2026-07-15T20:01:00.000Z"),
      contextSnapshot: { issueId: sourceIssueId },
    });
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result).toMatchObject({ escalated: 0, skipped: 1 });
    const [updatedIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(updatedIssue).toMatchObject({
      status: "in_progress",
      assigneeAgentId: coderId,
    });
    const [updatedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(updatedRun?.errorCode).toBe("adapter_failed");
    expect(await db.select().from(issueRecoveryActions)).toHaveLength(0);
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("reuses the same source-scoped action when latest run IDs change while the cause stays the same", async () => {
    const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;
    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Automatic continuation recovery failed.",
    });
    await recovery.escalateStrandedAssignedIssue({
      issue: (await issueService(db).getById(sourceIssue.id))!,
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });
    expect(actionRows[0]?.evidence).toMatchObject({ latestRunId: secondLatestRun.id });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("deduplicates workspace-incoherence recovery actions by the typed workspace fingerprint", async () => {
    const { companyId, coderId, sourceIssue } = await seedCompany();
    const enqueueWakeup = vi.fn(async () => null);
    const recovery = recoveryService(db, { enqueueWakeup });
    const workspaceFingerprint = `workspace_incoherence:v1:sha256:${"a".repeat(64)}`;
    const workspaceValidation = {
      reason: "git_worktree_branch_incoherence",
      fingerprint: workspaceFingerprint,
      sourceIssueId: sourceIssue.id,
      sourceIdentifier: sourceIssue.identifier,
      executionWorkspaceId: "execution-workspace-1",
      expectedBranch: "PAP-1-expected",
      actualBranch: "PAP-1-publish",
      cleanliness: "dirty",
      provenance: {
        expectedBranchExists: true,
        actualBranchExists: true,
        expectedHeadSha: "1111111111111111111111111111111111111111",
        actualHeadSha: "2222222222222222222222222222222222222222",
        sameHead: false,
      },
      safeRepair: {
        eligible: false,
        attempted: false,
        succeeded: false,
        reason: "worktree is not clean",
      },
    };
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "workspace branch mismatch",
      errorCode: "workspace_validation_failed",
      contextSnapshot: {},
      livenessState: "failed",
      resultJson: { workspaceValidation },
    } as const;
    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Workspace failed validation.",
      recoveryCause: "workspace_validation_failed",
    });
    // Prove dedupe uses the structured recovery-action reference rather than
    // depending only on the legacy body marker.
    await db
      .update(issueComments)
      .set({ body: "Workspace recovery was already escalated." })
      .where(eq(issueComments.issueId, sourceIssue.id));
    await recovery.escalateStrandedAssignedIssue({
      issue: (await issueService(db).getById(sourceIssue.id))!,
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Workspace failed validation.",
      recoveryCause: "workspace_validation_failed",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "workspace_validation",
      cause: "workspace_validation_failed",
      status: "active",
      attemptCount: 2,
      fingerprint: expect.stringContaining(workspaceFingerprint),
      evidence: expect.objectContaining({
        latestRunId: secondLatestRun.id,
        latestRunErrorCode: "workspace_validation_failed",
        workspaceValidation: expect.objectContaining({
          reason: "git_worktree_branch_incoherence",
          fingerprint: workspaceFingerprint,
          sourceIssueId: sourceIssue.id,
          executionWorkspaceId: "execution-workspace-1",
          expectedBranch: "PAP-1-expected",
          actualBranch: "PAP-1-publish",
          cleanliness: "dirty",
        }),
      }),
      nextAction: expect.stringContaining("git worktree branch incoherence"),
      wakePolicy: expect.objectContaining({
        type: "board_escalation",
        reason: "workspace_validation_failed",
        preservesSourceAssignee: true,
      }),
    });

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    const escalationComments = comments.filter((comment) =>
      noticeMetadataReferencesRecoveryAction(comment.metadata, actionRows[0]!.id),
    );
    expect(escalationComments).toHaveLength(1);
    expect(escalationComments[0]?.presentation).toMatchObject({
      kind: "system_notice",
      tone: "danger",
      title: "Workspace validation failed",
    });
    expect(enqueueWakeup).not.toHaveBeenCalled();
  });

  it("keeps the source issue blocked when source-scoped wakeup is claimed synchronously", async () => {
    const { companyId, managerId, coderId, sourceIssue } = await seedCompany();
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, managerId));
    const enqueueWakeup = vi.fn(async () => {
      await db
        .update(issues)
        .set({ status: "in_progress" })
        .where(eq(issues.id, sourceIssue.id));
      return null;
    });
    const recovery = recoveryService(db, { enqueueWakeup });
    const firstLatestRun = {
      id: randomUUID(),
      agentId: coderId,
      status: "failed",
      error: "adapter failed",
      errorCode: "adapter_failed",
      contextSnapshot: { retryReason: "issue_continuation_needed" },
      livenessState: "needs_followup",
    } as const;

    await recovery.escalateStrandedAssignedIssue({
      issue: sourceIssue,
      previousStatus: "in_progress",
      latestRun: firstLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const [afterFirst] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(afterFirst?.status).toBe("blocked");
    expect(afterFirst?.assigneeAgentId).toBe(coderId);

    const secondLatestRun = {
      ...firstLatestRun,
      id: randomUUID(),
    };
    await recovery.escalateStrandedAssignedIssue({
      issue: (await issueService(db).getById(sourceIssue.id))!,
      previousStatus: "in_progress",
      latestRun: secondLatestRun,
      comment: "Automatic continuation recovery failed.",
    });

    const actionRows = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.sourceIssueId, sourceIssue.id));
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      companyId,
      kind: "stranded_assigned_issue",
      status: "active",
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "stranded_assigned_issue",
      attemptCount: 2,
    });
    const [afterSecond] = await db.select().from(issues).where(eq(issues.id, sourceIssue.id));
    expect(afterSecond?.status).toBe("blocked");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, sourceIssue.id));
    expect(comments).toHaveLength(1);
    // Dedupe for structured notices is metadata-based: the short body no longer
    // carries the `Recovery action: \`id\`` marker line.
    expect(comments[0]?.body).not.toContain("Recovery action:");
    expect(noticeMetadataReferencesRecoveryAction(comments[0]?.metadata, actionRows[0]!.id)).toBe(true);
    expect(comments[0]?.presentation).toMatchObject({ kind: "system_notice", tone: "danger" });
  });

  it("does not create nested recovery artifacts when issue-backed fallback work itself fails", async () => {
    const { companyId, managerId, sourceIssueId, prefix } = await seedCompany();
    const recoveryIssueId = randomUUID();
    await db.insert(issues).values({
      id: recoveryIssueId,
      companyId,
      title: "Recover stalled issue",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: managerId,
      parentId: sourceIssueId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
      originKind: "stranded_issue_recovery",
      originId: sourceIssueId,
      originFingerprint: `stranded_issue_recovery:${sourceIssueId}`,
    });
    const [recoveryIssue] = await db.select().from(issues).where(eq(issues.id, recoveryIssueId));
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });

    await recovery.escalateStrandedAssignedIssue({
      issue: recoveryIssue!,
      previousStatus: "in_progress",
      latestRun: {
        id: randomUUID(),
        agentId: managerId,
        status: "failed",
        error: "adapter failed",
        errorCode: "adapter_failed",
        contextSnapshot: { retryReason: "issue_continuation_needed" },
        livenessState: "needs_followup",
      },
    });

    const actionRows = await db.select().from(issueRecoveryActions);
    expect(actionRows).toHaveLength(0);
    const recoveryIssues = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, "stranded_issue_recovery")));
    expect(recoveryIssues).toHaveLength(1);
    expect(recoveryIssues[0]?.status).toBe("blocked");
  });

  it("exposes active recovery actions on the issue read API", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toMatchObject({
      id: action.id,
      sourceIssueId,
      kind: "missing_disposition",
      ownerAgentId: managerId,
    });

    const list = await request(app).get(`/api/issues/${sourceIssueId}/recovery-actions`).expect(200);
    expect(list.body.active).toMatchObject({ id: action.id });
    expect(list.body.actions).toHaveLength(1);
  });

  it("lists a settled reconciliation hold that still blocks replay", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId,
      sourceIssueId,
      kind: "active_run_watchdog",
      status: "resolved",
      outcome: "blocked",
      ownerType: "board",
      returnOwnerAgentId: coderId,
      cause: "legacy_execution_requires_reconciliation",
      fingerprint: runId,
      nextAction: "Preserve recorded work without replay.",
      evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
    }).returning();

    const list = await request(createApp()).get(`/api/issues/${sourceIssueId}/recovery-actions`).expect(200);

    expect(list.body.active).toBeNull();
    expect(list.body.actions).toEqual([
      expect.objectContaining({
        id: action!.id,
        status: "resolved",
        cause: "legacy_execution_requires_reconciliation",
        evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
      }),
    ]);
  });

  it("projects recovery action metadata into the structured wake payload", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:wake-payload",
      evidence: {
        failureSummary: "Worktree branch does not match the pinned branch.",
        routingFallbackReason: null,
      },
      nextAction: "Repair the worktree, then return the issue to the coder.",
      wakePolicy: { type: "wake_owner" },
      maxAttempts: 3,
    });

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId: sourceIssueId,
        wakeReason: "source_scoped_recovery_action",
        recoveryActionId: action.id,
        recoveryCause: action.cause,
      },
    });

    expect(payload?.recovery).toEqual({
      cause: "workspace_validation_failed",
      failureSummary: "Worktree branch does not match the pinned branch.",
      originalAssignee: { id: coderId, name: "Coder" },
      attemptCount: 1,
      maxAttempts: 3,
      nextAction: "Repair the worktree, then return the issue to the coder.",
      routingFallbackReason: null,
    });
  });

  it.each(["resolved", "cancelled"])("omits %s recovery instructions when the original worker resumes", async (status) => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId, sourceIssueId, kind: "stranded_assigned_issue", ownerType: "board",
      returnOwnerAgentId: coderId, cause: "stranded_assigned_issue", fingerprint: "finished-recovery",
      evidence: { failureSummary: "Retry budget exhausted during cleanup." },
      nextAction: "Repair the runtime, then retry the original owner.", wakePolicy: null,
    });
    await db.update(issueRecoveryActions).set({ status, outcome: "handed_back", resolvedAt: new Date() })
      .where(eq(issueRecoveryActions.id, action.id));
    const payload = await buildPaperclipWakePayload({ db, companyId, contextSnapshot: {
      issueId: sourceIssueId, wakeReason: "issue_recovery_action_restored",
      recoveryActionId: action.id, recoveryCause: action.cause,
    } });
    expect(payload?.issue?.id).toBe(sourceIssueId);
    expect(payload?.recovery).toBeNull();
    const prompt = renderPaperclipWakePrompt(payload);
    expect(prompt).toContain("Implement backend recovery");
    expect(prompt).not.toContain("Recovery contract:");
    expect(prompt).not.toContain(action.nextAction);
    expect(prompt).not.toContain("Do not produce the deliverable");
  });

  it("accepts new verified evidence after an automatic no-replay disposition without reopening on duplicate requests", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await seedHeartbeatRun({ companyId, agentId: coderId, runId, issueId: sourceIssueId, status: "failed" });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId, kind: "active_run_watchdog", status: "resolved", outcome: "blocked",
      ownerType: "board", returnOwnerAgentId: coderId, cause: "uncertain_external_action", fingerprint: runId,
      nextAction: "Preserve recorded work without replay.",
      evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
    }).returning();
    const app = createApp();
    const body = { actionId: action!.id, outcome: "restored", sourceIssueStatus: "todo",
      executionReconciliation: { runId, providerStopped: true, actionOutcome: "not_performed",
        outcomeEvidence: "Provider receipts confirm the action was never submitted; the stopped process has no remaining effects." } };
    // A retry without new evidence cannot clear the hold or reopen the task.
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send({ ...body, executionReconciliation: undefined }).expect(200);
    expect((await db.select().from(issues).where(eq(issues.id, sourceIssueId)))[0]!.status).toBe("blocked");
    const resolved = await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect(resolved.body.issue.status).toBe("todo");
    const [recorded] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id));
    expect(recorded!.evidence).not.toHaveProperty("automaticRecovery");
    expect(recorded!.evidence).toMatchObject({ executionReconciliation: { runId }, continuationDelivery: "pending" });
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id)))[0]).toEqual(recorded);
  });

  it("refuses an admission request before any read or write until admission is supported", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    await seedHeartbeatRun({ companyId, agentId: coderId, runId, issueId: sourceIssueId, status: "failed" });
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId, sourceIssueId, kind: "active_run_watchdog", status: "resolved", outcome: "blocked",
      ownerType: "board", returnOwnerAgentId: coderId, cause: "uncertain_external_action", fingerprint: runId,
      nextAction: "Preserve recorded work without replay.",
      evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
    }).returning();
    const timestamp = "2026-10-27T12:00:00.000Z";
    const admission = {
      schema: "execution_reconciliation_admission_v1", idempotencyKey: "recon:capability-check",
      expectedDigest: "a".repeat(64),
      authorization: { documentId: randomUUID(), revisionId: randomUUID(), revisionNumber: 1, bodyDigest: "b".repeat(64), decisionId: randomUUID() },
      expected: {
        companyId, projectId: null, issueId: sourceIssueId, runId, actionId: action!.id,
        run: { status: "failed", finishedAt: timestamp, agentId: coderId, processPid: null, processGroupId: null, runtimeMode: null },
        unstartedRunIds: [],
        action: { status: "resolved", cause: "uncertain_external_action", kind: "active_run_watchdog", outcome: "blocked",
          ownerAgentId: null, returnOwnerAgentId: coderId, updatedAt: timestamp },
        issue: { status: "blocked", statusVersion: 0, assigneeAgentId: coderId, assigneeUserId: null, responsibleUserId: null,
          workspaceBindingRevision: 0, executionPolicy: null, executionState: null, unblockDescriptor: null,
          monitorNextCheckAt: null, monitorAttemptCount: 0, monitorScheduledBy: null, monitorNotes: null },
      },
    };
    const [beforeAction] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id));
    const [beforeIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    const response = await request(createApp()).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send({
      actionId: action!.id, outcome: "restored", sourceIssueStatus: "todo",
      executionReconciliation: { runId, providerStopped: true, actionOutcome: "completed",
        outcomeEvidence: "The stopped run saved its comment and commit before the hold.", admission },
    }).expect(400);
    expect(response.body.code).toBe("capability_unsupported");
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id)))[0]).toEqual(beforeAction);
    expect((await db.select().from(issues).where(eq(issues.id, sourceIssueId)))[0]).toEqual(beforeIssue);
  });

  it("reads and settles reconciliation keys for Board only and logs the settlement", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const key = "recon:route-settle-key";
    const agentApp = createApp({ type: "agent", agentId: coderId, companyId, source: "agent_key" });
    await request(agentApp).get(`/api/issues/${sourceIssueId}/recovery-actions/receipts/${key}`).expect(403);
    await request(agentApp).post(`/api/issues/${sourceIssueId}/recovery-actions/receipts/${key}/settle`).expect(403);
    const app = createApp({ type: "board", source: "local_implicit", userId: "board-user" });
    await request(app).get(`/api/issues/${sourceIssueId}/recovery-actions/receipts/short`).expect(400);
    expect((await request(app).get(`/api/issues/${sourceIssueId}/recovery-actions/receipts/${key}`).expect(200)).body)
      .toEqual({ state: "unsettled" });
    const settled = await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/receipts/${key}/settle`).expect(200);
    expect(settled.body.state).toBe("abandoned");
    expect((await request(app).get(`/api/issues/${sourceIssueId}/recovery-actions/receipts/${key}`).expect(200)).body.state)
      .toBe("abandoned");
    expect((await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/receipts/${key}/settle`).expect(200)).body)
      .toEqual({ state: "abandoned", settledAt: settled.body.settledAt });
    const logged = await db.select().from(activityLog).where(eq(activityLog.action, "issue.execution_reconciliation_key_settled"));
    expect(logged).toHaveLength(1);
    expect(logged[0]!.details).toMatchObject({ idempotencyKey: key, state: "abandoned" });
  });

  it("rolls back a settlement whose audit row fails, and a retry writes the tombstone with its audit", async () => {
    const { sourceIssueId } = await seedCompany();
    const key = "recon:settle-audit-fail";
    const app = createApp({ type: "board", source: "local_implicit", userId: "board-user" });
    await db.execute(sql`create function fail_settle_audit() returns trigger language plpgsql as $$
      begin if new.action = 'issue.execution_reconciliation_key_settled' then raise exception 'audit unavailable'; end if; return new; end $$`);
    await db.execute(sql`create trigger fail_settle_audit before insert on activity_log for each row execute function fail_settle_audit()`);
    try {
      await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/receipts/${key}/settle`).expect(500);
    } finally {
      await db.execute(sql`drop trigger fail_settle_audit on activity_log`);
      await db.execute(sql`drop function fail_settle_audit()`);
    }
    expect(await db.select().from(executionReconciliationReceipts)).toHaveLength(0);
    expect((await request(app).get(`/api/issues/${sourceIssueId}/recovery-actions/receipts/${key}`).expect(200)).body)
      .toEqual({ state: "unsettled" });
    const retry = await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/receipts/${key}/settle`).expect(200);
    expect(retry.body.state).toBe("abandoned");
    const logged = await db.select().from(activityLog).where(eq(activityLog.action, "issue.execution_reconciliation_key_settled"));
    expect(logged).toHaveLength(1);
    expect(logged[0]!.details).toMatchObject({ idempotencyKey: key, state: "abandoned" });
  });

  describe("PATCH rechecks execution policy transition inputs under the row lock (G3)", () => {
    const reviewPolicy = (agentId: string) => normalizeIssueExecutionPolicy({
      stages: [{ id: randomUUID(), type: "review", participants: [{ type: "agent", agentId }] }],
    })!;
    const issueRowLockWaiters = async () => (await db.execute(sql`select count(*)::int as n from pg_stat_activity
      where wait_event_type = 'Lock' and query ilike 'select "id", "company_id", "conversation_agent_id"%'`) as unknown as { n: number }[])[0]!.n;

    it("refuses a PATCH computed before a review policy committed under the lock it waited on", async () => {
      const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
      await db.update(issues).set({ status: "in_progress", assigneeAgentId: coderId, executionPolicy: null, executionState: null })
        .where(eq(issues.id, sourceIssueId));
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let locked!: () => void;
      const lockedSignal = new Promise<void>((resolve) => { locked = resolve; });
      const policyWriter = db.transaction(async (tx) => {
        await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, sourceIssueId)).for("update");
        locked();
        await held;
        await tx.update(issues).set({ executionPolicy: reviewPolicy(managerId) as any }).where(eq(issues.id, sourceIssueId));
      });
      await lockedSignal;
      const pending = request(createApp({ type: "board", source: "local_implicit", userId: "board-user" }))
        .patch(`/api/issues/${sourceIssueId}`).send({ status: "done" }).then((response) => response);
      for (let attempt = 0; attempt < 50 && await issueRowLockWaiters() === 0; attempt += 1) await new Promise((r) => setTimeout(r, 50));
      expect(await issueRowLockWaiters()).toBe(1);
      release();
      await policyWriter;
      const response = await pending;
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ details: { code: "execution_policy_transition_stale" } });
      const [after] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      expect(after!.status).toBe("in_progress");
      expect(after!.executionPolicy).not.toBeNull();
      expect(companyId).toBeTruthy();
    });

    it("keeps a PATCH that committed before the policy writer, and the policy written after it", async () => {
      const { managerId, coderId, sourceIssueId } = await seedCompany();
      await db.update(issues).set({ status: "in_progress", assigneeAgentId: coderId, executionPolicy: null, executionState: null })
        .where(eq(issues.id, sourceIssueId));
      const app = createApp({ type: "board", source: "local_implicit", userId: "board-user" });
      const done = await request(app).patch(`/api/issues/${sourceIssueId}`).send({ status: "done" });
      expect(done.status).toBe(200);
      const policy = await request(app).patch(`/api/issues/${sourceIssueId}`).send({ executionPolicy: reviewPolicy(managerId) });
      expect(policy.status).toBe(200);
      const [after] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      expect(after!.status).toBe("done");
      expect(after!.executionPolicy).not.toBeNull();
    });

    it("lets an unrelated edit through when the locked row changed but neither row is policy-governed", async () => {
      const { coderId, sourceIssueId } = await seedCompany();
      await db.update(issues).set({ status: "in_progress", assigneeAgentId: coderId, executionPolicy: null, executionState: null })
        .where(eq(issues.id, sourceIssueId));
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let locked!: () => void;
      const lockedSignal = new Promise<void>((resolve) => { locked = resolve; });
      const writer = db.transaction(async (tx) => {
        await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, sourceIssueId)).for("update");
        locked();
        await held;
        await tx.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
      });
      await lockedSignal;
      const pending = request(createApp({ type: "board", source: "local_implicit", userId: "board-user" }))
        .patch(`/api/issues/${sourceIssueId}`).send({ title: "Renamed while blocked" }).then((response) => response);
      for (let attempt = 0; attempt < 50 && await issueRowLockWaiters() === 0; attempt += 1) await new Promise((r) => setTimeout(r, 50));
      release();
      await writer;
      expect((await pending).status).toBe(200);
      const [after] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
      expect(after!).toMatchObject({ title: "Renamed while blocked", status: "blocked" });
    });
  });

  describe("execution reconciliation admission (slice A1)", () => {
    const refusalCode = (body: any) => body?.code ?? body?.details?.code;

    async function seedAdmission() {
      const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
      const runId = randomUUID();
      await seedHeartbeatRun({ companyId, agentId: coderId, runId, issueId: sourceIssueId, status: "failed" });
      await db.update(heartbeatRuns).set({ finishedAt: new Date("2026-05-13T18:30:00.000Z") }).where(eq(heartbeatRuns.id, runId));
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
      const [action] = await db.insert(issueRecoveryActions).values({
        companyId, sourceIssueId, kind: "active_run_watchdog", status: "resolved", outcome: "blocked",
        ownerType: "board", returnOwnerAgentId: coderId, cause: "uncertain_external_action", fingerprint: runId,
        nextAction: "Preserve recorded work without replay.",
        evidence: { runId, automaticRecovery: { replay: "blocked", actionOutcome: "unknown" } },
      }).returning();
      await db.update(companies).set({ executionReconciliationAuthority: { agentIds: [managerId] } })
        .where(eq(companies.id, companyId));
      return { companyId, managerId, coderId, sourceIssueId, runId, actionId: action!.id };
    }

    type AuthorizationOptions = {
      payload?: (payload: Record<string, any>) => void;
      body?: (canonical: string) => string;
      decision?: Record<string, unknown>;
    };

    async function authorize(
      fixture: Awaited<ReturnType<typeof seedAdmission>>,
      request: any,
      options: AuthorizationOptions = {},
    ) {
      const admission = request.executionReconciliation.admission;
      const payload: Record<string, any> = {
        schema: "execution_reconciliation_authorization_v1", scope: "execute",
        companyId: fixture.companyId, issueId: fixture.sourceIssueId, runId: fixture.runId, actionId: fixture.actionId,
        expectedDigest: admission.expectedDigest,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        intent: executionReconciliationRequestIntent(request),
        evidence: { artifacts: ["comment", "commit"] },
      };
      options.payload?.(payload);
      const canonical = canonicalizeReconciliationJson(payload);
      const body = options.body ? options.body(canonical) : canonical;
      const documentId = randomUUID();
      const revisionId = randomUUID();
      await db.insert(documents).values({ id: documentId, companyId: fixture.companyId, title: "Reconciliation approval",
        format: "markdown", latestBody: body, latestRevisionId: revisionId, latestRevisionNumber: 1 });
      await db.insert(documentRevisions).values({ id: revisionId, companyId: fixture.companyId, documentId,
        revisionNumber: 1, format: "markdown", body });
      await db.insert(issueDocuments).values({ companyId: fixture.companyId, issueId: fixture.sourceIssueId, documentId,
        key: `reconciliation-${documentId.slice(0, 8)}` });
      const [decision] = await db.insert(issueDocumentDecisions).values({
        companyId: fixture.companyId, issueId: fixture.sourceIssueId, documentId, revisionId, revisionNumber: 1,
        bodySha256: sha256HexOfText(body), scope: "execution_reconciliation", outcome: "approved",
        expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000 - 60_000), actorAgentId: fixture.managerId,
        ...options.decision,
      }).returning();
      admission.authorization = { documentId, revisionId, revisionNumber: 1, bodyDigest: sha256HexOfText(body), decisionId: decision!.id };
      return { documentId, revisionId, decisionId: decision!.id, body };
    }

    async function admissionBody(fixture: Awaited<ReturnType<typeof seedAdmission>>, key: string, overrides: Record<string, unknown> = {},
      authorization: AuthorizationOptions = {}) {
      const [issue] = await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, fixture.runId));
      const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, fixture.actionId));
      const expected = buildExpectedReconciliationState({ issue: issue!, run: run!, action: action!,
        unstartedRunIds: await listUnstartedHoldRunIds(db, fixture.companyId, fixture.sourceIssueId) });
      const request = {
        actionId: fixture.actionId, outcome: "restored", sourceIssueStatus: "todo",
        executionReconciliation: {
          runId: fixture.runId, providerStopped: true, actionOutcome: "not_performed",
          outcomeEvidence: "Provider receipts confirm the action was never submitted; the stopped process has no remaining effects.",
          admission: {
            schema: "execution_reconciliation_admission_v1", idempotencyKey: key,
            expected, expectedDigest: canonicalReconciliationDigest(expected),
            authorization: null as any,
          },
        },
        ...overrides,
      };
      await authorize(fixture, request, authorization);
      return request;
    }

    const admissionApp = () => createApp({ type: "board", source: "local_implicit", userId: "board-user" },
      { executionReconciliationAdmissionForTests: true });
    const resolvePath = (issueId: string) => `/api/issues/${issueId}/recovery-actions/resolve`;
    const snapshot = async (fixture: Awaited<ReturnType<typeof seedAdmission>>) => ({
      issue: (await db.select().from(issues).where(eq(issues.id, fixture.sourceIssueId)))[0],
      action: (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, fixture.actionId)))[0],
      receipts: await db.select().from(executionReconciliationReceipts),
      wakes: await db.select().from(agentWakeupRequests),
      runs: await db.select().from(heartbeatRuns),
    });
    const refusals = () => db.select().from(activityLog).where(eq(activityLog.action, "issue.execution_reconciliation_refused"));

    it.each([null, "invalid", { version: 99 }])("reconciles with a reserved receipt but still refuses mixed ordinary work (%j)", async namespace => {
      for (const ordinaryPending of [false, true]) {
        const fixture = await seedAdmission();
        const [reserved] = await db.insert(agentWakeupRequests).values({
          companyId: fixture.companyId, agentId: fixture.coderId, source: "assignment",
          status: "deferred_issue_execution", payload: { issueId: fixture.sourceIssueId,
            _paperclipReviewerAssignmentContinuation: namespace },
        }).returning();
        const [ordinary] = ordinaryPending ? await db.insert(agentWakeupRequests).values({
          companyId: fixture.companyId, agentId: fixture.coderId, source: "automation",
          status: "deferred_issue_execution", payload: { issueId: fixture.sourceIssueId },
        }).returning() : [];
        const body = await admissionBody(fixture, `recon:namespace-${randomUUID()}`);
        const response = await request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(body);
        if (ordinaryPending) {
          expect(response.status).toBe(409);
          expect(refusalCode(response.body)).toBe("newer_execution_exists");
          expect(JSON.stringify(response.body)).toContain("pending_wake");
          expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, ordinary!.id)))[0]).toEqual(ordinary);
        } else {
          expect(response.status).toBe(200);
          expect(response.body.receipt).toMatchObject({ state: "committed", actionId: fixture.actionId });
        }
        expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, reserved.id)))[0]).toEqual(reserved);
      }
    });

    it("admits once, commits the receipt with the action, and replays the same request", async () => {
      const fixture = await seedAdmission();
      const body = await admissionBody(fixture, "recon:admit-once-0001");
      const first = await request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(body).expect(200);
      expect(first.body.issue.status).toBe("todo");
      expect(first.body.receipt).toMatchObject({ state: "committed", actionId: fixture.actionId, runId: fixture.runId });
      const receipts = await db.select().from(executionReconciliationReceipts);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.result).toMatchObject({ issueStatus: "todo", actionStatus: "resolved", continuationDelivery: "pending" });
      const after = await snapshot(fixture);
      const replay = await request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(body).expect(200);
      expect(replay.body).toMatchObject({ replayed: true, receipt: { id: receipts[0]!.id } });
      expect(await snapshot(fixture)).toEqual(after);
    });

    it("refuses a reused key with a different payload, a second key for the action, and a settled key", async () => {
      const fixture = await seedAdmission();
      const body = await admissionBody(fixture, "recon:first-admitted-1");
      await request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(body).expect(200);
      const before = await snapshot(fixture);
      const changed = structuredClone(body);
      changed.executionReconciliation.admission.authorization.decisionId = randomUUID();
      const conflict = await request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(changed).expect(409);
      expect(refusalCode(conflict.body)).toBe("idempotency_conflict");
      const otherKey = structuredClone(body);
      otherKey.executionReconciliation.admission.idempotencyKey = "recon:second-key-0001";
      const again = await request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(otherKey).expect(409);
      expect(refusalCode(again.body)).toBe("action_already_reconciled");
      expect(await snapshot(fixture)).toEqual(before);
      expect((await refusals()).map((row) => (row.details as any).code).sort())
        .toEqual(["action_already_reconciled", "idempotency_conflict"]);

      const settledFixture = await seedAdmission();
      const settledKey = "recon:settled-before-1";
      await request(admissionApp()).post(`/api/issues/${settledFixture.sourceIssueId}/recovery-actions/receipts/${settledKey}/settle`).expect(200);
      const settled = await request(admissionApp()).post(resolvePath(settledFixture.sourceIssueId))
        .send(await admissionBody(settledFixture, settledKey)).expect(409);
      expect(refusalCode(settled.body)).toBe("idempotency_key_settled");
    });

    it("refuses a changed expected state and leaves the settled hold, issue, wakes and runs untouched", async () => {
      const fixture = await seedAdmission();
      const body = await admissionBody(fixture, "recon:stale-expected-1");
      await db.update(issues).set({ monitorAttemptCount: 1 }).where(eq(issues.id, fixture.sourceIssueId));
      const before = await snapshot(fixture);
      const response = await request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(body).expect(409);
      expect(refusalCode(response.body)).toBe("expected_state_mismatch");
      expect(JSON.stringify(response.body)).toContain("\"issue\"");
      expect(await snapshot(fixture)).toEqual(before);
      const [refused] = await refusals();
      expect(refused!.details).toMatchObject({ code: "expected_state_mismatch", idempotencyKey: "recon:stale-expected-1" });
    });

    it("refuses any non-null executionState and an unfinished source run", async () => {
      const fixture = await seedAdmission();
      await db.update(issues).set({ executionState: { status: "changes_requested" } as any }).where(eq(issues.id, fixture.sourceIssueId));
      const response = await request(admissionApp()).post(resolvePath(fixture.sourceIssueId))
        .send(await admissionBody(fixture, "recon:review-state-01")).expect(409);
      expect(refusalCode(response.body)).toBe("execution_state_not_supported");

      const unfinished = await seedAdmission();
      const body = await admissionBody(unfinished, "recon:unfinished-run-1");
      await db.update(heartbeatRuns).set({ finishedAt: null }).where(eq(heartbeatRuns.id, unfinished.runId));
      const refused = await request(admissionApp()).post(resolvePath(unfinished.sourceIssueId)).send(body).expect(409);
      expect(refusalCode(refused.body)).toBe("run_not_settled");
      expect(await db.select().from(executionReconciliationReceipts)).toHaveLength(0);
    });

    describe("run, wake and recovery checks under lock (slice A3a)", () => {
      const sourceFinishedAt = new Date("2026-05-13T18:30:00.000Z");
      type Setup = (fixture: Awaited<ReturnType<typeof seedAdmission>>) => Promise<void>;
      const memberRun = (fixture: Awaited<ReturnType<typeof seedAdmission>>, values: Record<string, unknown>) =>
        db.insert(heartbeatRuns).values({ id: randomUUID(), companyId: fixture.companyId, agentId: fixture.coderId,
          invocationSource: "manual", status: "failed", ...values } as any);
      const coordinator = async (fixture: Awaited<ReturnType<typeof seedAdmission>>, values: Record<string, unknown>) => {
        await db.update(heartbeatRuns).set({ nativeIssueId: fixture.sourceIssueId }).where(eq(heartbeatRuns.id, fixture.runId));
        await db.insert(nativeRunFinalizations).values({ runId: fixture.runId, companyId: fixture.companyId,
          issueId: fixture.sourceIssueId, phase: "terminal_failure", ...values } as any);
      };
      const refusedCases: Array<[string, Setup | null, Setup | null, string, string | undefined]> = [
        ["a queued run for the task", null,
          (f) => memberRun(f, { issueId: f.sourceIssueId, status: "queued" }), "newer_execution_exists", "active_run"],
        ["a run filed elsewhere that continues the source run", null,
          (f) => memberRun(f, { retryOfRunId: f.runId, status: "scheduled_retry" }), "newer_execution_exists", "active_run"],
        ["a finished run created after the source finished", null,
          (f) => memberRun(f, { contextSnapshot: { taskId: f.sourceIssueId }, finishedAt: new Date() }), "newer_execution_exists", "newer_run"],
        ["an earlier run that finished after the source", null,
          (f) => memberRun(f, { nativeIssueId: f.sourceIssueId, createdAt: new Date("2026-05-13T17:00:00.000Z"),
            finishedAt: new Date("2026-05-13T19:00:00.000Z") }), "newer_execution_exists", "newer_run"],
        ["a pending wake for the task", null,
          (f) => db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.coderId, source: "automation",
            status: "deferred_issue_execution", payload: { issueId: f.sourceIssueId } }).then(() => undefined),
          "newer_execution_exists", "pending_wake"],
        ["another open recovery action", null,
          (f) => db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.sourceIssueId,
            kind: "active_run_watchdog", status: "escalated", ownerType: "board", returnOwnerAgentId: f.coderId,
            cause: "uncertain_external_action", fingerprint: randomUUID(), nextAction: "Review.", evidence: {} }).then(() => undefined),
          "newer_execution_exists", "recovery_action"],
        ["a coordinator that still holds a lease", null,
          (f) => coordinator(f, { leaseOwner: "controller-1" }),
          "run_not_settled", "coordinator"],
        ["a coordinator that is not in a final phase", null,
          (f) => coordinator(f, { phase: "workspace_finalizing" }),
          "run_not_settled", "coordinator"],
        ["a coordinator that names a successor run", null,
          (f) => coordinator(f, { failureDetail: { successorRunId: randomUUID() } }),
          "run_not_settled", "coordinator"],
        ["an environment lease that was not released", null,
          (f) => db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId, issueId: f.sourceIssueId,
            status: "active" } as any).then(() => undefined),
          "run_not_settled", "process_or_lease"],
        ["a source run that succeeded",
          (f) => db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.runId)).then(() => undefined),
          null, "run_not_settled", undefined],
        ["a conversation task",
          (f) => db.update(issues).set({ assigneeAgentId: f.coderId, assigneeUserId: null,
            conversationAgentId: f.coderId, conversationUserId: "board-user", conversationState: "active" })
            .where(eq(issues.id, f.sourceIssueId)).then(() => undefined),
          null, "issue_kind_not_supported", undefined],
      ];

      it.each(refusedCases)("refuses %s and writes nothing but the refusal audit", async (_name, beforeBody, afterBody, code, reason) => {
        const fixture = await seedAdmission();
        await beforeBody?.(fixture);
        const body = await admissionBody(fixture, `recon:a3a-${randomUUID().slice(0, 8)}`);
        await afterBody?.(fixture);
        const before = await snapshot(fixture);
        const response = await request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(body).expect(409);
        expect(refusalCode(response.body)).toBe(code);
        if (reason) expect(response.body.details).toMatchObject({ reason });
        expect(await snapshot(fixture)).toEqual(before);
        expect((await refusals()).map((row) => (row.details as any).code)).toEqual([code]);
        await db.delete(nativeRunFinalizations);
      });

      it("admits past an earlier finished member run and a listed unstarted hold run", async () => {
        const fixture = await seedAdmission();
        await memberRun(fixture, { issueId: fixture.sourceIssueId, createdAt: new Date("2026-05-13T17:00:00.000Z"),
          finishedAt: new Date("2026-05-13T18:00:00.000Z") });
        await memberRun(fixture, { issueId: fixture.sourceIssueId, status: "cancelled", errorCode: "execution_reconciliation_required" });
        await coordinator(fixture, {});
        const body = await admissionBody(fixture, "recon:a3a-admits-0001");
        expect(body.executionReconciliation.admission.expected.unstartedRunIds).toHaveLength(1);
        expect(sourceFinishedAt.toISOString()).toBe(body.executionReconciliation.admission.expected.run.finishedAt);
        await request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(body).expect(200);
        await db.delete(nativeRunFinalizations);
      });
    });

    describe("approval gate writers lock the task first (G2)", () => {
      const holdIssueLock = async (issueId: string) => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let locked!: () => void;
        const lockedSignal = new Promise<void>((resolve) => { locked = resolve; });
        const holder = db.transaction(async (tx) => {
          await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
          locked();
          await held;
        });
        await lockedSignal;
        return { release, holder };
      };
      const waitingOnIssueLock = async () => (await db.execute(sql`select count(*)::int as n from pg_stat_activity
        where wait_event_type = 'Lock' and query ilike '%from "issues"%for update%'`) as unknown as { n: number }[])[0]!.n;

      it.each([
        ["link", async (f: Awaited<ReturnType<typeof seedAdmission>>, approvalId: string) =>
          issueApprovalService(db).link(f.sourceIssueId, approvalId, { userId: "board-user" })],
        ["linkManyForApproval", async (f: Awaited<ReturnType<typeof seedAdmission>>, approvalId: string) =>
          issueApprovalService(db).linkManyForApproval(approvalId, [f.sourceIssueId], { userId: "board-user" })],
      ])("%s waits for an admission that holds the task row", async (_name, linkApproval) => {
        const fixture = await seedAdmission();
        const [approval] = await db.insert(approvals).values({ companyId: fixture.companyId, type: "approve_ceo_strategy",
          status: "pending", payload: {} }).returning();
        try {
          const { release, holder } = await holdIssueLock(fixture.sourceIssueId);
          const linking = linkApproval(fixture, approval!.id);
          for (let attempt = 0; attempt < 50 && await waitingOnIssueLock() === 0; attempt += 1) await new Promise((r) => setTimeout(r, 50));
          expect(await waitingOnIssueLock()).toBe(1);
          expect(await db.select().from(issueApprovals).where(eq(issueApprovals.approvalId, approval!.id))).toHaveLength(0);
          release();
          await holder;
          await linking;
          expect(await db.select().from(issueApprovals).where(eq(issueApprovals.approvalId, approval!.id))).toHaveLength(1);
        } finally {
          await db.delete(issueApprovals).where(eq(issueApprovals.companyId, fixture.companyId));
          await db.delete(approvals).where(eq(approvals.companyId, fixture.companyId));
        }
      });

      it("resubmit waits for an admission that holds a linked task row", async () => {
        const fixture = await seedAdmission();
        const [approval] = await db.insert(approvals).values({ companyId: fixture.companyId, type: "approve_ceo_strategy",
          status: "revision_requested", payload: {} }).returning();
        await db.insert(issueApprovals).values({ companyId: fixture.companyId, issueId: fixture.sourceIssueId, approvalId: approval!.id } as any);
        try {
          const { release, holder } = await holdIssueLock(fixture.sourceIssueId);
          const resubmitting = approvalService(db).resubmit(approval!.id);
          for (let attempt = 0; attempt < 50 && await waitingOnIssueLock() === 0; attempt += 1) await new Promise((r) => setTimeout(r, 50));
          expect(await waitingOnIssueLock()).toBe(1);
          expect((await db.select().from(approvals).where(eq(approvals.id, approval!.id)))[0]!.status).toBe("revision_requested");
          release();
          await holder;
          expect((await resubmitting)!.status).toBe("pending");
        } finally {
          await db.delete(issueApprovals).where(eq(issueApprovals.companyId, fixture.companyId));
          await db.delete(approvals).where(eq(approvals.companyId, fixture.companyId));
        }
      });
    });

    describe("company and owner locks before the task lock (slice A3a)", () => {
      const holdRow = async (lock: (tx: any) => Promise<unknown>, whileHeld: (tx: any) => Promise<unknown> = async () => {}) => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let locked!: () => void;
        const lockedSignal = new Promise<void>((resolve) => { locked = resolve; });
        const holder = db.transaction(async (tx) => {
          await lock(tx);
          locked();
          await held;
          await whileHeld(tx);
        });
        await lockedSignal;
        return { release, holder };
      };
      const lockWaiters = async (pattern: string) => (await db.execute(sql`select count(*)::int as n from pg_stat_activity
        where wait_event_type = 'Lock' and query ilike ${pattern}`) as unknown as { n: number }[])[0]!.n;

      it("waits for a company writer and then reads the company gate it committed", async () => {
        const fixture = await seedAdmission();
        const body = await admissionBody(fixture, "recon:a3a-company-wait1");
        const { release, holder } = await holdRow(
          (tx) => tx.select({ id: companies.id }).from(companies).where(eq(companies.id, fixture.companyId)).for("update"),
          (tx) => tx.update(companies).set({ status: "paused" }).where(eq(companies.id, fixture.companyId)),
        );
        const pending = request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(body).then((response) => response);
        for (let attempt = 0; attempt < 50 && await lockWaiters('%from "companies"%for share%') === 0; attempt += 1) await new Promise((r) => setTimeout(r, 50));
        expect(await lockWaiters('%from "companies"%for share%')).toBe(1);
        release();
        await holder;
        const response = await pending;
        expect(response.status).toBe(409);
        expect(refusalCode(response.body)).toBe("gate_closed:company_pause");
      });

      it("refuses when the owner changes between the unlocked read and the task lock", async () => {
        const fixture = await seedAdmission();
        const body = await admissionBody(fixture, "recon:a3a-owner-race-01");
        const { release, holder } = await holdRow(
          (tx) => tx.select({ id: issues.id }).from(issues).where(eq(issues.id, fixture.sourceIssueId)).for("update"),
          (tx) => tx.update(issues).set({ assigneeAgentId: fixture.managerId }).where(eq(issues.id, fixture.sourceIssueId)),
        );
        const pending = request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(body).then((response) => response);
        const issueRowSelect = 'select "id", "company_id", "conversation_agent_id"%';
        for (let attempt = 0; attempt < 50 && await lockWaiters(issueRowSelect) === 0; attempt += 1) await new Promise((r) => setTimeout(r, 50));
        expect(await lockWaiters(issueRowSelect)).toBe(1);
        release();
        await holder;
        const response = await pending;
        expect(response.status).toBe(409);
        expect(refusalCode(response.body)).toBe("concurrent_change");
        expect(await db.select().from(executionReconciliationReceipts)).toHaveLength(0);
      });
    });

    describe("delivery revalidation in the queue transaction (slice A3b)", () => {
      const admitted = async (key: string) => {
        const fixture = await seedAdmission();
        await request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(await admissionBody(fixture, key)).expect(200);
        const responsibleUserId = randomUUID();
        await db.insert(authUsers).values({ id: responsibleUserId, name: "Recovery operator",
          email: `${responsibleUserId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
        await db.update(companies).set({ defaultResponsibleUserId: responsibleUserId }).where(eq(companies.id, fixture.companyId));
        await db.update(agents).set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).where(eq(agents.id, fixture.coderId));
        return fixture;
      };
      const deliver = () => deliverReconciledExecutions(db, heartbeatService(db, { runtimeEnv: {} }).wakeup);
      const actionRow = async (actionId: string) =>
        (await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, actionId)))[0]!;
      const reconciliationWakes = (actionId: string) => db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.idempotencyKey, `execution-reconciliation:${actionId}`));

      it("delivers an admitted reconciliation once and marks it delivered in the same commit", async () => {
        const fixture = await admitted("recon:a3b-deliver-0001");
        await deliver();
        await deliver();
        const wakes = await reconciliationWakes(fixture.actionId);
        expect(wakes).toHaveLength(1);
        const action = await actionRow(fixture.actionId);
        expect(action.evidence).toMatchObject({ continuationDelivery: "delivered", continuationRunId: wakes[0]!.runId });
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wakes[0]!.runId!));
        expect(run!.retryOfRunId).toBe(fixture.runId);
      });

      it("records waiting for a closed gate without a wake or run, then delivers after the gate opens", async () => {
        const fixture = await admitted("recon:a3b-waiting-00001");
        const [interaction] = await db.insert(issueThreadInteractions).values({ companyId: fixture.companyId,
          issueId: fixture.sourceIssueId, kind: "request_confirmation", payload: {} as any }).returning();
        const runsBefore = await db.select().from(heartbeatRuns);
        await deliver();
        const waiting = await actionRow(fixture.actionId);
        expect(waiting.evidence).toMatchObject({ continuationDelivery: "waiting", continuationWait: { gate: "interaction", attempts: 1 } });
        expect(new Date((waiting.evidence as any).continuationWait.recheckAt).getTime()).toBeGreaterThan(Date.now());
        expect(await reconciliationWakes(fixture.actionId)).toHaveLength(0);
        expect(await db.select().from(heartbeatRuns)).toHaveLength(runsBefore.length);

        await deliver();
        expect((await actionRow(fixture.actionId)).evidence).toMatchObject({ continuationWait: { attempts: 1 } });

        await db.update(issueThreadInteractions).set({ status: "answered" }).where(eq(issueThreadInteractions.id, interaction!.id));
        await db.update(issueRecoveryActions).set({
          evidence: sql`jsonb_set(${issueRecoveryActions.evidence}, '{continuationWait,recheckAt}', to_jsonb(${new Date(Date.now() - 1000).toISOString()}::text))`,
        }).where(eq(issueRecoveryActions.id, fixture.actionId));
        await deliver();
        const delivered = await actionRow(fixture.actionId);
        expect(delivered.evidence).toMatchObject({ continuationDelivery: "delivered" });
        expect(await reconciliationWakes(fixture.actionId)).toHaveLength(1);
      });

      it.each([
        ["company paused", (f: Awaited<ReturnType<typeof seedAdmission>>) => db.update(companies)
          .set({ status: "paused" }).where(eq(companies.id, f.companyId)), "company_pause"],
        ["agent paused", (f: Awaited<ReturnType<typeof seedAdmission>>) => db.update(agents)
          .set({ status: "paused" }).where(eq(agents.id, f.coderId)), "agent_pause"],
        ["on-demand wakes off", (f: Awaited<ReturnType<typeof seedAdmission>>) => db.update(agents)
          .set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, wakeOnDemand: false } } }).where(eq(agents.id, f.coderId)), "wake_policy"],
      ])("records waiting instead of dropping the wake before the queue transaction when %s", async (_name, change, gate) => {
        const fixture = await admitted(`recon:a3b-pretx-${randomUUID().slice(0, 8)}`);
        await change(fixture);
        const runsBefore = (await db.select().from(heartbeatRuns)).length;
        await deliver();
        expect((await actionRow(fixture.actionId)).evidence).toMatchObject({
          continuationDelivery: "waiting", continuationWait: { gate },
        });
        expect(await reconciliationWakes(fixture.actionId)).toHaveLength(0);
        expect(await db.select().from(heartbeatRuns)).toHaveLength(runsBefore);
      });

      it.each([
        ["a review state", (f: Awaited<ReturnType<typeof seedAdmission>>) => db.update(issues)
          .set({ executionState: { status: "pending" } as any }).where(eq(issues.id, f.sourceIssueId)), "stage_changed"],
        ["a newer run", (f: Awaited<ReturnType<typeof seedAdmission>>) => db.insert(heartbeatRuns).values({ id: randomUUID(),
          companyId: f.companyId, agentId: f.coderId, invocationSource: "manual", status: "failed", issueId: f.sourceIssueId,
          finishedAt: new Date() } as any), "newer_run"],
        ["a missing receipt", (f: Awaited<ReturnType<typeof seedAdmission>>) => db.delete(executionReconciliationReceipts)
          .where(eq(executionReconciliationReceipts.actionId, f.actionId)), "receipt_missing"],
        ["a receipt that no longer matches the action", (f: Awaited<ReturnType<typeof seedAdmission>>) => db.update(issueRecoveryActions)
          .set({ evidence: sql`jsonb_set(${issueRecoveryActions.evidence}, '{executionReconciliation,authorizationPayloadDigest}', '"0000"'::jsonb)` })
          .where(eq(issueRecoveryActions.id, f.actionId)), "receipt_mismatch"],
        ["an archived company", (f: Awaited<ReturnType<typeof seedAdmission>>) => db.update(companies)
          .set({ status: "archived" }).where(eq(companies.id, f.companyId)), "company_inactive"],
        ["a terminated owner", (f: Awaited<ReturnType<typeof seedAdmission>>) => db.update(agents)
          .set({ status: "terminated" }).where(eq(agents.id, f.coderId)), "owner_not_invokable"],
      ])("invalidates delivery after %s without a wake or run", async (_name, change, reason) => {
        const fixture = await admitted(`recon:a3b-inval-${randomUUID().slice(0, 8)}`);
        await change(fixture);
        await deliver();
        expect((await actionRow(fixture.actionId)).evidence).toMatchObject({
          continuationDelivery: "invalidated", continuationInvalidatedReason: reason,
        });
        expect(await reconciliationWakes(fixture.actionId)).toHaveLength(0);
      });

      it.each([
        ["the owner is cleared", (f: Awaited<ReturnType<typeof seedAdmission>>) => db.update(issues)
          .set({ assigneeAgentId: null }).where(eq(issues.id, f.sourceIssueId)), "owner_mismatch"],
        ["the task is reassigned", (f: Awaited<ReturnType<typeof seedAdmission>>) => db.update(issues)
          .set({ assigneeAgentId: f.managerId }).where(eq(issues.id, f.sourceIssueId)), "owner_mismatch"],
        ["the task is done", (f: Awaited<ReturnType<typeof seedAdmission>>) => db.update(issues)
          .set({ status: "done" }).where(eq(issues.id, f.sourceIssueId)), "issue_closed"],
        ["the task is cancelled", (f: Awaited<ReturnType<typeof seedAdmission>>) => db.update(issues)
          .set({ status: "cancelled" }).where(eq(issues.id, f.sourceIssueId)), "issue_closed"],
        ["the return owner is gone", (f: Awaited<ReturnType<typeof seedAdmission>>) => db.update(issueRecoveryActions)
          .set({ returnOwnerAgentId: null }).where(eq(issueRecoveryActions.id, f.actionId)), "owner_missing"],
      ])("persists invalidation when %s instead of leaving delivery pending", async (_name, change, reason) => {
        const fixture = await admitted(`recon:a3b-exit-${randomUUID().slice(0, 8)}`);
        await change(fixture);
        const runsBefore = (await db.select().from(heartbeatRuns)).length;
        await deliver();
        const invalidated = await actionRow(fixture.actionId);
        expect(invalidated.evidence).toMatchObject({
          continuationDelivery: "invalidated", continuationInvalidatedReason: reason,
        });
        expect(await reconciliationWakes(fixture.actionId)).toHaveLength(0);
        expect(await db.select().from(heartbeatRuns)).toHaveLength(runsBefore);

        await deliver();
        expect((await actionRow(fixture.actionId)).evidence).toEqual(invalidated.evidence);
        expect(await reconciliationWakes(fixture.actionId)).toHaveLength(0);
        expect(await db.select().from(heartbeatRuns)).toHaveLength(runsBefore);
      });
    });

    describe("gates on locked rows (slice A3a)", () => {
      type Fixture = Awaited<ReturnType<typeof seedAdmission>>;
      type Setup = (fixture: Fixture) => Promise<unknown>;
      const otherRun = async (f: Fixture) => {
        const id = randomUUID();
        await db.insert(heartbeatRuns).values({ id, companyId: f.companyId, agentId: f.managerId, invocationSource: "manual", status: "running" });
        return id;
      };
      const cases: Array<[string, Setup | null, Setup | null]> = [
        ["dependency", null, async (f) => {
          const [blocker] = await db.insert(issues).values({ companyId: f.companyId, title: "Blocker", status: "in_progress", priority: "medium" }).returning();
          await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blocker!.id, relatedIssueId: f.sourceIssueId, type: "blocks" });
        }],
        ["interaction", null, (f) => db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.sourceIssueId,
          kind: "request_confirmation", payload: {} as any })],
        ["approval", null, async (f) => {
          const [approval] = await db.insert(approvals).values({ companyId: f.companyId, type: "approve_ceo_strategy", status: "revision_requested", payload: {} }).returning();
          await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.sourceIssueId, approvalId: approval!.id } as any);
        }],
        ["subtree_pause", null, (f) => db.insert(issueTreeHolds).values({ companyId: f.companyId, rootIssueId: f.sourceIssueId,
          mode: "pause", status: "active", releasePolicy: {} })],
        ["project_pause", async (f) => {
          const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Paused project" }).returning();
          await db.update(issues).set({ projectId: project!.id }).where(eq(issues.id, f.sourceIssueId));
        }, async (f) => {
          await db.update(projects).set({ pausedAt: new Date() }).where(eq(projects.companyId, f.companyId));
        }],
        ["budget", null, async (f) => {
          await db.insert(budgetPolicies).values({ companyId: f.companyId, scopeType: "agent", scopeId: f.coderId,
            metric: "billed_cents", windowKind: "lifetime", amount: 1, hardStopEnabled: true, notifyEnabled: false } as any);
          await db.insert(costEvents).values({ companyId: f.companyId, agentId: f.coderId, provider: "test", biller: "test",
            billingType: "metered_api", model: "budget-fixture", costCents: 500, occurredAt: new Date() } as any);
        }],
        ["company_pause", null, (f) => db.update(companies).set({ status: "paused" }).where(eq(companies.id, f.companyId))],
        ["agent_pause", null, (f) => db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.coderId))],
        ["monitor", (f) => db.update(issues).set({ monitorNextCheckAt: new Date(Date.now() + 60 * 60 * 1000) })
          .where(eq(issues.id, f.sourceIssueId)), null],
        ["workspace", null, (f) => db.update(issues).set({ workspacePendingSelection: { mode: "isolated_workspace" } as any })
          .where(eq(issues.id, f.sourceIssueId))],
        ["checkout", null, async (f) => {
          const runId = await otherRun(f);
          await db.update(issues).set({ checkoutRunId: runId }).where(eq(issues.id, f.sourceIssueId));
        }],
        ["owner", (f) => db.update(issueRecoveryActions).set({ returnOwnerAgentId: f.managerId })
          .where(eq(issueRecoveryActions.id, f.actionId)), null],
      ];

      it.each(cases)("refuses gate_closed:%s and writes nothing but the refusal audit", async (gate, beforeBody, afterBody) => {
        const fixture = await seedAdmission();
        try {
          await beforeBody?.(fixture);
          const body = await admissionBody(fixture, `recon:gate-${gate}`.slice(0, 40).padEnd(16, "0"));
          await afterBody?.(fixture);
          const before = await snapshot(fixture);
          const response = await request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(body).expect(409);
          expect(refusalCode(response.body)).toBe(`gate_closed:${gate}`);
          expect(await snapshot(fixture)).toEqual(before);
          expect((await refusals()).map((row) => (row.details as any).code)).toEqual([`gate_closed:${gate}`]);
        } finally {
          await db.update(issues).set({ projectId: null, checkoutRunId: null }).where(eq(issues.companyId, fixture.companyId));
          await db.delete(issueApprovals).where(eq(issueApprovals.companyId, fixture.companyId));
          await db.delete(approvals).where(eq(approvals.companyId, fixture.companyId));
          await db.delete(issueTreeHolds).where(eq(issueTreeHolds.companyId, fixture.companyId));
          await db.delete(projects).where(eq(projects.companyId, fixture.companyId));
          await db.delete(budgetPolicies).where(eq(budgetPolicies.companyId, fixture.companyId));
        }
      });
    });

    it("rejects a non-integer number in the request with 400 before hashing and audits the refusal", async () => {
      const fixture = await seedAdmission();
      const body = await admissionBody(fixture, "recon:fraction-number-1");
      (body.executionReconciliation.admission.expected.issue as any).executionPolicy = { weight: 1.5 };
      const before = await snapshot(fixture);
      await request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(body).expect(400);
      expect(await snapshot(fixture)).toEqual(before);
      const audited = await refusals();
      expect(audited).toHaveLength(1);
      expect(audited[0]!.details).toMatchObject({ code: "http_400", requestDigest: null, idempotencyKey: "recon:fraction-number-1" });
    });

    it.each([
      ["top-level", (text: string) => text.replace(/^\{/, '{"resolutionNote":"first",'), "resolutionNote"],
      ["nested", (text: string) => text.replace('"providerStopped":true', '"providerStopped":true,"providerStopped":true'), "providerStopped"],
    ])("rejects a %s duplicate JSON key with 400 and writes nothing but the refusal audit", async (_name, duplicate, key) => {
      const fixture = await seedAdmission();
      const body = await admissionBody(fixture, `recon:duplicate-${key}`.slice(0, 40), { resolutionNote: "last" });
      const raw = duplicate(JSON.stringify(body));
      expect(raw).not.toBe(JSON.stringify(body));
      const before = await snapshot(fixture);
      const response = await request(admissionApp()).post(resolvePath(fixture.sourceIssueId))
        .set("content-type", "application/json").send(raw).expect(400);
      expect(response.body.error).toContain(key);
      expect(await snapshot(fixture)).toEqual(before);
      const audited = await refusals();
      expect(audited).toHaveLength(1);
      expect(audited[0]!.details).toMatchObject({ code: "http_400", requestDigest: null });
    });

    it("admits exactly once when identical requests race on the same key", async () => {
      const fixture = await seedAdmission();
      const body = await admissionBody(fixture, "recon:concurrent-same-1");
      const app = admissionApp();
      const responses = await Promise.all([1, 2, 3].map(() => request(app).post(resolvePath(fixture.sourceIssueId)).send(body)));
      expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
      expect(responses.filter((response) => response.body.replayed === true)).toHaveLength(2);
      expect(await db.select().from(executionReconciliationReceipts)).toHaveLength(1);
    });

    it("answers a lost response from the receipt: read returns committed and a retry replays it", async () => {
      const fixture = await seedAdmission();
      const key = "recon:lost-response-01";
      const body = await admissionBody(fixture, key);
      await request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(body).expect(200);
      const read = await request(admissionApp()).get(`/api/issues/${fixture.sourceIssueId}/recovery-actions/receipts/${key}`).expect(200);
      expect(read.body.state).toBe("committed");
      const settle = await request(admissionApp()).post(`/api/issues/${fixture.sourceIssueId}/recovery-actions/receipts/${key}/settle`).expect(200);
      expect(settle.body.state).toBe("committed");
      const retry = await request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(body).expect(200);
      expect(retry.body.replayed).toBe(true);
    });

    describe("authorization binding (slice A2)", () => {
      const refuse = async (fixture: Awaited<ReturnType<typeof seedAdmission>>, body: any) => {
        const before = await snapshot(fixture);
        const priorAuditIds = new Set((await refusals()).map(row => row.id));
        const response = await request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(body).expect(409);
        expect(await snapshot(fixture)).toEqual(before);
        const audited = (await refusals()).filter(row => !priorAuditIds.has(row.id) && row.companyId === fixture.companyId && row.entityId === fixture.sourceIssueId);
        expect(audited).toHaveLength(1);
        expect(audited[0]!.details).toMatchObject({ code: refusalCode(response.body) });
        return response.body;
      };

      it("records the payload digest and the exact approval in the receipt and the action evidence", async () => {
        const fixture = await seedAdmission();
        const body = await admissionBody(fixture, "recon:a2-admit-000001");
        const auth = body.executionReconciliation.admission.authorization;
        await request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(body).expect(200);
        const [receipt] = await db.select().from(executionReconciliationReceipts);
        expect(receipt).toMatchObject({ authorizationPayloadDigest: auth.bodyDigest, authorizationRevisionId: auth.revisionId,
          authorizationDecisionId: auth.decisionId, authorizationBodySha256: auth.bodyDigest,
          authorizationEvidence: { artifacts: ["comment", "commit"] } });
        const [action] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, fixture.actionId));
        expect((action!.evidence as any).executionReconciliation).toMatchObject({
          authorizationPayloadDigest: auth.bodyDigest, admission: { authorization: auth } });
      });

      it("refuses an empty authority list and a decision by an actor that is not on the list", async () => {
        const empty = await seedAdmission();
        const body = await admissionBody(empty, "recon:a2-no-authority1");
        await db.update(companies).set({ executionReconciliationAuthority: { agentIds: [] } }).where(eq(companies.id, empty.companyId));
        expect(refusalCode(await refuse(empty, body))).toBe("authority_not_configured");

        const outsider = await seedAdmission();
        const outsiderBody = await admissionBody(outsider, "recon:a2-outsider-0001", {}, { decision: { actorAgentId: outsider.coderId } });
        const refused = await refuse(outsider, outsiderBody);
        expect(refused).toMatchObject({ details: { code: "authorization_invalid", reason: "actor_not_authorized" } });
      });

      it("refuses an approval that a newer revision replaced before admission", async () => {
        const fixture = await seedAdmission();
        const body = await admissionBody(fixture, "recon:a2-newer-revision");
        const { documentId } = body.executionReconciliation.admission.authorization;
        const [r2] = await db.insert(documentRevisions).values({ companyId: fixture.companyId, documentId, revisionNumber: 2,
          format: "markdown", body: "{}" }).returning();
        await db.update(documents).set({ latestRevisionId: r2!.id, latestRevisionNumber: 2, latestBody: "{}" })
          .where(eq(documents.id, documentId));
        expect(refusalCode(await refuse(fixture, body))).toBe("authorization_stale");
      });

      it("keeps a committed receipt when a newer revision arrives after admission", async () => {
        const fixture = await seedAdmission();
        const body = await admissionBody(fixture, "recon:a2-revision-after");
        const { documentId } = body.executionReconciliation.admission.authorization;
        await request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(body).expect(200);
        const [r2] = await db.insert(documentRevisions).values({ companyId: fixture.companyId, documentId, revisionNumber: 2,
          format: "markdown", body: "{}" }).returning();
        await db.update(documents).set({ latestRevisionId: r2!.id, latestRevisionNumber: 2 }).where(eq(documents.id, documentId));
        const replay = await request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(body).expect(200);
        expect(replay.body.replayed).toBe(true);
        expect(await db.select().from(executionReconciliationReceipts)).toHaveLength(1);
      });

      it.each([
        ["an expired decision", { decision: { expiresAt: new Date(Date.now() - 60_000) } }, "authorization_expired", undefined],
        ["an expired payload while the decision is still valid",
          { payload: (p: any) => { p.expiresAt = new Date(Date.now() - 60_000).toISOString(); } }, "authorization_expired", undefined],
        ["a payload that outlives its decision",
          { payload: (p: any) => { p.expiresAt = new Date(Date.now() + 73 * 60 * 60 * 1000).toISOString(); } },
          "authorization_invalid", "payload_outlives_decision"],
        ["a body with whitespace", { body: (text: string) => text.replace(/,/, ", ") }, "authorization_invalid", "body_not_canonical"],
        ["a fenced body", { body: (text: string) => `\`\`\`json\n${text}\n\`\`\`` }, "authorization_invalid", "body_not_canonical"],
        ["a payload with an extra key", { payload: (p: any) => { p.note = "extra"; } }, "authorization_invalid", "payload_schema"],
        ["a payload with a missing key", { payload: (p: any) => { delete p.evidence; } }, "authorization_invalid", "payload_schema"],
      ] as const)("refuses %s", async (_name, options, code, reason) => {
        const fixture = await seedAdmission();
        const body = await admissionBody(fixture, `recon:a2-${randomUUID().slice(0, 12)}`, {}, options as AuthorizationOptions);
        const refused = await refuse(fixture, body);
        expect(refusalCode(refused)).toBe(code);
        if (reason) expect(refused.details.reason).toBe(reason);
      });

      it("refuses a revoked decision and a decision for another revision", async () => {
        const revoked = await seedAdmission();
        const body = await admissionBody(revoked, "recon:a2-revoked-00001");
        const auth = body.executionReconciliation.admission.authorization;
        await db.insert(issueDocumentDecisions).values({ companyId: revoked.companyId, issueId: revoked.sourceIssueId,
          documentId: auth.documentId, revisionId: auth.revisionId, revisionNumber: 1, bodySha256: auth.bodyDigest,
          scope: "execution_reconciliation", outcome: "revoked", revokesDecisionId: auth.decisionId, actorAgentId: revoked.managerId });
        expect((await refuse(revoked, body)).details.reason).toBe("decision_revoked");

        const unlisted = await seedAdmission();
        const unlistedBody = await admissionBody(unlisted, "recon:a2-unlisted-revoke");
        const unlistedAuth = unlistedBody.executionReconciliation.admission.authorization;
        await db.insert(issueDocumentDecisions).values({ companyId: unlisted.companyId, issueId: unlisted.sourceIssueId,
          documentId: unlistedAuth.documentId, revisionId: unlistedAuth.revisionId, revisionNumber: 1, bodySha256: unlistedAuth.bodyDigest,
          scope: "execution_reconciliation", outcome: "revoked", revokesDecisionId: unlistedAuth.decisionId, actorAgentId: unlisted.coderId });
        await request(admissionApp()).post(resolvePath(unlisted.sourceIssueId)).send(unlistedBody).expect(200);

        const other = await seedAdmission();
        const otherBody = await admissionBody(other, "recon:a2-other-revision");
        const otherAuth = otherBody.executionReconciliation.admission.authorization;
        const [r0] = await db.insert(documentRevisions).values({ companyId: other.companyId, documentId: otherAuth.documentId,
          revisionNumber: 0, format: "markdown", body: "{}" }).returning();
        await db.update(issueDocumentDecisions).set({ revisionId: r0!.id }).where(eq(issueDocumentDecisions.id, otherAuth.decisionId));
        expect((await refuse(other, otherBody)).details.reason).toBe("decision_revision");
      });

      it("refuses a request whose body digest does not match the revision", async () => {
        const fixture = await seedAdmission();
        const body = await admissionBody(fixture, "recon:a2-body-digest-01");
        body.executionReconciliation.admission.authorization.bodyDigest = "c".repeat(64);
        expect((await refuse(fixture, body)).details.reason).toBe("body_digest");
      });

      it.each([
        ["outcomeEvidence", (p: any) => { p.intent.executionReconciliation.outcomeEvidence = "Another account of the stopped run and its side effects."; }, "intent"],
        ["workspaceRepairEvidence", (p: any) => { p.intent.executionReconciliation.workspaceRepairEvidence = "The retained workspace was repaired by hand."; }, "intent"],
        ["resolutionNote", (p: any) => { p.intent.resolutionNote = "approved note"; }, "intent"],
        ["outcome", (p: any) => { p.intent.outcome = "false_positive"; }, "intent"],
        ["sourceIssueStatus", (p: any) => { p.intent.sourceIssueStatus = "done"; }, "intent"],
        ["the source run", (p: any) => { p.runId = randomUUID(); }, "runId"],
        ["the expected digest", (p: any) => { p.expectedDigest = "d".repeat(64); }, "expectedDigest"],
      ] as const)("refuses a request that differs from the approved payload in %s", async (_name, change, field) => {
        const fixture = await seedAdmission();
        const body = await admissionBody(fixture, `recon:a2-${randomUUID().slice(0, 12)}`, {}, { payload: change });
        const refused = await refuse(fixture, body);
        expect(refusalCode(refused)).toBe("authorization_payload_mismatch");
        expect(refused.details.field).toBe(field);
      });

      it("treats the same key with another revision as a different request", async () => {
        const fixture = await seedAdmission();
        const body = await admissionBody(fixture, "recon:a2-same-key-rev1");
        await request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(body).expect(200);
        const changed = structuredClone(body);
        changed.executionReconciliation.admission.authorization.revisionId = randomUUID();
        const conflict = await request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(changed).expect(409);
        expect(refusalCode(conflict.body)).toBe("idempotency_conflict");
      });

      it("checks expiry after the authorization lock, so a decision that expires while admission waits is refused", async () => {
        const fixture = await seedAdmission();
        const expiresAt = new Date(Date.now() + 1500);
        const body = await admissionBody(fixture, "recon:a2-expires-on-wait", {}, {
          payload: (p: any) => { p.expiresAt = expiresAt.toISOString(); },
          decision: { expiresAt },
        });
        const { documentId } = body.executionReconciliation.admission.authorization;
        const before = await snapshot(fixture);
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let locked!: () => void;
        const lockedSignal = new Promise<void>((resolve) => { locked = resolve; });
        const holder = db.transaction(async (tx) => {
          await tx.select({ id: documents.id }).from(documents).where(eq(documents.id, documentId)).for("update");
          locked();
          await held;
        });
        await lockedSignal;
        const pending = request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(body).then((response) => response);
        const waiting = async () => (await db.execute(sql`select count(*)::int as n from pg_stat_activity
          where wait_event_type = 'Lock' and query ilike '%from "documents"%for share%'`) as unknown as { n: number }[])[0]!.n;
        for (let attempt = 0; attempt < 50 && await waiting() === 0; attempt += 1) await new Promise((r) => setTimeout(r, 50));
        expect(await waiting()).toBe(1);
        await new Promise((r) => setTimeout(r, Math.max(0, expiresAt.getTime() - Date.now()) + 200));
        release();
        await holder;
        const response = await pending;
        expect(response.status).toBe(409);
        expect(refusalCode(response.body)).toBe("authorization_expired");
        expect(await snapshot(fixture)).toEqual(before);
        const audited = await refusals();
        expect(audited.at(-1)!.details).toMatchObject({ code: "authorization_expired" });
      });

      it("waits for an in-flight authority-list change and then applies the new list", async () => {
        const fixture = await seedAdmission();
        const body = await admissionBody(fixture, "recon:a2-authority-race");
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        let locked!: () => void;
        const lockedSignal = new Promise<void>((resolve) => { locked = resolve; });
        const change = db.transaction(async (tx) => {
          await lockExecutionReconciliationAuthority(tx, fixture.companyId, "exclusive");
          await tx.update(companies).set({ executionReconciliationAuthority: { agentIds: [] } }).where(eq(companies.id, fixture.companyId));
          locked();
          await held;
        });
        await lockedSignal;
        const pending = request(admissionApp()).post(resolvePath(fixture.sourceIssueId)).send(body);
        const settled = pending.then((response) => response);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(await db.select().from(executionReconciliationReceipts)).toHaveLength(0);
        release();
        await change;
        const response = await settled;
        expect(response.status).toBe(409);
        expect(refusalCode(response.body)).toBe("authority_not_configured");
      });
    });
  });

  describe("issue document decisions", () => {
    async function seedDocument() {
      const fixture = await seedCompany();
      const documentId = randomUUID();
      const revisionId = randomUUID();
      const body = '{"schema":"example"}';
      await db.insert(documents).values({ id: documentId, companyId: fixture.companyId, format: "markdown",
        latestBody: body, latestRevisionId: revisionId, latestRevisionNumber: 1 });
      await db.insert(documentRevisions).values({ id: revisionId, companyId: fixture.companyId, documentId,
        revisionNumber: 1, format: "markdown", body });
      await db.insert(issueDocuments).values({ companyId: fixture.companyId, issueId: fixture.sourceIssueId, documentId, key: "approval" });
      return { ...fixture, documentId, revisionId, body };
    }
    const decisionsPath = (issueId: string, key = "approval") => `/api/issues/${issueId}/documents/${key}/decisions`;
    const inHours = (hours: number) => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

    it("records an approval with a server-computed digest and server-owned actor, and audits it", async () => {
      const fixture = await seedDocument();
      const response = await request(createApp({ type: "board", source: "local_implicit", userId: "board-user" }))
        .post(decisionsPath(fixture.sourceIssueId))
        .send({ outcome: "approved", revisionId: fixture.revisionId, scope: "execution_reconciliation", expiresAt: inHours(24) })
        .expect(201);
      expect(response.body).toMatchObject({ documentId: fixture.documentId, revisionId: fixture.revisionId, revisionNumber: 1,
        bodySha256: sha256HexOfText(fixture.body), outcome: "approved", actorUserId: "board-user", actorAgentId: null });
      const logged = await db.select().from(activityLog).where(eq(activityLog.action, "issue.document_decision_recorded"));
      expect(logged).toHaveLength(1);
      expect(logged[0]!.details).toMatchObject({ decisionId: response.body.id, outcome: "approved" });
    });

    it("records an agent decision with the agent and run from authentication and requires a run", async () => {
      const fixture = await seedDocument();
      const runId = randomUUID();
      await seedHeartbeatRun({ companyId: fixture.companyId, agentId: fixture.managerId, runId, issueId: fixture.sourceIssueId, status: "running" });
      const payload = { outcome: "approved", revisionId: fixture.revisionId, scope: "execution_reconciliation", expiresAt: inHours(1) };
      const withRun = await request(createApp({ type: "agent", agentId: fixture.managerId, companyId: fixture.companyId, runId, source: "agent_jwt" }))
        .post(decisionsPath(fixture.sourceIssueId)).set("X-Paperclip-Run-Id", runId).send(payload);
      expect(withRun.status).toBe(201);
      expect(withRun.body).toMatchObject({ actorAgentId: fixture.managerId, actorUserId: null, createdByRunId: runId });
      await request(createApp({ type: "agent", agentId: fixture.managerId, companyId: fixture.companyId, source: "agent_key" }))
        .post(decisionsPath(fixture.sourceIssueId)).send(payload).expect((res) => expect(res.status).toBeGreaterThanOrEqual(400));
      await request(createApp({ type: "board", source: "local_implicit" })).post(decisionsPath(fixture.sourceIssueId))
        .send({ ...payload, actorAgentId: fixture.managerId }).expect(400);
    });

    it("rejects an expiry in the past or beyond 72 hours, an unknown key and an unknown revision", async () => {
      const fixture = await seedDocument();
      const app = createApp({ type: "board", source: "local_implicit", userId: "board-user" });
      const base = { outcome: "approved", revisionId: fixture.revisionId, scope: "execution_reconciliation" };
      await request(app).post(decisionsPath(fixture.sourceIssueId)).send({ ...base, expiresAt: inHours(-1) }).expect(422);
      await request(app).post(decisionsPath(fixture.sourceIssueId)).send({ ...base, expiresAt: inHours(73) }).expect(422);
      await request(app).post(decisionsPath(fixture.sourceIssueId, "missing")).send({ ...base, expiresAt: inHours(1) }).expect(404);
      await request(app).post(decisionsPath(fixture.sourceIssueId)).send({ ...base, revisionId: randomUUID(), expiresAt: inHours(1) }).expect(404);
      expect(await db.select().from(issueDocumentDecisions)).toHaveLength(0);
    });

    it("waits for an admission that holds the document row before inserting a decision", async () => {
      const fixture = await seedDocument();
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      let locked!: () => void;
      const lockedSignal = new Promise<void>((resolve) => { locked = resolve; });
      const admission = db.transaction(async (tx) => {
        await tx.select({ id: documents.id }).from(documents).where(eq(documents.id, fixture.documentId)).for("share");
        locked();
        await held;
      });
      await lockedSignal;
      const pending = request(createApp({ type: "board", source: "local_implicit", userId: "board-user" }))
        .post(decisionsPath(fixture.sourceIssueId))
        .send({ outcome: "approved", revisionId: fixture.revisionId, scope: "execution_reconciliation", expiresAt: inHours(1) })
        .then((response) => response);
      const waiting = async () => (await db.execute(sql`select count(*)::int as n from pg_stat_activity
        where wait_event_type = 'Lock' and query ilike '%from "documents"%for update%'`) as unknown as { n: number }[])[0]!.n;
      for (let attempt = 0; attempt < 50 && await waiting() === 0; attempt += 1) await new Promise((r) => setTimeout(r, 50));
      expect(await waiting()).toBe(1);
      expect(await db.select().from(issueDocumentDecisions)).toHaveLength(0);
      release();
      await admission;
      expect((await pending).status).toBe(201);
      expect(await db.select().from(issueDocumentDecisions)).toHaveLength(1);
    });

    it("revokes only an approval of the same revision", async () => {
      const fixture = await seedDocument();
      const app = createApp({ type: "board", source: "local_implicit", userId: "board-user" });
      const approval = await request(app).post(decisionsPath(fixture.sourceIssueId))
        .send({ outcome: "approved", revisionId: fixture.revisionId, scope: "execution_reconciliation", expiresAt: inHours(1) }).expect(201);
      const [r2] = await db.insert(documentRevisions).values({ companyId: fixture.companyId, documentId: fixture.documentId,
        revisionNumber: 2, format: "markdown", body: "{}" }).returning();
      await request(app).post(decisionsPath(fixture.sourceIssueId))
        .send({ outcome: "revoked", revisionId: r2!.id, scope: "execution_reconciliation", revokesDecisionId: approval.body.id }).expect(422);
      const revoke = await request(app).post(decisionsPath(fixture.sourceIssueId))
        .send({ outcome: "revoked", revisionId: fixture.revisionId, scope: "execution_reconciliation", revokesDecisionId: approval.body.id }).expect(201);
      expect(revoke.body).toMatchObject({ outcome: "revoked", revokesDecisionId: approval.body.id, expiresAt: null });
      await request(app).post(decisionsPath(fixture.sourceIssueId))
        .send({ outcome: "revoked", revisionId: fixture.revisionId, scope: "execution_reconciliation", revokesDecisionId: revoke.body.id }).expect(422);
    });
  });

  async function seedReconciledDelivery() {
    const fixture = await seedCompany();
    const { companyId, coderId, sourceIssueId } = fixture;
    const responsibleUserId = randomUUID();
    await db.insert(authUsers).values({
      id: responsibleUserId,
      name: "Recovery operator",
      email: `${responsibleUserId}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db
      .update(companies)
      .set({ defaultResponsibleUserId: responsibleUserId })
      .where(eq(companies.id, companyId));
    await db
      .update(agents)
      .set({ runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } })
      .where(eq(agents.id, coderId));
    const previousRunId = randomUUID();
    await seedHeartbeatRun({
      companyId,
      agentId: coderId,
      runId: previousRunId,
      issueId: sourceIssueId,
      status: "failed",
    });
    // Occupy the agent's only dispatch slot, independently of this issue. These
    // tests exercise real wake admission, but cannot launch a provider process.
    await seedHeartbeatRun({
      companyId,
      agentId: coderId,
      runId: randomUUID(),
      status: "running",
    });
    const [action] = await db
      .insert(issueRecoveryActions)
      .values({
        companyId,
        sourceIssueId,
        kind: "active_run_watchdog",
        status: "resolved",
        outcome: "restored",
        ownerType: "board",
        returnOwnerAgentId: coderId,
        cause: "uncertain_external_action",
        fingerprint: previousRunId,
        nextAction: "Continue from the verified reconciliation.",
        evidence: {
          runId: previousRunId,
          continuationDelivery: "pending",
          executionReconciliation: {
            runId: previousRunId,
            providerStopped: true,
            actionOutcome: "not_performed",
            outcomeEvidence: "Verified absent provider effect.",
          },
        },
      })
      .returning();
    return {
      ...fixture,
      previousRunId,
      action: action!,
      heartbeat: heartbeatService(db, { runtimeEnv: {} }),
    };
  }

  it("delivers a reconciled execution once across concurrent sweeps without a deferred duplicate", async () => {
    const { action, heartbeat } = await seedReconciledDelivery();
    let entered = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wake: typeof heartbeat.wakeup = async (...args) => {
      entered += 1;
      if (entered === 2) release();
      await bothEntered;
      return heartbeat.wakeup(...args);
    };
    await Promise.all([
      deliverReconciledExecutions(db, wake),
      deliverReconciledExecutions(db, wake),
    ]);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        eq(
          agentWakeupRequests.idempotencyKey,
          `execution-reconciliation:${action.id}`,
        ),
      );
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ status: "queued" });
    const [receipt] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(receipt!.evidence).toMatchObject({
      continuationDelivery: "delivered",
      continuationRunId: wakes[0]!.runId,
    });
  });

  it("reconciles a lost wake acknowledgement after the exact successor has already finished", async () => {
    const { action, heartbeat, companyId, previousRunId } =
      await seedReconciledDelivery();
    let successorId: string | undefined;
    await deliverReconciledExecutions(db, async (...args) => {
      const run = await heartbeat.wakeup(...args);
      expect(run).not.toBeNull();
      successorId = run!.id;
      expect(run!.retryOfRunId).toBe(previousRunId);
      throw new Error("fixture lost post-commit wake acknowledgement");
    });
    expect(successorId).toBeDefined();
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, successorId!));
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        eq(
          agentWakeupRequests.idempotencyKey,
          `execution-reconciliation:${action.id}`,
        ),
      );
    expect(wakes).toHaveLength(1);
    const [successor] = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          eq(heartbeatRuns.id, successorId!),
        ),
      );
    expect(successor).toMatchObject({
      status: "succeeded",
      retryOfRunId: previousRunId,
    });
    const [receipt] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(receipt!.evidence).toMatchObject({
      continuationDelivery: "delivered",
      continuationRunId: successorId,
    });
  });

  it.each(["owner", "status", "decision"] as const)(
    "rechecks the current reconciliation %s after the sweep read",
    async (changed) => {
      const { action, heartbeat, sourceIssueId, managerId } =
        await seedReconciledDelivery();
      await deliverReconciledExecutions(db, async (...args) => {
        if (changed === "owner")
          await db
            .update(issues)
            .set({ assigneeAgentId: managerId })
            .where(eq(issues.id, sourceIssueId));
        if (changed === "status")
          await db
            .update(issues)
            .set({ status: "done" })
            .where(eq(issues.id, sourceIssueId));
        if (changed === "decision")
          await db
            .update(issueRecoveryActions)
            .set({
              evidence: {
                ...action.evidence,
                executionReconciliation: {
                  ...(action.evidence.executionReconciliation as object),
                  runId: randomUUID(),
                },
              },
            })
            .where(eq(issueRecoveryActions.id, action.id));
        return heartbeat.wakeup(...args);
      });
      expect(
        await db
          .select()
          .from(agentWakeupRequests)
          .where(
            eq(
              agentWakeupRequests.idempotencyKey,
              `execution-reconciliation:${action.id}`,
            ),
          ),
      ).toHaveLength(0);
      const [receipt] = await db
        .select()
        .from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.id, action.id));
      expect(receipt!.evidence.continuationDelivery).toBe("pending");
    },
  );

  it("keeps reconciliation pending behind unrelated issue work without creating a second deferred outbox", async () => {
    const { action, heartbeat, sourceIssueId, companyId, coderId } =
      await seedReconciledDelivery();
    const occupiedRunId = randomUUID();
    await seedHeartbeatRun({
      companyId,
      agentId: coderId,
      runId: occupiedRunId,
      issueId: sourceIssueId,
      status: "queued",
    });
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    expect(
      await db
        .select()
        .from(agentWakeupRequests)
        .where(
          eq(
            agentWakeupRequests.idempotencyKey,
            `execution-reconciliation:${action.id}`,
          ),
        ),
    ).toHaveLength(0);
    const [occupied] = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, occupiedRunId));
    expect(occupied!.contextSnapshot).toEqual({ issueId: sourceIssueId });
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, occupiedRunId));
    await deliverReconciledExecutions(db, heartbeat.wakeup);
    const wakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(
        eq(
          agentWakeupRequests.idempotencyKey,
          `execution-reconciliation:${action.id}`,
        ),
      );
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.runId).not.toBe(occupiedRunId);
  });

  it("does not overwrite a newer reconciliation decision after a prior wake commits", async () => {
    const { action, heartbeat } = await seedReconciledDelivery();
    const newerEvidence = {
      ...action.evidence,
      continuationDelivery: "invalidated",
      operatorNote: "Do not continue after new evidence.",
    };
    await deliverReconciledExecutions(db, async (...args) => {
      const run = await heartbeat.wakeup(...args);
      expect(run).not.toBeNull();
      await db
        .update(issueRecoveryActions)
        .set({ evidence: newerEvidence })
        .where(eq(issueRecoveryActions.id, action.id));
      return run;
    });
    const [receipt] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(receipt!.evidence).toEqual(newerEvidence);
  });

  it("resolves an active recovery action and removes it from active projections", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Operator confirmed the source issue is complete.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "done",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "owner_completed",
      resolutionNote: "Operator confirmed the source issue is complete.",
    });
    expect(resolved.body.recoveryAction.resolvedAt).toBeTruthy();
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
    expect(
      await db
        .select()
        .from(issueInboxArchives)
        .where(eq(issueInboxArchives.issueId, sourceIssueId)),
    ).toHaveLength(1);

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["issue.updated", "issue.recovery_action_resolved"]),
    );
  });

  it.each(["ask_user_questions", "request_confirmation"] as const)("does not retry past a new pending %s", async (kind) => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "blocked", assigneeAgentId: coderId }).where(eq(issues.id, sourceIssueId));
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId, sourceIssueId, kind: "deliberate_wait_without_target", ownerType: "board",
      returnOwnerAgentId: coderId, cause: "deliberate_wait_without_target", fingerprint: "disposition:pending-interaction",
      nextAction: "Review the outcome.", wakePolicy: { type: "board_escalation" },
    });
    const [interaction] = await db.insert(issueThreadInteractions).values({
      companyId, issueId: sourceIssueId, kind, status: "pending", createdByAgentId: coderId,
      payload: kind === "request_confirmation"
        ? { version: 1, prompt: "Confirm the next step." }
        : { version: 1, questions: [{ id: "next", prompt: "Which step?", selectionMode: "single", options: [{ id: "a", label: "A" }] }] },
    }).returning();
    const wake = vi.fn(async () => null);
    const app = createApp(undefined, { recoveryActionEnqueueWakeup: wake });
    const body = { actionId: action.id, outcome: "restored", sourceIssueStatus: "todo" };
    const denied = await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(409);
    expect(denied.body.details?.code).toBe("disposition_recovery_interaction_pending");
    expect(wake).not.toHaveBeenCalled();
    expect(await db.select().from(issues).where(eq(issues.id, sourceIssueId))).toEqual([
      expect.objectContaining({ status: "blocked", assigneeAgentId: coderId }),
    ]);
    expect(await issueRecoveryActionService(db).getActiveForIssue(companyId, sourceIssueId)).toMatchObject({ id: action.id });
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interaction!.id))).toEqual([
      expect.objectContaining({ status: "pending" }),
    ]);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId))).toHaveLength(0);
    // A settled interaction must not leave a permanent retry veto.
    await db.update(issueThreadInteractions).set({ status: "resolved", resolvedAt: new Date() }).where(eq(issueThreadInteractions.id, interaction!.id));
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("retries an exhausted disposition action once, preserving the owner and audit trail", async () => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "blocked", assigneeAgentId: coderId }).where(eq(issues.id, sourceIssueId));
    const action = await issueRecoveryActionService(db).upsertSourceScoped({
      companyId, sourceIssueId, kind: "deliberate_wait_without_target", ownerType: "board",
      previousOwnerAgentId: coderId, returnOwnerAgentId: coderId, cause: "deliberate_wait_without_target",
      fingerprint: "disposition:exhausted", evidence: { terminalReason: "unchanged_source_state_exhausted", sourceAttemptCount: 2, sourceMaxAttempts: 2 },
      nextAction: "Review the outcome.", wakePolicy: { type: "board_escalation" },
    });
    const wake = vi.fn(async () => null);
    const app = createApp(undefined, { recoveryActionEnqueueWakeup: wake });
    const body = { actionId: action.id, outcome: "restored", sourceIssueStatus: "todo" };
    const first = await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect(first.body.issue).toMatchObject({ status: "todo", assigneeAgentId: coderId, activeRecoveryAction: null });
    expect(first.body.recoveryAction).toMatchObject({ id: action.id, status: "resolved", outcome: "handed_back" });
    await request(app).post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`).send(body).expect(200);
    expect(wake).toHaveBeenCalledTimes(1);
    const logs = await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId));
    expect(logs.filter(entry => entry.action === "issue.recovery_action_resolved")).toHaveLength(1);
    expect((await db.select().from(issues).where(eq(issues.id, sourceIssueId)))[0]).toMatchObject({ status: "todo", assigneeAgentId: coderId });
  });

  it("hands restored work back to the recorded return owner and records the outcome", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: coderId })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:fingerprint",
      evidence: { latestRunId: "run-1" },
      nextAction: "Repair the workspace and hand the issue back.",
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueRecoveryActionWakeup = vi.fn(async () => null);
    const resolved = await request(createApp(undefined, {
      recoveryActionEnqueueWakeup: enqueueRecoveryActionWakeup,
    }))
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Workspace repaired.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "todo",
      assigneeAgentId: coderId,
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "handed_back",
    });
    expect(enqueueRecoveryActionWakeup).toHaveBeenCalledWith(
      coderId,
      expect.objectContaining({
        reason: "issue_recovery_action_restored",
        payload: expect.objectContaining({ issueId: sourceIssueId, recoveryActionId: action.id }),
      }),
    );
  });

  it("does not enqueue a restored wake when todo status and assignee are unchanged", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "todo", assigneeAgentId: coderId })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "workspace_validation",
      ownerType: "agent",
      ownerAgentId: managerId,
      previousOwnerAgentId: coderId,
      returnOwnerAgentId: coderId,
      cause: "workspace_validation_failed",
      fingerprint: "workspace:already-restored",
      evidence: { latestRunId: "run-1" },
      nextAction: "Confirm the workspace remains healthy.",
      wakePolicy: { type: "wake_owner" },
    });

    const enqueueRecoveryActionWakeup = vi.fn(async () => null);
    await request(createApp(undefined, {
      recoveryActionEnqueueWakeup: enqueueRecoveryActionWakeup,
    }))
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Workspace was already restored.",
      })
      .expect(200);

    expect(enqueueRecoveryActionWakeup).not.toHaveBeenCalled();
  });

  it("resolves an active recovery action by returning the source issue to todo", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:try-again",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "todo",
        resolutionNote: "Try the source issue again.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "todo",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "restored",
      resolutionNote: "Try the source issue again.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
  });

  it("marks a recovery action stale when a blocked source issue is manually moved to todo", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:manual-restore",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const patched = await request(app)
      .patch(`/api/issues/${sourceIssueId}`)
      .send({ status: "todo" })
      .expect(200);

    expect(patched.body).toMatchObject({
      id: sourceIssueId,
      status: "todo",
      activeRecoveryAction: null,
    });

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Recovery action became stale because the source issue was manually moved from blocked to todo.",
    });
    expect(actionRow?.resolvedAt).toBeTruthy();
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.map((row) => row.action)).toEqual(
      expect.arrayContaining(["issue.updated", "issue.recovery_action_resolved"]),
    );
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")?.details).toMatchObject({
      source: "source_revalidation",
      trigger: "issue_update",
    });
  });

  it("folds stale recovery during read projection after the source issue reaches done", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:done-projection",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, sourceIssueId));
    const app = createApp();

    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);

    expect(detail.body).toMatchObject({
      id: sourceIssueId,
      status: "done",
      activeRecoveryAction: null,
    });
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Recovery action became stale because the source issue reached done.",
    });
    expect(actionRow?.resolvedAt).toBeTruthy();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")?.details).toMatchObject({
      source: "source_revalidation",
      trigger: "read_projection",
      recoveryActionId: action.id,
    });
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")).toMatchObject({
      actorType: "system", actorId: "recovery", agentId: null,
    });
  });

  it.each(["done", "cancelled"])("keeps one workspace owner hold across reads and sweeps of a %s task", async (status) => {
    const { companyId, coderId, sourceIssueId } = await seedCompany();
    const runId = randomUUID();
    const owner = { token: randomUUID(), hostname: "old-controller.invalid", pid: 42, processStartedAt: new Date(0).toISOString() };
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId: coderId, nativeIssueId: sourceIssueId,
      runtimeMode: "native", status: "failed", finishedAt: new Date(),
      runnerProfileJson: { nativeWorkspaceFinalizationOwner: owner },
    });
    await db.update(issues).set({ status }).where(eq(issues.id, sourceIssueId));
    const userId = "board-reader";
    const app = createApp({ type: "board", source: "local_implicit", userId });
    const copyback = vi.fn();
    const recovery = recoveryService(db, { enqueueWakeup: vi.fn(async () => null) });
    let firstAction: typeof issueRecoveryActions.$inferSelect | undefined;
    for (let tick = 0; tick < 3; tick += 1) {
      expect(await withNativeWorkspaceFinalizationOwnership({ db, companyId, runId }, copyback)).toEqual({ acquired: false });
      const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
      expect(detail.body.activeRecoveryAction).toMatchObject({
        cause: "native_workspace_finalization_owner_unverified", status: "active", attemptCount: 1,
      });
      await request(app).get(`/api/companies/${companyId}/issues?view=compact`).expect(200);
      await request(app).get(`/api/issues/${sourceIssueId}/recovery-actions`).expect(200);
      await recovery.reconcileStrandedAssignedIssues();
      const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, sourceIssueId));
      expect(actions).toHaveLength(1);
      firstAction ??= actions[0]!;
      expect(actions[0]).toEqual(firstAction);
    }
    expect(copyback).not.toHaveBeenCalled();
    expect(await issueService(db).list(companyId, { touchedByUserId: userId })).toEqual([]);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId))).toHaveLength(0);

    // Only clearing the exact physical owner receipt makes this hold stale.
    await db.update(heartbeatRuns).set({ runnerProfileJson: {} }).where(eq(heartbeatRuns.id, runId));
    const cleared = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(cleared.body.activeRecoveryAction).toBeNull();
    const rows = await db.select().from(activityLog).where(eq(activityLog.entityId, sourceIssueId));
    expect(rows).toEqual([expect.objectContaining({ actorType: "system", actorId: "recovery", action: "issue.recovery_action_resolved" })]);
    expect(await issueService(db).list(companyId, { touchedByUserId: userId })).toEqual([]);
  });

  it("keeps active recovery visible when a plain comment does not create a live path", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:plain-comment",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/comments`)
      .send({ body: "I am looking at this, but not changing the disposition." })
      .expect(201);

    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toMatchObject({
      id: action.id,
      status: "active",
    });
    const detail = await request(app).get(`/api/issues/${sourceIssueId}`).expect(200);
    expect(detail.body.activeRecoveryAction).toMatchObject({ id: action.id });
  });

  it("folds stale recovery when a structured resume comment restores todo dispatch", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:resume-comment",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/comments`)
      .send({ body: "Resume this now.", resume: true })
      .expect(201);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("todo");
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "cancelled",
      outcome: "cancelled",
      resolutionNote: "Recovery action became stale because the source issue was manually moved from blocked to todo.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();

    const activityRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.entityId, sourceIssueId));
    expect(activityRows.find((row) => row.action === "issue.recovery_action_resolved")?.details).toMatchObject({
      source: "source_revalidation",
      trigger: "comment",
      recoveryActionId: action.id,
    });
  });

  it("rejects peer-agent source issue updates that would hide another owner's recovery action", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:peer-status-update",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp({
      type: "agent",
      agentId: coderId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .patch(`/api/issues/${sourceIssueId}`)
      .send({ status: "todo" })
      .expect(403);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("blocked");
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolvedAt: null,
    });
  });

  it("rejects peer-agent recovery action resolution on a board-owned source issue", async () => {
    const { companyId, managerId, coderId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:peer-resolution",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp({
      type: "agent",
      agentId: coderId,
      companyId,
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Peer agent should not be able to clear this recovery.",
      })
      .expect(403);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("blocked");
    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolvedAt: null,
    });
  });

  it("keeps the named recovery owner from completing a board-owned source issue", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db
      .update(issues)
      .set({ status: "blocked", assigneeAgentId: null, assigneeUserId: "board-user" })
      .where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:owner-resolution",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Restore a live execution path.",
      wakePolicy: { type: "manual" },
    });
    const runId = randomUUID();
    const app = createApp({
      type: "agent",
      agentId: managerId,
      companyId,
      runId,
      source: "agent_jwt",
    });
    await seedHeartbeatRun({
      companyId,
      agentId: managerId,
      runId,
      issueId: sourceIssueId,
    });

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
        resolutionNote: "Recovery owner verified the work was intentionally completed.",
      })
      .expect(403);

    expect(resolved.body.details?.code).toBe("recovery_source_authority_required");
    const [sourceAfter, actionAfter] = await Promise.all([
      db.select().from(issues).where(eq(issues.id, sourceIssueId)).then((rows) => rows[0]),
      db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)).then((rows) => rows[0]),
    ]);
    expect(sourceAfter).toMatchObject({ status: "blocked", assigneeUserId: "board-user" });
    expect(actionAfter).toMatchObject({ status: "active", outcome: null });
  });

  it("rejects blocked recovery resolution when the source issue has no first-class blockers", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:blocked-without-blocker",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Choose a disposition with a live continuation path.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const rejected = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "blocked",
        sourceIssueStatus: "blocked",
      })
      .expect(422);

    expect(rejected.body.error).toContain("requires an unresolved first-class blocker");

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolvedAt: null,
    });
  });

  it("allows blocked recovery resolution when the source issue has an unresolved first-class blocker", async () => {
    const { companyId, managerId, sourceIssueId, prefix } = await seedCompany();
    const blockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: blockerIssueId,
      companyId,
      title: "Unblock recovery disposition",
      status: "todo",
      priority: "medium",
      assigneeAgentId: managerId,
      issueNumber: 2,
      identifier: `${prefix}-2`,
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: sourceIssueId,
      type: "blocks",
    });
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:blocked-with-blocker",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Wait for the blocker before continuing.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "blocked",
        sourceIssueStatus: "blocked",
        resolutionNote: "The source issue is explicitly blocked by a follow-up.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "blocked",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "blocked",
      resolutionNote: "The source issue is explicitly blocked by a follow-up.",
    });
    expect(await recoveryActionSvc.getActiveForIssue(companyId, sourceIssueId)).toBeNull();
  });

  it("rejects false-positive recovery resolution without an explicit source issue status", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:fingerprint",
      evidence: { latestIssueStatus: "in_progress" },
      nextAction: "Confirm whether the issue is actually stranded.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "false_positive",
        resolutionNote: "The source issue still has a live execution path.",
      })
      .expect(400);

    const [sourceIssue] = await db.select().from(issues).where(eq(issues.id, sourceIssueId));
    expect(sourceIssue?.status).toBe("in_progress");

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow).toMatchObject({
      status: "active",
      outcome: null,
      resolutionNote: null,
    });
  });

  it("allows false-positive recovery resolution to restore a blocked source issue in the same request", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, sourceIssueId));
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "issue_graph_liveness",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "issue_graph_liveness",
      fingerprint: "graph-liveness:false-positive-unblock",
      evidence: { latestIssueStatus: "blocked" },
      nextAction: "Confirm whether the issue is actually stranded.",
      wakePolicy: { type: "manual" },
    });
    const app = createApp();

    const resolved = await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "false_positive",
        sourceIssueStatus: "in_review",
        resolutionNote: "Recovery signal was stale; return to review.",
      })
      .expect(200);

    expect(resolved.body.issue).toMatchObject({
      id: sourceIssueId,
      status: "in_review",
      activeRecoveryAction: null,
    });
    expect(resolved.body.recoveryAction).toMatchObject({
      id: action.id,
      status: "resolved",
      outcome: "false_positive",
      resolutionNote: "Recovery signal was stale; return to review.",
    });
  });

  it("enforces company scope when resolving recovery actions", async () => {
    const { companyId, managerId, sourceIssueId } = await seedCompany();
    const recoveryActionSvc = issueRecoveryActionService(db);
    const action = await recoveryActionSvc.upsertSourceScoped({
      companyId,
      sourceIssueId,
      kind: "missing_disposition",
      ownerType: "agent",
      ownerAgentId: managerId,
      cause: "successful_run_missing_issue_disposition",
      fingerprint: "missing-disposition:fingerprint",
      evidence: { sourceRunId: "run-1" },
      nextAction: "Choose a valid issue disposition.",
      wakePolicy: { type: "wake_owner" },
    });
    const app = createApp({
      type: "agent",
      agentId: randomUUID(),
      companyId: randomUUID(),
      runId: randomUUID(),
      source: "agent_jwt",
    });

    await request(app)
      .post(`/api/issues/${sourceIssueId}/recovery-actions/resolve`)
      .send({
        actionId: action.id,
        outcome: "restored",
        sourceIssueStatus: "done",
      })
      .expect(404);

    const [actionRow] = await db
      .select()
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, action.id));
    expect(actionRow?.status).toBe("active");
  });

  describe("pending review resume after a verified pre-start cancelled reviewer run", () => {
    const killSpies: Array<{ mockRestore(): void }> = [];

    afterEach(async () => {
      for (const spy of killSpies.splice(0)) spy.mockRestore();
      await db.delete(chatConversations);
      await db.delete(chatEndpoints);
      await db.delete(toolConnections);
      await db.delete(toolApplications);
      await db.delete(issueApprovals);
      await db.delete(approvals);
      await db.delete(issueTreeHolds);
      await db.delete(nativeRunFinalizations);
      await db.delete(issueExecutionDecisions);
      await db.update(issues).set({ projectId: null, parentId: null });
      await db.delete(projects);
    });

    // Synthetic fixture: issue-A is in_review with a pending review stage whose
    // reviewer run-1 was cancelled before it ever started; action-1 keeps the
    // automatic no-replay hold.
    async function seedPreStartCancelledReview() {
      const fixture = await seedCompany();
      const { companyId, coderId, sourceIssueId: issueA } = fixture;
      const responsibleUserId = randomUUID();
      await db.insert(authUsers).values({
        id: responsibleUserId,
        name: "Recovery operator",
        email: `${responsibleUserId}@example.test`,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await db.update(companies).set({ defaultResponsibleUserId: responsibleUserId }).where(eq(companies.id, companyId));
      const reviewerId = randomUUID();
      await db.insert(agents).values({
        id: reviewerId,
        companyId,
        name: "Reviewer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
        permissions: {},
      });
      const stageId = randomUUID();
      const [priorDecision] = await db.insert(issueExecutionDecisions).values({
        companyId,
        issueId: issueA,
        stageId,
        stageType: "review",
        actorAgentId: reviewerId,
        outcome: "changes_requested",
        body: "Earlier review round requested changes.",
      }).returning();
      const executionState = {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerId },
        returnAssignee: { type: "agent", agentId: coderId },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: priorDecision!.id,
        lastDecisionOutcome: "changes_requested",
        changesRequestedCount: 2,
      };
      await db.update(issues).set({
        status: "in_review",
        assigneeAgentId: reviewerId,
        executionPolicy: {
          mode: "normal",
          commentRequired: true,
          stages: [{
            id: stageId,
            type: "review",
            approvalsNeeded: 1,
            participants: [{ id: randomUUID(), type: "agent", agentId: reviewerId }],
          }],
        },
        executionState,
      }).where(eq(issues.id, issueA));
      const run1 = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: run1,
        companyId,
        agentId: reviewerId,
        invocationSource: "automation",
        status: "cancelled",
        errorCode: "issue_assignee_changed",
        startedAt: null,
        processPid: null,
        processGroupId: null,
        finishedAt: new Date(),
        contextSnapshot: { issueId: issueA },
      });
      const [action1] = await db.insert(issueRecoveryActions).values({
        companyId,
        sourceIssueId: issueA,
        kind: "active_run_watchdog",
        status: "resolved",
        outcome: "blocked",
        ownerType: "board",
        returnOwnerAgentId: reviewerId,
        cause: "legacy_execution_requires_reconciliation",
        fingerprint: run1,
        nextAction: "Preserve recorded work without replay.",
        evidence: {
          runId: run1,
          automaticRecovery: { policy: "preserve_without_replay_v1", runId: run1, replay: "blocked", actionOutcome: "unknown" },
        },
        resolvedAt: new Date(),
      }).returning();
      expect(await getExecutionBlocker(db, companyId, issueA)).not.toBeNull();
      const chatRunRetries = {
        prepareFailedChatRunRetry: vi.fn(async () => ({ actionId: randomUUID(), issueId: issueA })),
        processFailedChatRunRetry: vi.fn(async () => undefined),
      };
      return {
        ...fixture,
        issueA,
        reviewerId,
        stageId,
        executionState,
        run1,
        action1: action1!,
        chatRunRetries,
        app: createApp(undefined, { chatRunRetries } as never),
      };
    }

    type ReviewFixture = Awaited<ReturnType<typeof seedPreStartCancelledReview>>;

    function resolveBody(fixture: ReviewFixture, overrides: Record<string, unknown> = {}) {
      return {
        actionId: fixture.action1.id,
        outcome: "restored",
        sourceIssueStatus: "in_review",
        executionReconciliation: {
          runId: fixture.run1,
          providerStopped: true,
          actionOutcome: "not_performed",
          outcomeEvidence: "The run was cancelled before it started; no provider process or side effects exist.",
        },
        ...overrides,
      };
    }

    async function snapshot(fixture: ReviewFixture) {
      const [issue] = await db.select().from(issues).where(eq(issues.id, fixture.issueA));
      return {
        issue: {
          status: issue!.status,
          assigneeAgentId: issue!.assigneeAgentId,
          executionState: issue!.executionState,
          executionRunId: issue!.executionRunId,
          checkoutRunId: issue!.checkoutRunId,
        },
        decisions: await db.select().from(issueExecutionDecisions)
          .where(eq(issueExecutionDecisions.issueId, fixture.issueA)),
        action: (await db.select().from(issueRecoveryActions)
          .where(eq(issueRecoveryActions.id, fixture.action1.id)))[0],
      };
    }

    async function expectUnchanged(fixture: ReviewFixture, before: Awaited<ReturnType<typeof snapshot>>) {
      expect(await snapshot(fixture)).toEqual(before);
      expect(before.action!.status).toBe("resolved");
      expect(before.action!.evidence).toHaveProperty("automaticRecovery");
      expect(await getExecutionBlocker(db, fixture.companyId, fixture.issueA)).not.toBeNull();
      const wake = vi.fn(async () => null);
      await deliverReconciledExecutions(db, wake as never);
      expect(wake).not.toHaveBeenCalled();
      expect(await db.select().from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.companyId, fixture.companyId))).toHaveLength(0);
      expect(fixture.chatRunRetries.prepareFailedChatRunRetry).not.toHaveBeenCalled();
    }

    async function expectRejected(
      fixture: ReviewFixture,
      status: number,
      code?: string,
      body: Record<string, unknown> = resolveBody(fixture),
    ) {
      const before = await snapshot(fixture);
      const response = await request(fixture.app)
        .post(`/api/issues/${fixture.issueA}/recovery-actions/resolve`)
        .send(body);
      expect(response.status).toBe(status);
      if (code) expect(response.body.details?.code ?? response.body.code).toBe(code);
      await expectUnchanged(fixture, before);
      return response;
    }

    it("keeps refusing a todo hand-back that would bypass the pending review stage", async () => {
      const fixture = await seedPreStartCancelledReview();
      // Handing back to todo would bypass the pending review, so that gate correctly refuses it.
      await expectRejected(fixture, 409, "recovery_governed_stage_pending", resolveBody(fixture, { sourceIssueStatus: "todo" }));
    });

    it("clears the hold and wakes the current reviewer without touching the review stage", async () => {
      const fixture = await seedPreStartCancelledReview();
      const before = await snapshot(fixture);
      const response = await request(fixture.app)
        .post(`/api/issues/${fixture.issueA}/recovery-actions/resolve`)
        .send(resolveBody(fixture))
        .expect(200);
      expect(response.body.issue.status).toBe("in_review");
      const after = await snapshot(fixture);
      expect(after.issue).toEqual(before.issue);
      expect(after.issue.executionState).toEqual(fixture.executionState);
      expect(after.decisions).toEqual(before.decisions);
      expect(after.action!.evidence).not.toHaveProperty("automaticRecovery");
      expect(after.action!.evidence).toMatchObject({
        executionReconciliation: { runId: fixture.run1, actionOutcome: "not_performed" },
        continuationDelivery: "pending",
      });
      expect(await getExecutionBlocker(db, fixture.companyId, fixture.issueA)).toBeNull();
      expect(fixture.chatRunRetries.prepareFailedChatRunRetry).not.toHaveBeenCalled();

      // A duplicate request neither reopens the action nor re-arms delivery.
      await request(fixture.app)
        .post(`/api/issues/${fixture.issueA}/recovery-actions/resolve`)
        .send(resolveBody(fixture))
        .expect(200);
      expect((await snapshot(fixture)).action).toEqual(after.action);

      // Occupy the reviewer's only slot so the wake is admitted without launching a provider.
      await seedHeartbeatRun({ companyId: fixture.companyId, agentId: fixture.reviewerId, runId: randomUUID(), status: "running" });
      const heartbeat = heartbeatService(db, { runtimeEnv: {} });
      await deliverReconciledExecutions(db, heartbeat.wakeup);
      await deliverReconciledExecutions(db, heartbeat.wakeup);
      const wakes = await db.select().from(agentWakeupRequests).where(
        eq(agentWakeupRequests.idempotencyKey, `execution-reconciliation:${fixture.action1.id}`),
      );
      expect(wakes).toHaveLength(1);
      expect(wakes[0]!.agentId).toBe(fixture.reviewerId);
      expect((await snapshot(fixture)).issue.executionState).toEqual(fixture.executionState);
    });

    function stubProcessKill(code: string) {
      const spy = vi.spyOn(process, "kill").mockImplementation((() => {
        throw Object.assign(new Error(code), { code });
      }) as never);
      killSpies.push(spy);
    }

    async function patchExecutionState(fixture: ReviewFixture, patch: Record<string, unknown> | null) {
      await db.update(issues).set({ executionState: patch && { ...fixture.executionState, ...patch } })
        .where(eq(issues.id, fixture.issueA));
    }

    async function seedOtherRun(fixture: ReviewFixture) {
      const runId = randomUUID();
      await seedHeartbeatRun({ companyId: fixture.companyId, agentId: fixture.coderId, runId, issueId: fixture.issueA, status: "queued" });
      return runId;
    }

    type Counterexample = {
      setup: (fixture: ReviewFixture) => Promise<{ body?: Record<string, unknown>; app?: ReturnType<typeof createApp> } | void>;
      status: number;
      code?: string;
      message?: RegExp;
    };

    const unverified = { status: 409, code: "recovery_review_resume_unverified" };
    const counterexamples: Record<string, Counterexample> = {
      "N1 the run started": {
        setup: async (f) => { await db.update(heartbeatRuns).set({ startedAt: new Date() }).where(eq(heartbeatRuns.id, f.run1)); },
        ...unverified,
      },
      "N2 the run recorded a process": {
        setup: async (f) => {
          stubProcessKill("ESRCH");
          await db.update(heartbeatRuns).set({ processPid: 424242 }).where(eq(heartbeatRuns.id, f.run1));
        },
        ...unverified,
      },
      "N3 the run recorded a process group": {
        setup: async (f) => {
          stubProcessKill("ESRCH");
          await db.update(heartbeatRuns).set({ processGroupId: 424242 }).where(eq(heartbeatRuns.id, f.run1));
        },
        ...unverified,
      },
      "N4 process ownership cannot be verified": {
        setup: async (f) => {
          stubProcessKill("EPERM");
          await db.update(heartbeatRuns).set({ processPid: 424242 }).where(eq(heartbeatRuns.id, f.run1));
        },
        status: 409,
        message: /process ownership cannot be verified/,
      },
      "N5 the current stage is an approval stage": {
        setup: (f) => patchExecutionState(f, { currentStageType: "approval" }),
        ...unverified,
      },
      "N6a there is no execution state": {
        setup: (f) => patchExecutionState(f, null),
        ...unverified,
      },
      "N6b the stage is not pending": {
        setup: (f) => patchExecutionState(f, { status: "changes_requested" }),
        ...unverified,
      },
      "N7 the action outcome is mixed": {
        setup: async (f) => ({
          body: resolveBody(f, { executionReconciliation: { ...resolveBody(f).executionReconciliation, actionOutcome: "mixed" } }),
        }),
        ...unverified,
      },
      "N8 the action outcome is completed": {
        setup: async (f) => ({
          body: resolveBody(f, { executionReconciliation: { ...resolveBody(f).executionReconciliation, actionOutcome: "completed" } }),
        }),
        ...unverified,
      },
      "N9a the return owner is not the assignee": {
        setup: async (f) => {
          await db.update(issueRecoveryActions).set({ returnOwnerAgentId: f.coderId }).where(eq(issueRecoveryActions.id, f.action1.id));
        },
        ...unverified,
      },
      "N9b the participant is not the run agent": {
        setup: (f) => patchExecutionState(f, { currentParticipant: { type: "agent", agentId: f.coderId } }),
        ...unverified,
      },
      "N10 the task is bound to a restricted chat conversation": {
        setup: async (f) => {
          const endpointId = randomUUID();
          const [application] = await db.insert(toolApplications).values({
            companyId: f.companyId, applicationKey: `chat:telegram:${endpointId}`, name: "Telegram", type: "chat", status: "active",
          }).returning();
          const [connection] = await db.insert(toolConnections).values({
            companyId: f.companyId, applicationId: application!.id, name: "Telegram", uid: `chat-telegram-${endpointId}`,
            connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true,
          }).returning();
          const [endpoint] = await db.insert(chatEndpoints).values({
            id: endpointId,
            companyId: f.companyId,
            connectionId: connection!.id,
            provider: "telegram",
            publicId: `endpoint-${randomUUID()}`,
            externalExecutionPolicy: "restricted",
            assignedAgentId: f.reviewerId,
          }).returning();
          await db.insert(chatConversations).values({
            companyId: f.companyId,
            endpointId: endpoint!.id,
            issueId: f.issueA,
            externalConversationId: "conversation-1",
            externalLabel: "Conversation 1",
          });
        },
        status: 409,
        code: "chat_recovery_review_resume_unsupported",
      },
      "N11 another run holds the execution lock": {
        setup: async (f) => {
          await db.update(issues).set({ executionRunId: await seedOtherRun(f) }).where(eq(issues.id, f.issueA));
        },
        status: 409,
        code: "recovery_source_run_lock",
      },
      "N12 another run holds the checkout lock": {
        setup: async (f) => {
          await db.update(issues).set({ checkoutRunId: await seedOtherRun(f) }).where(eq(issues.id, f.issueA));
        },
        status: 409,
        code: "recovery_source_run_lock",
      },
      "N13 an ancestor has an active pause hold": {
        setup: async (f) => {
          const parentId = randomUUID();
          await db.insert(issues).values({
            id: parentId, companyId: f.companyId, title: "Parent", status: "in_progress", priority: "medium",
            issueNumber: 2, identifier: `${f.prefix}-2`,
          });
          await db.update(issues).set({ parentId }).where(eq(issues.id, f.issueA));
          await db.insert(issueTreeHolds).values({ companyId: f.companyId, rootIssueId: parentId, mode: "pause", status: "active" });
        },
        status: 409,
        message: /subtree pause hold/,
      },
      "N14 the project is paused": {
        setup: async (f) => {
          const [project] = await db.insert(projects).values({ companyId: f.companyId, name: "Paused project", pausedAt: new Date() }).returning();
          await db.update(issues).set({ projectId: project!.id }).where(eq(issues.id, f.issueA));
        },
        status: 409,
        message: /^Project is paused$/,
      },
      "N15 a governed approval is pending": {
        setup: async (f) => {
          const [approval] = await db.insert(approvals).values({ companyId: f.companyId, type: "issue_review", status: "pending", payload: {} }).returning();
          await db.insert(issueApprovals).values({ companyId: f.companyId, issueId: f.issueA, approvalId: approval!.id });
        },
        status: 409,
        code: "recovery_governed_approval_pending",
      },
      "N16 the reviewer reached its budget hard-stop": {
        setup: async (f) => {
          await db.update(agents).set({ status: "paused", pauseReason: "budget" }).where(eq(agents.id, f.reviewerId));
        },
        status: 409,
        code: "recovery_safe_hand_back_budget_blocked",
      },
      "N17 a coordinator still leases the run": {
        setup: async (f) => {
          await db.update(heartbeatRuns).set({ nativeIssueId: f.issueA }).where(eq(heartbeatRuns.id, f.run1));
          await db.insert(nativeRunFinalizations).values({
            runId: f.run1, companyId: f.companyId, issueId: f.issueA, phase: "terminal_failure", leaseOwner: "controller-1",
          });
        },
        status: 409,
        message: /coordinator or a linked continuation/,
      },
      "N18 the run has a linked successor": {
        setup: async (f) => {
          await db.update(heartbeatRuns).set({ nativeIssueId: f.issueA }).where(eq(heartbeatRuns.id, f.run1));
          await db.insert(nativeRunFinalizations).values({
            runId: f.run1, companyId: f.companyId, issueId: f.issueA, phase: "terminal_failure",
            failureDetail: { successorRunId: randomUUID() },
          });
        },
        status: 409,
        message: /coordinator or a linked continuation/,
      },
      "N19 the run's environment lease is unreleased": {
        setup: async (f) => {
          await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueA, heartbeatRunId: f.run1 });
        },
        status: 409,
        message: /environment has not finished releasing/,
      },
      "N20 the actor is not the board": {
        setup: async (f) => {
          const runId = randomUUID();
          await seedHeartbeatRun({ companyId: f.companyId, agentId: f.reviewerId, runId, issueId: f.issueA, status: "running" });
          return {
            app: createApp({ type: "agent", agentId: f.reviewerId, companyId: f.companyId, runId, source: "agent_jwt" },
              { chatRunRetries: f.chatRunRetries } as never),
          };
        },
        status: 403,
        message: /^Board access required$/,
      },
    };

    it.each(Object.entries(counterexamples))("fails closed when %s", async (_name, example) => {
      const fixture = await seedPreStartCancelledReview();
      const override = (await example.setup(fixture)) ?? {};
      const response = await expectRejected(
        override.app ? { ...fixture, app: override.app } : fixture,
        example.status,
        example.code,
        override.body ?? resolveBody(fixture),
      );
      if (example.message) expect(response.body.error).toMatch(example.message);
    });
  });
});
