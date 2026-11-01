import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  runIdentityContexts,
  issueThreadInteractions,
  issueComments,
  chatActions, chatConversations, chatDeliveries, chatEndpoints, chatExternalPrincipals,
  chatIdentityLinks, chatMessageLinks, toolApplications, toolConnections,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { PROVIDER_QUOTA_MONITOR_SERVICE_NAME } from "@paperclipai/shared";
import { issueService } from "../services/issues.js";
import { applyIssueMonitorPolicyTransition, issueExecutionGeneration, normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.js";
import { chatChannelService, type ChatChannelServiceOptions } from "../services/chat-channels.js";
import { createDurableChatWakeupRequest } from "../services/durable-chat-wakeup.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { truncateTablesWithDeadlockRetry } from "./helpers/truncate-with-deadlock-retry.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async (_context: unknown) => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Addressee review dispatch test run.",
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
    `Skipping embedded Postgres addressee review dispatch tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

describeEmbeddedPostgres("pending interaction addressee dispatch during review (routes + postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const executeCallsForAgent = (agentId: string) =>
    mockAdapterExecute.mock.calls.filter(([context]) => (context as { agent?: { id?: string } })?.agent?.id === agentId);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-addressee-review-dispatch-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
  }, 30_000);

  afterEach(async () => {
    vi.unstubAllEnvs();
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await truncateTablesWithDeadlockRetry(
      db,
      `
        TRUNCATE TABLE
          "issue_thread_interactions",
          "issue_comments",
          "issues",
          "heartbeat_run_events",
          "cost_events",
          "activity_log",
          "heartbeat_runs",
          "agent_wakeup_requests",
          "agent_runtime_state",
          "company_memberships",
          "agents",
          "companies"
        RESTART IDENTITY CASCADE
      `,
      { attempts: 10, delayMs: () => 100 },
    );
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seedReviewFixture() {
    const companyId = randomUUID();
    const userId = "addressee-review-user";
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: userId,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values({
      id: userId,
      name: "Fixture user",
      email: "addressee-review-user@example.test",
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "operator",
    });
    const agentValues = (name: string, role: string) => ({
      companyId,
      name,
      role,
      status: "idle" as const,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    const [assignee, reviewer, addressee] = await db.insert(agents).values([
      agentValues("AssigneeCoder", "engineer"),
      agentValues("ReviewerCoder", "qa"),
      agentValues("AddresseeCto", "cto"),
    ]).returning();
    const executionState = {
      status: "pending",
      currentStageId: randomUUID(),
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewer!.id, userId: null },
      returnAssignee: { type: "agent", agentId: assignee!.id, userId: null },
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    };
    const [issue] = await db.insert(issues).values({
      companyId,
      title: "Question for another agent during review",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: assignee!.id,
      executionState,
    }).returning();
    const board = {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "operator" }],
      isInstanceAdmin: false,
    };
    return { companyId, issue: issue!, assignee: assignee!, reviewer: reviewer!, addressee: addressee!, board, executionState };
  }

  it("runs the addressee of a question card created over HTTP while another agent reviews the task", async () => {
    const f = await seedReviewFixture();

    const res = await request(app(f.board))
      .post(`/api/issues/${f.issue.id}/interactions`)
      .send({
        kind: "ask_user_questions",
        addresseeAgentId: f.addressee.id,
        payload: {
          version: 1,
          questions: [{ id: "scope", prompt: "Which scope?", selectionMode: "single", required: true, options: [{ id: "a", label: "A" }] }],
        },
      });
    expect(res.status).toBe(201);
    const interactionId = res.body.id as string;
    expect(res.body).toMatchObject({ status: "pending", addresseeAgentId: f.addressee.id });

    expect(await waitForCondition(async () => {
      const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.addressee.id));
      return runs.length > 0;
    })).toBe(true);
    await heartbeat.resumeQueuedRuns();
    expect(await waitForCondition(async () => executeCallsForAgent(f.addressee.id).length === 1)).toBe(true);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const runs = await db.select({
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      errorCode: heartbeatRuns.errorCode,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(runs).toEqual([
      expect.objectContaining({
        agentId: f.addressee.id,
        status: "succeeded",
        errorCode: null,
        contextSnapshot: expect.objectContaining({ wakeReason: "interaction_pending", interactionId }),
      }),
    ]);
    expect(executeCallsForAgent(f.addressee.id)).toHaveLength(1);
    expect(executeCallsForAgent(f.reviewer.id)).toHaveLength(0);
    expect(executeCallsForAgent(f.assignee.id)).toHaveLength(0);

    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    expect(issue).toMatchObject({
      status: "in_review",
      assigneeAgentId: f.assignee.id,
      executionState: { currentParticipant: { agentId: f.reviewer.id } },
    });
    const [interaction] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    expect(interaction).toMatchObject({ status: "pending", addresseeAgentId: f.addressee.id });
  });
  async function currentAgentFixture() {
    const f = await seedReviewFixture();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.assignee.id,
      status: "running", issueId: f.issue.id, scopeKind: "issue", responsibleUserId: f.board.userId,
      contextSnapshot: { issueId: f.issue.id } }).returning();
    const identity = await initializeRunIdentity(db, { companyId: f.companyId, runId: run.id,
      issueId: f.issue.id, responsibleUserId: f.board.userId, cause: "dispatch" });
    const actor: Record<string, unknown> = { type: "agent", source: "agent_jwt", companyId: f.companyId,
      agentId: f.assignee.id, runId: run.id, identityContextId: identity.id, responsibleUserId: f.board.userId };
    const body = { kind: "ask_user_questions", addresseeAgentId: f.addressee.id,
      payload: { version: 1, questions: [{ id: "scope", prompt: "Which scope?", selectionMode: "single",
        required: true, options: [{ id: "a", label: "A" }] }] } };
    return { ...f, run, actor, body };
  }

  it("uses the current agent run and accepted identity over HTTP and wakes only the addressee", async () => {
    const f = await currentAgentFixture();
    const response = await request(app(f.actor)).post(`/api/issues/${f.issue.id}/interactions`)
      .send({ ...f.body, sourceRunId: randomUUID() });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: "pending", sourceRunId: f.run.id,
      sourceIdentityContextId: f.actor.identityContextId, addresseeAgentId: f.addressee.id });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
    await heartbeat.resumeQueuedRuns();
    expect(await waitForCondition(async () => executeCallsForAgent(f.addressee.id).length === 1)).toBe(true);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(executeCallsForAgent(f.assignee.id)).toHaveLength(0);
    expect(executeCallsForAgent(f.reviewer.id)).toHaveLength(0);
  });

  it.each(["valid", "source-identity-install", "source-identity-retry", "scheduled-question"])(
    "records quota installation proof from a real admitted reviewer before monitor retry (%s)", async mode => {
    const f = await currentAgentFixture();
    const policy = normalizeIssueExecutionPolicy({ stages: [{ type: "review", participants: [{ type: "agent", agentId: f.reviewer.id }] }] })!;
    await db.update(issues).set({ status: "in_progress", executionPolicy: policy, executionState: null,
      executionRunId: f.run.id, checkoutRunId: f.run.id }).where(eq(issues.id, f.issue.id));
    const [question] = await db.insert(issueThreadInteractions).values({ companyId: f.companyId, issueId: f.issue.id,
      kind: "ask_user_questions", status: "pending", continuationPolicy: "wake_assignee", payload: f.body.payload,
      createdByAgentId: f.assignee.id }).returning();
    const execute = mockAdapterExecute.getMockImplementation()!;
    mockAdapterExecute.mockImplementation(async () => ({ exitCode: 1, signal: null, timedOut: false,
      errorMessage: "Provider usage quota reached", errorCode: "provider_quota", errorFamily: "provider_quota",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, errorFamily: "provider_quota" },
      summary: "", provider: "test", model: "test-model" }));
    try {
      const response = await request(app(f.actor)).patch(`/api/issues/${f.issue.id}`)
        .send({ status: "done", comment: "Ready for independent review" });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
      expect(await waitForCondition(async () => executeCallsForAgent(f.reviewer.id).length === 1)).toBe(true);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const sources = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.reviewer.id));
      expect(sources).toHaveLength(1);
      const source = sources[0];
      expect(source).toMatchObject({ status: "failed", errorCode: "provider_quota" });
      expect(source.activeIdentityContextId).toBeTruthy();
      const [before] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
      expect(source.contextSnapshot?.reviewerAssignmentGeneration).toBe(issueExecutionGeneration(before));
      const nextCheckAt = new Date(Date.now() + 60_000).toISOString();
      const installedPolicy = { ...normalizeIssueExecutionPolicy(before.executionPolicy)!, monitor: { nextCheckAt, scheduledBy: "assignee" as const,
        kind: "external_service" as const, serviceName: PROVIDER_QUOTA_MONITOR_SERVICE_NAME, externalRef: source.id,
        notes: null, timeoutAt: null, maxAttempts: null, recoveryPolicy: "wake_owner" as const } };
      const transition = applyIssueMonitorPolicyTransition({ issue: before, policy: installedPolicy,
        previousPolicy: normalizeIssueExecutionPolicy(before.executionPolicy), requestedStatus: before.status,
        requestedAssigneePatch: {}, actor: { agentId: null, userId: null }, monitorExplicitlyUpdated: true });
      if (mode === "source-identity-install") {
        const [foreignIdentity] = await db.select().from(runIdentityContexts)
          .where(eq(runIdentityContexts.id, String(f.actor.identityContextId)));
        expect(foreignIdentity).toMatchObject({ runId: f.run.id, status: "accepted" });
        expect(foreignIdentity.runId).not.toBe(source.id);
        await db.update(heartbeatRuns).set({ activeIdentityContextId: foreignIdentity.id }).where(eq(heartbeatRuns.id, source.id));
        await expect(issueService(db).update(f.issue.id, { ...transition.patch, executionPolicy: installedPolicy }))
          .rejects.toThrow();
        const [unchanged] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
        expect(unchanged.monitorNextCheckAt).toBeNull();
        expect((await db.select().from(activityLog).where(eq(activityLog.entityId, f.issue.id)))
          .filter(row => row.action === "issue.review_quota_monitor_installed")).toHaveLength(0);
        return;
      }
      const installed = await issueService(db).update(f.issue.id, { ...transition.patch, executionPolicy: installedPolicy });
      expect(installed).toBeTruthy();
      const proof = (await db.select().from(activityLog).where(eq(activityLog.entityId, f.issue.id)))
        .find(row => row.action === "issue.review_quota_monitor_installed");
      expect(proof).toMatchObject({ actorType: "system", actorId: "review_quota_monitor", runId: source.id,
        details: { version: 1, sourceRunId: source.id, sourceGeneration: source.contextSnapshot?.reviewerAssignmentGeneration,
          installedGeneration: issueExecutionGeneration(installed!), nextCheckAt } });
      expect(issueExecutionGeneration(installed!)).not.toBe(source.contextSnapshot?.reviewerAssignmentGeneration);
      if (mode === "scheduled-question") {
        expect(await heartbeat.tickTimers(new Date(nextCheckAt))).toMatchObject({ enqueued: 0 });
        const [held] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
        expect(held).toMatchObject({ monitorNextCheckAt: new Date(nextCheckAt), monitorWakeRequestedAt: null, monitorAttemptCount: 0 });
        expect(held.executionPolicy).toEqual(installed!.executionPolicy);
        expect(held.executionState).toEqual(installed!.executionState);
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.id))).toHaveLength(0);
        expect(executeCallsForAgent(f.reviewer.id)).toHaveLength(1);
        return;
      }
      await db.update(issueThreadInteractions).set({ status: "cancelled" }).where(eq(issueThreadInteractions.id, question.id));
      if (mode === "source-identity-retry") {
        const [foreignIdentity] = await db.select().from(runIdentityContexts)
          .where(eq(runIdentityContexts.id, String(f.actor.identityContextId)));
        expect(foreignIdentity).toMatchObject({ runId: f.run.id, status: "accepted" });
        expect(foreignIdentity.runId).not.toBe(source.id);
        await db.update(heartbeatRuns).set({ activeIdentityContextId: foreignIdentity.id }).where(eq(heartbeatRuns.id, source.id));
        await expect(heartbeat.triggerIssueMonitor(f.issue.id, { now: new Date(nextCheckAt), actorType: "user", actorId: f.board.userId }))
          .rejects.toThrow();
        const [held] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
        expect(held).toMatchObject({ monitorNextCheckAt: new Date(nextCheckAt), monitorWakeRequestedAt: null, monitorAttemptCount: 0 });
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.id))).toHaveLength(0);
        expect(executeCallsForAgent(f.reviewer.id)).toHaveLength(1);
        return;
      }
      for (const fault of ["policy", "state", "responsible", "participant", "assignee", "missing-G", "wrong-G",
        "provider-work", "native", "source-agent", "source-issue", "source-status", "proof-version", "proof-actor",
        "proof-action", "proof-source", "proof-generation", "proof-schedule", "successor"]) {
        const taskPatch = fault === "policy" ? { executionPolicy: { ...installed!.executionPolicy, maxReviewRounds: 4 } }
          : fault === "state" ? { executionState: { ...installed!.executionState, lastDecisionId: randomUUID() } }
          : fault === "responsible" ? { responsibleUserId: null }
          : fault === "participant" ? { executionState: { ...installed!.executionState, currentParticipant: { type: "agent", agentId: f.addressee.id, userId: null } } }
          : fault === "assignee" ? { assigneeAgentId: f.addressee.id } : null;
        if (taskPatch) await db.update(issues).set(taskPatch).where(eq(issues.id, f.issue.id));
        const sourceContext = { ...source.contextSnapshot };
        if (fault === "missing-G") delete sourceContext.reviewerAssignmentGeneration;
        if (fault === "wrong-G") sourceContext.reviewerAssignmentGeneration = "forged";
        if (fault === "source-issue") sourceContext.issueId = randomUUID();
        await db.update(heartbeatRuns).set({ contextSnapshot: sourceContext,
          ...(fault === "provider-work" ? { resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: true } } } : {}),
          ...(fault === "native" ? { runtimeMode: "native" } : {}),
          ...(fault === "source-agent" ? { agentId: f.addressee.id } : {}),
          ...(fault === "source-status" ? { status: "succeeded" } : {}),
        }).where(eq(heartbeatRuns.id, source.id));
        await db.update(activityLog).set({
          ...(fault === "proof-actor" ? { actorType: "agent", actorId: f.reviewer.id } : {}),
          ...(fault === "proof-action" ? { action: "issue.monitor_scheduled" } : {}),
          details: { ...proof!.details,
            ...(fault === "proof-version" ? { version: 2 } : {}),
            ...(fault === "proof-source" ? { sourceGeneration: "forged" } : {}),
            ...(fault === "proof-generation" ? { installedGeneration: "forged" } : {}),
            ...(fault === "proof-schedule" ? { nextCheckAt: new Date(0).toISOString() } : {}),
          },
        }).where(eq(activityLog.id, proof!.id));
        const [successor] = fault === "successor" ? await db.insert(heartbeatRuns).values({ companyId: f.companyId,
          agentId: f.reviewer.id, retryOfRunId: source.id, status: "cancelled", contextSnapshot: source.contextSnapshot }).returning() : [];
        try {
          await expect(heartbeat.triggerIssueMonitor(f.issue.id, { now: new Date(nextCheckAt), actorType: "user", actorId: f.board.userId }), fault).rejects.toThrow();
          const [held] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
          expect(held, fault).toMatchObject({ monitorNextCheckAt: new Date(nextCheckAt), monitorWakeRequestedAt: null, monitorAttemptCount: 0 });
          expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.id))).length, fault).toBe(successor ? 1 : 0);
          expect(executeCallsForAgent(f.reviewer.id), fault).toHaveLength(1);
        } finally {
          if (successor) await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, successor.id));
          await db.update(heartbeatRuns).set({ contextSnapshot: source.contextSnapshot, resultJson: source.resultJson,
            runtimeMode: source.runtimeMode, agentId: source.agentId, status: source.status }).where(eq(heartbeatRuns.id, source.id));
          await db.update(activityLog).set({ actorType: proof!.actorType, actorId: proof!.actorId,
            action: proof!.action, details: proof!.details }).where(eq(activityLog.id, proof!.id));
          await db.update(issues).set({ executionPolicy: installed!.executionPolicy, executionState: installed!.executionState,
            responsibleUserId: installed!.responsibleUserId, assigneeAgentId: installed!.assigneeAgentId,
            monitorNextCheckAt: installed!.monitorNextCheckAt, monitorWakeRequestedAt: null }).where(eq(issues.id, f.issue.id));
        }
      }
      const triggered = await heartbeat.triggerIssueMonitor(f.issue.id, { now: new Date(nextCheckAt), actorType: "user", actorId: f.board.userId });
      expect(triggered).toMatchObject({ outcome: "triggered" });
      const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, source.id));
      expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "execution_review_participant_recovery" });
      const [consumed] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
      expect(consumed).toMatchObject({ monitorNextCheckAt: null, monitorAttemptCount: 1 });
      const { monitor: previousMonitor, ...reviewHistory } = before.executionState!;
      expect(consumed.executionState).toMatchObject(reviewHistory);
      expect(retry.contextSnapshot?.reviewerAssignmentGeneration).toBe(issueExecutionGeneration(consumed));
      expect(retry.contextSnapshot?.reviewerAssignmentGeneration).not.toBe(source.contextSnapshot?.reviewerAssignmentGeneration);
      mockAdapterExecute.mockImplementation(async context => {
        const { runId } = context as { runId: string };
        const [currentRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const approved = await request(app({ type: "agent", source: "agent_jwt", companyId: f.companyId,
          agentId: f.reviewer.id, runId, identityContextId: currentRun.activeIdentityContextId,
          responsibleUserId: currentRun.responsibleUserId })).patch(`/api/issues/${f.issue.id}`)
          .send({ status: "done", comment: "Approved the current submission" });
        expect(approved.status, JSON.stringify(approved.body)).toBe(200);
        return execute(context);
      });
      await heartbeat.retryScheduledRetryNow({ issueId: f.issue.id, now: retry.scheduledRetryAt! });
      await heartbeat.resumeQueuedRuns();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry.id));
      expect(finished).toMatchObject({ status: "succeeded", errorCode: null });
      expect(finished.activeIdentityContextId).toBeTruthy();
      expect(executeCallsForAgent(f.reviewer.id)).toHaveLength(2);
    } finally {
      mockAdapterExecute.mockImplementation(execute);
      await db.update(issueThreadInteractions).set({ status: "cancelled" }).where(eq(issueThreadInteractions.id, question.id));
    }
  });

  it.each(["current", "stale", "missing-generation", "invalid-identity"])(
    "submits through the current-agent HTTP route and preserves recovery provenance: %s", async (mode) => {
    const f = await currentAgentFixture();
    const policy = normalizeIssueExecutionPolicy({ stages: [{ type: "review", participants: [{ type: "agent", agentId: f.reviewer.id }] }] })!;
    await db.update(issues).set({ status: "in_progress", executionPolicy: policy, executionState: null,
      executionRunId: f.run.id, checkoutRunId: f.run.id }).where(eq(issues.id, f.issue.id));
    let sourceId: string | undefined;
    let admittedGeneration: unknown;
    let settledGeneration: string | undefined;
    const execute = mockAdapterExecute.getMockImplementation()!;
    mockAdapterExecute.mockImplementation(async (context) => {
      const { runId, agent } = context as { runId: string; agent: { id: string } };
      if (agent.id === f.reviewer.id && !sourceId) {
        sourceId = runId;
        const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        const [task] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
        admittedGeneration = source.contextSnapshot?.reviewerAssignmentGeneration;
        settledGeneration = issueExecutionGeneration(task);
        if (mode === "stale") await db.update(issues).set({ executionPolicy: { ...policy, maxReviewRounds: 4 } }).where(eq(issues.id, task.id));
        if (mode === "missing-generation") {
          const contextSnapshot = { ...source.contextSnapshot };
          delete contextSnapshot.reviewerAssignmentGeneration;
          await db.update(heartbeatRuns).set({ contextSnapshot }).where(eq(heartbeatRuns.id, runId));
        }
        if (mode === "invalid-identity") await db.update(heartbeatRuns).set({ activeIdentityContextId: f.run.activeIdentityContextId ?? String(f.actor.identityContextId) })
          .where(eq(heartbeatRuns.id, runId));
      }
      return execute(context);
    });
    try {
      const response = await request(app(f.actor)).patch(`/api/issues/${f.issue.id}`)
        .send({ status: "done", comment: "Ready for independent review" });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({ status: "in_review", executionState: { status: "pending", currentParticipant: { agentId: f.reviewer.id } } });
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.run.id));
      expect(await waitForCondition(async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.reviewer.id))).length > 0)).toBe(true);
      await heartbeat.resumeQueuedRuns();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(sourceId).toBeTruthy();
      expect(typeof admittedGeneration).toBe("string");
      expect(admittedGeneration).toBe(settledGeneration);
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.reviewer.id));
      const recovery = runs.filter(run => run.contextSnapshot?.source === "issue.execution_review_recovery");
      if (mode === "missing-generation" || mode === "invalid-identity") {
        expect(recovery).toHaveLength(0);
        expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.reviewer.id))).toHaveLength(1);
      } else {
        expect(recovery).toHaveLength(1);
        expect(recovery[0].retryOfRunId).toBe(sourceId);
        expect(recovery[0].contextSnapshot?.retryOfRunId).toBe(sourceId);
        expect(recovery[0].contextSnapshot?.reviewerAssignmentGeneration).toBe(admittedGeneration);
        if (mode === "stale") {
          expect(recovery[0]).toMatchObject({ status: "cancelled", errorCode: "issue_review_participant_changed" });
          expect(executeCallsForAgent(f.reviewer.id)).toHaveLength(1);
        } else expect(executeCallsForAgent(f.reviewer.id)).toHaveLength(2);
      }
      expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, f.companyId))).toHaveLength(0);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.addressee.id))).toHaveLength(0);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.addressee.id))).toHaveLength(0);
    } finally { mockAdapterExecute.mockImplementation(execute); }
  });

  it("reauthorizes a durable failed chat request and inherits its admitted generation before stale admission", async () => {
    const f = await seedReviewFixture();
    const policy = normalizeIssueExecutionPolicy({ stages: [{ type: "review", participants: [{ type: "agent", agentId: f.reviewer.id }] }] })!;
    await db.update(issues).set({ assigneeAgentId: f.reviewer.id, executionPolicy: policy,
      executionState: { ...f.executionState, currentStageId: policy.stages[0].id } }).where(eq(issues.id, f.issue.id));
    const [application] = await db.insert(toolApplications).values({ companyId: f.companyId, name: "Chat retry", type: "chat" }).returning();
    const [connection] = await db.insert(toolConnections).values({ companyId: f.companyId, applicationId: application.id,
      name: "Chat retry", uid: randomUUID(), connectionPurpose: "channel", transport: "chat_sdk", status: "active", credentialSecretRefs: [] }).returning();
    const [endpoint] = await db.insert(chatEndpoints).values({ companyId: f.companyId, connectionId: connection.id,
      provider: "telegram", publicId: randomUUID(), assignedAgentId: f.reviewer.id, status: "active", setup: { step: "complete" } }).returning();
    const [principal] = await db.insert(chatExternalPrincipals).values({ companyId: f.companyId, provider: "telegram",
      providerAccountId: "fixture", externalId: "12345" }).returning();
    await db.insert(chatIdentityLinks).values({ companyId: f.companyId, endpointId: endpoint.id,
      principalId: principal.id, paperclipUserId: f.board.userId, status: "linked" });
    const [conversation] = await db.insert(chatConversations).values({ companyId: f.companyId, endpointId: endpoint.id,
      issueId: f.issue.id, externalConversationId: "12345", externalLabel: "Retry request", isDirectMessage: true }).returning();
    const [delivery] = await db.insert(chatDeliveries).values({ companyId: f.companyId, endpointId: endpoint.id,
      conversationId: conversation.id, principalId: principal.id, providerEventId: "12345:1", deduplicationKey: randomUUID(),
      eventKind: "message", state: "processed", normalizedEvent: { message: { id: "12345:1", text: "Review exactly this" },
        runtimeContext: { generation: 0, credentialFingerprint: createHash("sha256").update("[]").digest("hex") } } }).returning();
    const acceptedAt = new Date();
    const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issue.id,
      authorUserId: f.board.userId, body: "Review exactly this", createdAt: acceptedAt, updatedAt: acceptedAt }).returning();
    await db.insert(chatMessageLinks).values({ companyId: f.companyId, endpointId: endpoint.id, conversationId: conversation.id,
      deliveryId: delivery.id, commentId: comment.id, providerMessageId: "12345:1", direction: "inbound" });
    const [action] = await db.insert(chatActions).values({ companyId: f.companyId, endpointId: endpoint.id,
      conversationId: conversation.id, principalId: principal.id, deliveryId: delivery.id, kind: "inbound_wakeup",
      providerActionId: randomUUID(), status: "processed", payload: { version: 1, issueId: f.issue.id, agentId: f.reviewer.id,
        commentId: comment.id, sessionGeneration: conversation.sessionGeneration, requestedByActorType: "user", requestedByActorId: f.board.userId } }).returning();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let claimHeld = false;
    const admissionHeartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" },
      beforeChatControlRecoveryCheck: async () => { if (!claimHeld) { claimHeld = true; await held; } } });
    let originalWake: Promise<unknown> | undefined;
    const service = chatChannelService(db, { heartbeat: { wakeup: admissionHeartbeat.wakeup },
      runtime: { shutdown: async () => {} } as unknown as ChatChannelServiceOptions["runtime"] });
    try {
      const request = createDurableChatWakeupRequest({ id: action.id, companyId: f.companyId, agentId: f.reviewer.id,
        issueId: f.issue.id, commentId: comment.id, requestedByActorType: "user", requestedByActorId: f.board.userId,
        requestedAt: action.createdAt, authorize: async tx => {
          const [saved] = await tx.select().from(chatActions).where(eq(chatActions.id, action.id));
          if (saved?.status !== "processed") throw new Error("Original request is no longer accepted");
        } });
      originalWake = admissionHeartbeat.wakeup(f.reviewer.id, { source: "automation", triggerDetail: "system", reason: "issue_commented",
        payload: { issueId: f.issue.id, commentId: comment.id }, requestedByActorType: "user", requestedByActorId: f.board.userId,
        contextSnapshot: { issueId: f.issue.id, taskKey: f.issue.id, source: "chat:telegram", wakeCommentId: comment.id }, durableChatRequest: request });
      expect(await waitForCondition(async () => claimHeld)).toBe(true);
      const [source] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.reviewer.id));
      expect(typeof source.contextSnapshot?.reviewerAssignmentGeneration).toBe("string");
      await db.update(heartbeatRuns).set({ status: "failed", errorCode: "adapter_exit_code", finishedAt: new Date() }).where(eq(heartbeatRuns.id, source.id));
      release();
      await originalWake;
      const intent = await db.transaction(tx => service.prepareFailedChatRunRetry(tx, { companyId: f.companyId, issueId: f.issue.id,
        agentId: f.reviewer.id, failedRunId: source.id, initiatedByUserId: f.board.userId }));
      await db.update(issues).set({ executionPolicy: { ...policy, maxReviewRounds: 4 } }).where(eq(issues.id, f.issue.id));
      await service.processFailedChatRunRetry(intent.actionId);
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, intent.actionId));
      expect(receipt.runId).toBeTruthy();
      const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, receipt.runId!));
      expect(retry.retryOfRunId).toBe(source.id);
      expect(retry.contextSnapshot?.reviewerAssignmentGeneration).toBe(source.contextSnapshot?.reviewerAssignmentGeneration);
      expect(retry.contextSnapshot?.chatFailedRunRetry).toMatchObject({ version: 1, actionId: intent.actionId, failedRunId: source.id });
      await admissionHeartbeat.resumeQueuedRuns();
      const [rejected] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retry.id));
      expect(rejected).toMatchObject({ status: "cancelled", errorCode: "issue_review_participant_changed" });
      expect(executeCallsForAgent(f.reviewer.id)).toHaveLength(0);
      expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, f.companyId))).toHaveLength(0);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.addressee.id))).toHaveLength(0);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.addressee.id))).toHaveLength(0);
    } finally { release(); await originalWake; await admissionHeartbeat.drainActiveRunExecutions(); await service.shutdown(); }
  });

  it.each([
    ["invisible", 404], ["read-without-mutate", 403], ["unauthenticated", 404], ["missing-run", 401], ["missing-source", 422],
    ["wrong-company", 404], ["wrong-source-company", 422], ["wrong-source-agent", 422],
    ["wrong-source-issue", 422], ["wrong-identity", 422], ["self", 422], ["noninvokable", 422],
    ["other-agent-lock", 409], ["low-trust", 403], ["tool-action", 422], ["secret-proposal", 422],
  ])("rejects %s on the current-agent route without creating a card or wake", async (fault, status) => {
    const f = await currentAgentFixture();
    let body: Record<string, unknown> = f.body;
    if (fault === "invisible") {
      vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
      await db.update(issues).set({ visibility: "private", assigneeAgentId: f.reviewer.id }).where(eq(issues.id, f.issue.id));
      expect((await request(app(f.actor)).get(`/api/issues/${f.issue.id}`)).status).toBe(404);
    }
    if (fault === "read-without-mutate") {
      await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issue.id,
        executionPolicy: { trustPreset: "low_trust_review", authorizationPolicy: { trustBoundary: {
          mode: "low_trust_review", issueIds: [randomUUID()], allowedAgentIds: [f.assignee.id] } } } } }).where(eq(heartbeatRuns.id, f.run.id));
      await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issue.id,
        authorUserId: f.board.userId, body: `Please inspect [Assignee](agent://${f.assignee.id})` });
      expect((await request(app(f.actor)).get(`/api/issues/${f.issue.id}`)).status).toBe(200);
    }
    if (fault === "unauthenticated") { f.actor.type = "none"; delete f.actor.agentId; }
    if (fault === "missing-run") delete f.actor.runId;
    if (fault === "missing-source") f.actor.runId = randomUUID();
    if (fault === "wrong-company") f.actor.companyId = randomUUID();
    if (fault === "wrong-source-company") {
      const other = await seedReviewFixture();
      const [foreign] = await db.insert(heartbeatRuns).values({ companyId: other.companyId,
        agentId: other.assignee.id, status: "succeeded" }).returning();
      f.actor.runId = foreign.id;
    }
    if (fault === "wrong-source-agent") await db.update(heartbeatRuns).set({ agentId: f.reviewer.id }).where(eq(heartbeatRuns.id, f.run.id));
    if (fault === "wrong-source-issue") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: randomUUID() } }).where(eq(heartbeatRuns.id, f.run.id));
    if (fault === "wrong-identity") f.actor.identityContextId = randomUUID();
    if (fault === "self") body = { ...body, addresseeAgentId: f.assignee.id };
    if (fault === "noninvokable") await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.addressee.id));
    if (fault === "other-agent-lock") await db.update(issues).set({ status: "in_progress", assigneeAgentId: f.reviewer.id }).where(eq(issues.id, f.issue.id));
    if (fault === "low-trust") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: f.issue.id,
      executionPolicy: { trustPreset: "low_trust_review", authorizationPolicy: { trustBoundary: {
        mode: "low_trust_review", issueIds: [f.issue.id], allowedAgentIds: [f.addressee.id] } } } } }).where(eq(heartbeatRuns.id, f.run.id));
    if (fault === "tool-action" || fault === "secret-proposal") body = { kind: "request_confirmation",
      payload: { version: 1, prompt: "Proceed?", ...(fault === "tool-action" ? { toolAction: {
        version: 1, actionRequestId: randomUUID(), invocationId: randomUUID(), toolName: "forged_tool",
        toolDisplayName: "Forged tool", connectionId: null, applicationId: null, appDisplayName: null,
        risk: "write", previewMarkdown: "Forged", argumentsSummaryJson: "{}", argumentsHash: "forged",
        expiresAt: "2099-01-01T00:00:00.000Z" } } : { secretProposal: { version: 1, proposalId: randomUUID(),
        sourceSecretLabel: "forged/source", configPath: "access.FORGED", targetAgentId: f.assignee.id,
        targetAgentName: "Target", justification: "Forged", expiresAt: "2099-01-01T00:00:00.000Z" } }) } };
    const response = await request(app(f.actor)).post(`/api/issues/${f.issue.id}/interactions`).send(body);
    expect(response.status, JSON.stringify(response.body)).toBe(status);
    expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.addressee.id))).toHaveLength(0);
    expect(executeCallsForAgent(f.addressee.id)).toHaveLength(0);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, f.run.id));
  });

});
