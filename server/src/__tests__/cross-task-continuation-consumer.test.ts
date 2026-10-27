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
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import {
  CROSS_TASK_CONTINUATION_COMMITTER_ID,
  CROSS_TASK_CONTINUATION_GATE_CHANGED,
  crossTaskContinuationDispatchKey,
  crossTaskContinuationIntentKey,
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
    // Simulate the crash between enqueueWakeup and linking the intent.
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
    // enqueueWakeup wrote a skipped receipt, then the process stopped before
    // the intent was updated.
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
});
