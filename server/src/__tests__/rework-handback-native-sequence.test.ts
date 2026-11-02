import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  executionWorkspaces,
  heartbeatRuns,
  issueExecutionDecisions,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { truncateTablesWithDeadlockRetry } from "./helpers/truncate-with-deadlock-retry.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Rework continued.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn(), hashPrivateRef: (value: string) => value }),
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  continuationSummaryParksExecutor,
  getIssueContinuationSummaryDocument,
  refreshIssueContinuationSummary,
} from "../services/issue-continuation-summary.ts";
import {
  REWORK_HANDBACK_CONTINUATION_KEY_PREFIX,
  REWORK_HANDBACK_CONTINUATION_SOURCE,
} from "../services/recovery/rework-handback-continuation.ts";

const PARK_ERROR = "issue_continuation_waiting_on_review";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping rework hand-back sequence tests: ${support.reason ?? "unsupported host"}`);

describePostgres("rework hand-back through the native review sequence", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rework-sequence-");
    db = createDb(tempDb.connectionString);
    const now = new Date();
    await db.insert(authUsers).values({
      id: "responsible-user",
      name: "Responsible User",
      email: "responsible-user@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await truncateTablesWithDeadlockRetry(
      db,
      "TRUNCATE TABLE issue_recovery_actions, issue_execution_decisions, heartbeat_run_events, heartbeat_runs, agent_wakeup_requests, issue_comments, documents, activity_log, issues, execution_workspaces, agents, company_memberships, companies RESTART IDENTITY CASCADE",
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => { (req as any).actor = actor; next(); });
    testApp.use("/api", issueRoutes(db, {} as any));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seedRunningRun(input: { companyId: string; agentId: string; issueId: string }) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "running",
      scopeKind: "issue",
      issueId: input.issueId,
      startedAt: new Date(),
      responsibleUserId: "responsible-user",
      contextSnapshot: { issueId: input.issueId, taskId: input.issueId },
    });
    await db.update(issues).set({ executionRunId: runId, checkoutRunId: runId, executionLockedAt: new Date() })
      .where(eq(issues.id, input.issueId));
    return runId;
  }

  async function finishRun(runId: string) {
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
    await db.update(issues).set({ executionRunId: null, checkoutRunId: null, executionLockedAt: null })
      .where(eq(issues.executionRunId, runId));
  }

  async function seed() {
    const companyId = randomUUID();
    const executorId = randomUUID();
    const reviewerId = randomUUID();
    const issueId = randomUUID();
    const workspaceId = randomUUID();
    const stageId = randomUUID();
    const participantId = randomUUID();
    const issuePrefix = `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "responsible-user",
      status: "active",
      membershipRole: "member",
    });
    const agentRow = (id: string, name: string) => ({
      id, companyId, name, role: "engineer" as const, status: "idle" as const,
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(agents).values([agentRow(executorId, "Executor"), agentRow(reviewerId, "Reviewer")]);
    await db.insert(executionWorkspaces).values({
      id: workspaceId,
      companyId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "rework",
      branchName: "fix/rework-sequence",
      cwd: await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-rework-sequence-ws-")),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Rework after review",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: executorId,
      responsibleUserId: "responsible-user",
      executionWorkspaceId: workspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        maxReviewRounds: null,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: participantId, type: "agent", agentId: reviewerId, userId: null }],
        }],
      },
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt: new Date(),
    });
    return { companyId, executorId, reviewerId, issueId, workspaceId, stageId, participantId };
  }

  type Seeded = Awaited<ReturnType<typeof seed>>;

  async function snapshot(seeded: Seeded) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    const [workspace] = await db.select({ branchName: executionWorkspaces.branchName }).from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, issue!.executionWorkspaceId!));
    const decisions = await db.select().from(issueExecutionDecisions)
      .where(eq(issueExecutionDecisions.issueId, seeded.issueId))
      .orderBy(asc(issueExecutionDecisions.createdAt), asc(issueExecutionDecisions.id));
    return {
      status: issue!.status,
      assigneeAgentId: issue!.assigneeAgentId,
      assigneeUserId: issue!.assigneeUserId,
      responsibleUserId: issue!.responsibleUserId,
      executionPolicy: issue!.executionPolicy,
      executionState: issue!.executionState,
      lastStatusDecisionId: issue!.lastStatusDecisionId,
      executionWorkspaceId: issue!.executionWorkspaceId,
      workspaceBranch: workspace?.branchName ?? null,
      decisions,
    };
  }

  async function reachChangesRequested(seeded: Seeded) {
    const executorRun = await seedRunningRun({ companyId: seeded.companyId, agentId: seeded.executorId, issueId: seeded.issueId });
    const submitted = await request(app({
      type: "agent", source: "agent_key", companyId: seeded.companyId, agentId: seeded.executorId, runId: executorRun,
    })).patch(`/api/issues/${seeded.issueId}`).send({ status: "done", comment: "Ready for review." });
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    const [inReview] = await db.select().from(issues).where(eq(issues.id, seeded.issueId));
    expect(inReview).toMatchObject({ status: "in_review", assigneeAgentId: seeded.reviewerId });
    expect(inReview!.executionState).toMatchObject({ status: "pending", currentParticipant: { agentId: seeded.reviewerId } });

    const [executor] = await db.select().from(agents).where(eq(agents.id, seeded.executorId));
    await finishRun(executorRun);
    const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, executorRun));
    await refreshIssueContinuationSummary({ db, issueId: seeded.issueId, run: finished!, agent: executor! });
    const reviewWait = await getIssueContinuationSummaryDocument(db, seeded.issueId);
    expect(continuationSummaryParksExecutor(reviewWait?.body)).toBe(true);

    const reviewerRun = await seedRunningRun({ companyId: seeded.companyId, agentId: seeded.reviewerId, issueId: seeded.issueId });
    const decided = await request(app({
      type: "agent", source: "agent_key", companyId: seeded.companyId, agentId: seeded.reviewerId, runId: reviewerRun,
    })).patch(`/api/issues/${seeded.issueId}`).send({ status: "in_progress", comment: "Please handle the empty input case." });
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    await finishRun(reviewerRun);

    const after = await snapshot(seeded);
    expect(after).toMatchObject({
      status: "in_progress",
      assigneeAgentId: seeded.executorId,
      responsibleUserId: "responsible-user",
      workspaceBranch: "fix/rework-sequence",
      executionState: {
        status: "changes_requested",
        currentStageId: seeded.stageId,
        returnAssignee: { type: "agent", agentId: seeded.executorId },
        changesRequestedCount: 1,
      },
    });
    expect(after.decisions).toHaveLength(1);
    expect(after.decisions[0]).toMatchObject({ outcome: "changes_requested", actorAgentId: seeded.reviewerId });
    expect((after.executionState as Record<string, unknown>).lastDecisionId).toBe(after.decisions[0]!.id);
    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    const live = await db.select({ id: heartbeatRuns.id, status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, seeded.executorId));
    expect(live.filter((run) => run.status === "queued" || run.status === "running")).toEqual([]);
    expect(await snapshot(seeded)).toEqual(after);
    return after;
  }

  it.skip("R1/R2: the executor continuation after a recorded changes_requested runs and keeps every gate", async () => {
    const seeded = await seed();
    const baseline = await reachChangesRequested(seeded);
    mockAdapterExecute.mockClear();

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.wakeup(seeded.executorId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_continuation_needed",
      payload: { issueId: seeded.issueId },
      requestedByActorType: "system",
      requestedByActorId: null,
      contextSnapshot: { issueId: seeded.issueId, taskId: seeded.issueId, wakeReason: "issue_continuation_needed" },
    });
    expect(queued).toBeTruthy();
    expect(await snapshot(seeded)).toEqual(baseline);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id));
    expect(run!.errorCode).not.toBe(PARK_ERROR);
    expect(run!.status).toBe("succeeded");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    expect(continuationSummaryParksExecutor((await getIssueContinuationSummaryDocument(db, seeded.issueId))?.body)).toBe(false);
    expect(await snapshot(seeded)).toEqual(baseline);
  });

  it.skip("R3: a parked continuation after a recorded changes_requested gets one ordinary successor and keeps every gate", async () => {
    const seeded = await seed();
    const baseline = await reachChangesRequested(seeded);
    const parkedRunId = randomUUID();
    const finishedAt = new Date();
    await db.insert(heartbeatRuns).values({
      id: parkedRunId,
      companyId: seeded.companyId,
      agentId: seeded.executorId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "cancelled",
      scopeKind: "issue",
      issueId: seeded.issueId,
      contextSnapshot: {
        issueId: seeded.issueId,
        taskId: seeded.issueId,
        wakeReason: "issue_continuation_needed",
        retryReason: "issue_continuation_needed",
      },
      finishedAt,
      createdAt: finishedAt,
      updatedAt: finishedAt,
      errorCode: PARK_ERROR,
      error: "Continuation parked: issue is waiting on review/approval",
      resultJson: { stopReason: PARK_ERROR, timeoutSource: "stale_queued_run_gate" },
    });

    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result.issueIds).toContain(seeded.issueId);
    expect(result.dispositionRepairRequeued).toBe(0);
    expect(await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.sourceIssueId, seeded.issueId),
      eq(issueRecoveryActions.kind, "deliberate_wait_without_target"),
    ))).toHaveLength(0);
    const receipts = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, seeded.executorId)))
      .filter((row) => row.idempotencyKey?.startsWith(REWORK_HANDBACK_CONTINUATION_KEY_PREFIX));
    expect(receipts).toHaveLength(1);
    const successors = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, parkedRunId));
    expect(successors).toHaveLength(1);
    expect(receipts[0]!.runId).toBe(successors[0]!.id);
    expect(successors[0]!.contextSnapshot).toMatchObject({
      source: REWORK_HANDBACK_CONTINUATION_SOURCE,
      retryOfRunId: parkedRunId,
      wakeReason: "issue_continuation_needed",
    });
    expect(await snapshot(seeded)).toEqual(baseline);
  });
});
