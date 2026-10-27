import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issues,
  projects,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import {
  CROSS_TASK_CONTINUATION_COMMITTER_ID,
  commitCrossTaskContinuation,
  crossTaskContinuationIntentKey,
} from "../services/cross-task-continuation.js";
import {
  CROSS_TASK_CONTINUATION_STALE_CLAIM_MS,
  readCrossTaskContinuationWork,
  registerCrossTaskContinuationWork,
} from "../services/cross-task-continuation-worker.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("cross-task continuation delivery worker", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const coordinators: ReturnType<typeof createDeliveryWorkCoordinator>[] = [];

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-cross-task-continuation-worker-");
    db = createDb(temporary.connectionString, { maxConnections: 6 });
  }, 20_000);
  afterEach(async () => {
    await Promise.all(coordinators.splice(0).map((coordinator) => coordinator.stop()));
    await db.delete(agentWakeupRequests);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const sourceIssueId = randomUUID();
    const targetIssueId = randomUUID();
    const workspaceId = randomUUID();
    const sourceRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Worker", issuePrefix: `W${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Project", status: "in_progress" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Executor", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(issues).values({ id: sourceIssueId, companyId, projectId, title: "Source", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(issues).values({ id: targetIssueId, companyId, projectId, title: "Target", status: "done", assigneeAgentId: agentId });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId, sourceIssueId: targetIssueId,
      mode: "isolated_workspace", strategyType: "git_worktree", name: "Archived", status: "archived", providerType: "git_worktree", closedAt: new Date() });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, targetIssueId));
    await db.insert(heartbeatRuns).values({ id: sourceRunId, companyId, agentId, status: "running", invocationSource: "assignment",
      triggerDetail: "system", contextSnapshot: { issueId: sourceIssueId } });
    return { companyId, agentId, targetIssueId, workspaceId, sourceRunId };
  }

  function commit(f: Awaited<ReturnType<typeof fixture>>, beforeCommit?: () => Promise<void>) {
    return commitCrossTaskContinuation(db, {
      companyId: f.companyId, issueId: f.targetIssueId, actorAgentId: f.agentId, sourceRunId: f.sourceRunId,
      clientRequestId: randomUUID(), requestDigest: "digest", binding: { workspaceId: f.workspaceId, generation: 0 },
      admitted: { assigneeAgentId: f.agentId, responsibleUserId: null }, resumeRequested: true,
    }, {
      addComment: async (tx) => (await tx.insert(issueComments).values({ companyId: f.companyId, issueId: f.targetIssueId,
        authorAgentId: f.agentId, body: "Continue" }).returning())[0]!,
      setIssueTodo: async (tx) => (await tx.update(issues).set({ status: "todo" }).where(eq(issues.id, f.targetIssueId)).returning())[0] ?? null,
      logIssueReopened: async () => {},
      getActivePauseHold: async () => null,
      getUnresolvedBlockerCount: async () => 0,
      reauthorize: async () => null,
      beforeCommit,
    });
  }

  function register(dispatch = vi.fn(async () => {})) {
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: () => {} });
    coordinators.push(coordinator);
    const worker = registerCrossTaskContinuationWork(db, coordinator, dispatch);
    return { coordinator, worker, dispatch };
  }

  async function insertIntent(f: Awaited<ReturnType<typeof fixture>>, status: "queued" | "claimed", claimedAt: Date | null) {
    await db.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
      triggerDetail: "system", reason: "issue_reopened_via_comment", status, claimedAt, payload: { issueId: f.targetIssueId },
      requestedByActorType: "system", requestedByActorId: CROSS_TASK_CONTINUATION_COMMITTER_ID,
      idempotencyKey: crossTaskContinuationIntentKey(f.targetIssueId, randomUUID()) });
  }

  it("is quiet with no intents: no pending work and no deadline", async () => {
    expect(await readCrossTaskContinuationWork(db)).toEqual({ pending: false, nextClaimDeadline: null });
    const { coordinator, worker } = register();
    await worker.ready;
    expect(coordinator.nextWakeAt()).toBeNull();
  });

  it("reads a queued or stale claim as pending and a live claim as a deadline", async () => {
    const f = await fixture();
    const now = Date.now();
    const liveClaim = new Date(now - 10_000);
    await insertIntent(f, "claimed", liveClaim);
    expect(await readCrossTaskContinuationWork(db, now)).toEqual({
      pending: false, nextClaimDeadline: liveClaim.getTime() + CROSS_TASK_CONTINUATION_STALE_CLAIM_MS,
    });
    const { coordinator, worker } = register();
    await worker.ready;
    expect(coordinator.nextWakeAt()).toBe(liveClaim.getTime() + CROSS_TASK_CONTINUATION_STALE_CLAIM_MS);
    await insertIntent(f, "claimed", new Date(now - CROSS_TASK_CONTINUATION_STALE_CLAIM_MS - 1_000));
    expect((await readCrossTaskContinuationWork(db, now)).pending).toBe(true);
    await db.delete(agentWakeupRequests);
    await insertIntent(f, "queued", null);
    expect((await readCrossTaskContinuationWork(db, now)).pending).toBe(true);
  });

  it("reconstructs a pending intent at startup and goes quiet once it is delivered", async () => {
    const f = await fixture();
    await insertIntent(f, "queued", null);
    const dispatch = vi.fn(async () => {
      await db.update(agentWakeupRequests).set({ status: "coalesced", runId: f.sourceRunId }).where(eq(agentWakeupRequests.companyId, f.companyId));
    });
    const { coordinator, worker } = register(dispatch);
    await worker.ready;
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(coordinator.nextWakeAt()).toBeNull();
  });

  it("is woken by the commit's notification and keeps the obligation until delivery; a rollback leaves no work and the worker quiet", async () => {
    let deliver = false;
    const dispatch = vi.fn(async () => {
      if (deliver) await db.update(agentWakeupRequests).set({ status: "coalesced", runId: committed.sourceRunId })
        .where(eq(agentWakeupRequests.requestedByActorId, CROSS_TASK_CONTINUATION_COMMITTER_ID));
    });
    const { coordinator, worker } = register(dispatch);
    await worker.ready;

    const rolledBack = await fixture();
    await expect(commit(rolledBack, async () => { throw new Error("injected fault"); })).rejects.toThrow("injected fault");
    await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull(), { timeout: 3_000 });
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);

    const callsBefore = dispatch.mock.calls.length;
    const committed = await fixture();
    await expect(commit(committed)).resolves.toMatchObject({ kind: "committed" });
    await vi.waitFor(() => expect(dispatch.mock.calls.length).toBeGreaterThan(callsBefore), { timeout: 3_000 });
    await vi.waitFor(() => expect(coordinator.nextWakeAt()).not.toBeNull(), { timeout: 3_000 });

    deliver = true;
    await vi.waitFor(async () => {
      expect((await readCrossTaskContinuationWork(db)).pending).toBe(false);
      expect(coordinator.nextWakeAt()).toBeNull();
    }, { timeout: 15_000 });
  }, 30_000);
});
