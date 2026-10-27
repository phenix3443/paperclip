import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issueTreeHolds,
  issues,
  projects,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { crossTaskContinuationTestHooks, issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import * as executionWorkspacesModule from "../services/execution-workspaces.js";
import * as lifecycleLockModule from "../services/execution-workspace-lifecycle-lock.js";
import {
  CROSS_TASK_CONTINUATION_COMMITTER_ID,
  CROSS_TASK_CONTINUATION_MESSAGES,
} from "../services/cross-task-continuation.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Cross-task continuation route test run.",
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

// The source run is a bare `running` row with no process. With
// maxConcurrentRuns = 1 it holds the agent's only slot, so a successor stays
// queued and the fixture can read the archived workspace row without racing a
// workspace restore.
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("cross-task deferred continuation route", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-cross-task-continuation-route-");
    db = createDb(temporary.connectionString, { maxConnections: 6 });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);
  afterAll(async () => { await temporary?.cleanup(); });
  afterEach(async () => {
    crossTaskContinuationTestHooks.beforeCommit = undefined;
    crossTaskContinuationTestHooks.beforeTransaction = undefined;
    await setFeature(false);
  });

  async function setFeature(enabled: boolean) {
    await instanceSettingsService(db).updateExperimental({ enableCrossTaskDeferredContinuation: enabled });
  }

  async function fixture(options: { workspace?: "archived" | "missing" | "none"; actor?: "source-run" | "target-run" | "board" } = {}) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const sourceIssueId = randomUUID();
    const targetIssueId = randomUUID();
    const workspaceId = randomUUID();
    const sourceRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Continuation", issuePrefix: `X${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Project", status: "in_progress" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Executor", role: "engineer", status: "active", adapterType: "codex_local",
      adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {},
    });
    await db.insert(issues).values({
      id: sourceIssueId, companyId, projectId, title: "Source task", status: "in_progress", assigneeAgentId: agentId,
    });
    await db.insert(issues).values({
      id: targetIssueId, companyId, projectId, title: "Archived parent", status: "done", assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });
    // `executionWorkspaceId` is ON DELETE SET NULL, so a binding to a deleted
    // row cannot persist. The reachable "missing" binding is one to another
    // company's workspace, which the company-scoped lookup does not find.
    let workspaceCompanyId = companyId;
    let workspaceProjectId = projectId;
    if (options.workspace === "missing") {
      workspaceCompanyId = randomUUID();
      workspaceProjectId = randomUUID();
      await db.insert(companies).values({ id: workspaceCompanyId, name: "Other company", issuePrefix: `Y${workspaceCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
      await db.insert(projects).values({ id: workspaceProjectId, companyId: workspaceCompanyId, name: "Other project", status: "in_progress" });
    }
    if (options.workspace !== "none") {
      await db.insert(executionWorkspaces).values({
        id: workspaceId, companyId: workspaceCompanyId, projectId: workspaceProjectId,
        sourceIssueId: options.workspace === "missing" ? null : targetIssueId, mode: "isolated_workspace",
        strategyType: "git_worktree", name: "Archived workspace", status: "archived", providerType: "git_worktree",
        branchName: "fix/archived-parent", closedAt: new Date(),
      });
    }
    if (options.workspace !== "none") {
      await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, targetIssueId));
    }
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId, status: "running", invocationSource: "assignment", triggerDetail: "system",
      contextSnapshot: { issueId: sourceIssueId, taskId: sourceIssueId },
    });
    const targetRunId = randomUUID();
    if (options.actor === "target-run") {
      await db.insert(heartbeatRuns).values({
        id: targetRunId, companyId, agentId, status: "running", invocationSource: "assignment", triggerDetail: "system",
        contextSnapshot: { issueId: targetIssueId, taskId: targetIssueId },
      });
    }
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = (options.actor === "board"
        ? { type: "board", userId: "responsible-user", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true }
        : { type: "agent", agentId, companyId, runId: options.actor === "target-run" ? targetRunId : sourceRunId, source: "agent_key" }) as never;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return { app, companyId, agentId, sourceIssueId, targetIssueId, workspaceId, sourceRunId };
  }

  async function snapshot(targetIssueId: string, workspaceId: string) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, targetIssueId));
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, workspaceId));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, targetIssueId));
    const intents = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.requestedByActorId, CROSS_TASK_CONTINUATION_COMMITTER_ID),
      like(agentWakeupRequests.idempotencyKey, `issue\\_cross\\_task\\_continuation:${targetIssueId}:%`),
    ));
    return { issue: issue!, workspace: workspace ?? null, comments, intents };
  }

  function post(app: express.Express, targetIssueId: string, body: Record<string, unknown>) {
    return request(app).post(`/api/issues/${targetIssueId}/comments`).send(body);
  }

  it("R1: commits comment, todo and one intent without touching the archived workspace", async () => {
    await setFeature(true);
    const f = await fixture();
    const before = await snapshot(f.targetIssueId, f.workspaceId);

    const res = await post(f.app, f.targetIssueId, { body: "Child finished, please continue", resume: true, clientRequestId: "e777bcd5-6c2c-4a8b-ad8b-787478ae83d4" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ replayed: false, continuation: { status: expect.any(String) } });

    const after = await snapshot(f.targetIssueId, f.workspaceId);
    expect(after.issue.status).toBe("todo");
    expect(after.issue.executionState).toEqual(before.issue.executionState);
    expect(after.workspace).toEqual(before.workspace);
    expect(after.comments).toHaveLength(1);
    expect(after.comments[0]).toMatchObject({ authorAgentId: f.agentId, createdByRunId: f.sourceRunId, clientRequestId: "e777bcd5-6c2c-4a8b-ad8b-787478ae83d4" });
    expect(after.intents).toHaveLength(1);
    expect(after.intents[0]!.payload).toMatchObject({
      issueId: f.targetIssueId,
      commentId: after.comments[0]!.id,
      crossTaskContinuation: {
        sourceRunId: f.sourceRunId,
        sourceIssueId: f.sourceIssueId,
        workspaceId: f.workspaceId,
        expectedAssigneeAgentId: f.agentId,
      },
    });
    expect(res.body.continuation.wakeupRequestId).toBe(after.intents[0]!.id);

    // K5 (queued half): the notify dispatched one run bound to the target under
    // the dispatch key. It waits behind the source run's slot.
    const successors = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, f.companyId),
      eq(heartbeatRuns.agentId, f.agentId),
    ));
    const successor = successors.find((run) => run.id !== f.sourceRunId);
    expect(successors).toHaveLength(2);
    expect(successor).toMatchObject({ status: "queued", contextSnapshot: { issueId: f.targetIssueId, source: "cross_task_continuation" } });
    const [linkedIntent] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, after.intents[0]!.id));
    expect(linkedIntent).toMatchObject({ status: "coalesced", runId: successor!.id });

    // The source run is untouched and still owns its own task.
    const [sourceRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.sourceRunId));
    expect(sourceRun).toMatchObject({ status: "running", contextSnapshot: { issueId: f.sourceIssueId } });
  });

  it("I1/I9: a sequential retry replays, even after the setting is turned off", async () => {
    await setFeature(true);
    const f = await fixture();
    const body = { body: "Continue please", resume: true, clientRequestId: "a15058b4-6fcf-4d26-a236-cb19c9d58562" };
    const first = await post(f.app, f.targetIssueId, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const afterFirst = await snapshot(f.targetIssueId, f.workspaceId);

    const second = await post(f.app, f.targetIssueId, body);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body).toMatchObject({ id: first.body.id, replayed: true, continuation: { wakeupRequestId: first.body.continuation.wakeupRequestId } });

    await setFeature(false);
    const third = await post(f.app, f.targetIssueId, body);
    expect(third.status, JSON.stringify(third.body)).toBe(201);
    expect(third.body).toMatchObject({ id: first.body.id, replayed: true });

    const afterReplays = await snapshot(f.targetIssueId, f.workspaceId);
    expect(afterReplays.comments).toHaveLength(afterFirst.comments.length);
    expect(afterReplays.intents).toHaveLength(afterFirst.intents.length);
  });

  it("I10: the same clientRequestId with a different body gets 409 and writes nothing", async () => {
    await setFeature(true);
    const f = await fixture();
    const first = await post(f.app, f.targetIssueId, { body: "Original", resume: true, clientRequestId: "3d7c0c88-b118-42be-a748-0b03022e90a3" });
    expect(first.status).toBe(201);
    const before = await snapshot(f.targetIssueId, f.workspaceId);

    const res = await post(f.app, f.targetIssueId, { body: "Different", resume: true, clientRequestId: "3d7c0c88-b118-42be-a748-0b03022e90a3" });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe(CROSS_TASK_CONTINUATION_MESSAGES.digestMismatch);
    expect(await snapshot(f.targetIssueId, f.workspaceId)).toEqual(before);
  });

  it("I3: a second clientRequestId coalesces into the pending intent", async () => {
    await setFeature(true);
    const f = await fixture();
    const first = await post(f.app, f.targetIssueId, { body: "First", resume: true, clientRequestId: "90504e05-01e7-47f8-a6e4-ae733c7b03b9" });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await post(f.app, f.targetIssueId, { body: "Second", resume: true, clientRequestId: "18232dd9-76a0-442b-ad83-680c0526e7fa" });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(second.body.continuation).toMatchObject({
      status: "coalesced",
      coalescedIntoWakeupRequestId: first.body.continuation.wakeupRequestId,
    });
    const after = await snapshot(f.targetIssueId, f.workspaceId);
    expect(after.comments).toHaveLength(2);
    expect(after.intents).toHaveLength(2);
  });

  it("refuses a missing clientRequestId with 422 and no effects", async () => {
    await setFeature(true);
    const f = await fixture();
    const before = await snapshot(f.targetIssueId, f.workspaceId);
    const res = await post(f.app, f.targetIssueId, { body: "No id", resume: true });
    expect(res.status, JSON.stringify(res.body)).toBe(422);
    expect(await snapshot(f.targetIssueId, f.workspaceId)).toEqual(before);
  });

  it("refuses an agent interrupt with 403 and no effects", async () => {
    await setFeature(true);
    const f = await fixture();
    const before = await snapshot(f.targetIssueId, f.workspaceId);
    const res = await post(f.app, f.targetIssueId, { body: "Interrupt", resume: true, interrupt: true, clientRequestId: "79e47ee0-c22a-481c-94ad-ace5a807eef7" });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await snapshot(f.targetIssueId, f.workspaceId)).toEqual(before);
  });

  it("M1: a binding the company cannot see (another company's workspace) gets 409 and no effects", async () => {
    await setFeature(true);
    const f = await fixture({ workspace: "missing" });
    const before = await snapshot(f.targetIssueId, f.workspaceId);
    const res = await post(f.app, f.targetIssueId, { body: "Continue", resume: true, clientRequestId: "5c22b4db-a5ae-48d6-a67e-93f4a493f4aa" });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error).toBe(CROSS_TASK_CONTINUATION_MESSAGES.notReopenable);
    expect(await snapshot(f.targetIssueId, f.workspaceId)).toEqual(before);
  });

  it("I5: a fault before commit leaves nothing and a retry succeeds as fresh", async () => {
    await setFeature(true);
    const f = await fixture();
    const before = await snapshot(f.targetIssueId, f.workspaceId);
    crossTaskContinuationTestHooks.beforeCommit = async () => { throw new Error("injected fault"); };
    const failed = await post(f.app, f.targetIssueId, { body: "Continue", resume: true, clientRequestId: "bd9dada6-ac12-4ee2-9c68-ff2ecd705773" });
    expect(failed.status).toBe(500);
    expect(await snapshot(f.targetIssueId, f.workspaceId)).toEqual(before);

    crossTaskContinuationTestHooks.beforeCommit = undefined;
    const retry = await post(f.app, f.targetIssueId, { body: "Continue", resume: true, clientRequestId: "bd9dada6-ac12-4ee2-9c68-ff2ecd705773" });
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    expect(retry.body.replayed).toBe(false);
  });

  it("I2: concurrent identical requests commit one comment and one intent", async () => {
    await setFeature(true);
    const f = await fixture();
    const body = { body: "Continue", resume: true, clientRequestId: "5df5cca4-7348-4196-a903-0f0230fb74b5" };
    const [a, b] = await Promise.all([post(f.app, f.targetIssueId, body), post(f.app, f.targetIssueId, body)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect([a.body.replayed, b.body.replayed].sort()).toEqual([false, true]);
    expect(a.body.id).toBe(b.body.id);
    const after = await snapshot(f.targetIssueId, f.workspaceId);
    expect(after.comments).toHaveLength(1);
    expect(after.intents).toHaveLength(1);
  });

  it("with the setting off, a cross-task resume of an archived workspace keeps today's refusal", async () => {
    const f = await fixture();
    const before = await snapshot(f.targetIssueId, f.workspaceId);
    const res = await post(f.app, f.targetIssueId, { body: "Continue", resume: true, clientRequestId: "d5f20295-4ae8-4d6e-a50f-0d04493788d1" });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    const after = await snapshot(f.targetIssueId, f.workspaceId);
    expect(after.comments).toEqual(before.comments);
    expect(after.intents).toEqual(before.intents);
    expect(after.issue.status).toBe("done");
  });
  // Section 8: refusals with no side effects. Each leaves no comment, no status
  // change, no intent and no workspace change.
  async function expectRefusal(
    f: Awaited<ReturnType<typeof fixture>>,
    expectedStatus: number,
    expectedError?: string,
    app: express.Express = f.app,
  ) {
    const before = await snapshot(f.targetIssueId, f.workspaceId);
    const res = await post(app, f.targetIssueId, { body: "Continue", resume: true, clientRequestId: randomUUID() });
    expect(res.status, JSON.stringify(res.body)).toBe(expectedStatus);
    if (expectedError) expect(res.body.error).toBe(expectedError);
    expect(await snapshot(f.targetIssueId, f.workspaceId)).toEqual(before);
  }

  it("refuses an active subtree pause hold with 409", async () => {
    await setFeature(true);
    const f = await fixture();
    await db.insert(issueTreeHolds).values({
      companyId: f.companyId, rootIssueId: f.targetIssueId, mode: "pause", status: "active",
      createdByActorType: "user", createdByUserId: "responsible-user",
      releasePolicy: { strategy: "manual", note: "fixture" },
    });
    await expectRefusal(f, 409, CROSS_TASK_CONTINUATION_MESSAGES.pauseHold);
  });

  it("refuses a blocked target with unresolved blockers with 409", async () => {
    await setFeature(true);
    const f = await fixture();
    // Like today's comment gate, blockers refuse a resume of a `blocked` target.
    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, f.targetIssueId));
    const blockerId = randomUUID();
    await db.insert(issues).values({ id: blockerId, companyId: f.companyId, title: "Blocker", status: "in_progress" });
    await db.insert(issueRelations).values({ companyId: f.companyId, issueId: blockerId, relatedIssueId: f.targetIssueId, type: "blocks" });
    await expectRefusal(f, 409, CROSS_TASK_CONTINUATION_MESSAGES.unresolvedBlockers);
  });

  it("refuses a target whose execution is held by a live run with 409", async () => {
    await setFeature(true);
    const f = await fixture();
    const liveRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: liveRunId, companyId: f.companyId, agentId: f.agentId, status: "queued", invocationSource: "assignment",
      triggerDetail: "system", contextSnapshot: { issueId: f.targetIssueId },
    });
    await db.update(issues).set({ executionRunId: liveRunId }).where(eq(issues.id, f.targetIssueId));
    const before = await snapshot(f.targetIssueId, f.workspaceId);
    const res = await post(f.app, f.targetIssueId, { body: "Continue", resume: true, clientRequestId: randomUUID() });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(await snapshot(f.targetIssueId, f.workspaceId)).toEqual(before);
  });

  it("refuses a source run the actor does not own with the guard's 403", async () => {
    await setFeature(true);
    const f = await fixture();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId, companyId: f.companyId, name: "Other", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.update(heartbeatRuns).set({ agentId: otherAgentId }).where(eq(heartbeatRuns.id, f.sourceRunId));
    await expectRefusal(f, 403);
  });

  it("a commenter that is not the assignee still wakes only the target's assignee", async () => {
    await setFeature(true);
    const f = await fixture();
    // The requester has the ordinary comment access (same company, visible
    // issue write), so the plan does not refuse it. The intent and the
    // successor still belong to the target's assignee, never to the requester.
    const requesterId = randomUUID();
    const requesterRunId = randomUUID();
    await db.insert(agents).values({
      id: requesterId, companyId: f.companyId, name: "Requester", role: "engineer", status: "active",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: requesterRunId, companyId: f.companyId, agentId: requesterId, status: "running", invocationSource: "assignment",
      triggerDetail: "system", contextSnapshot: { issueId: f.sourceIssueId, taskId: f.sourceIssueId },
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: requesterId, companyId: f.companyId, runId: requesterRunId, source: "agent_key" } as never;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    const res = await post(app, f.targetIssueId, { body: "Continue", resume: true, clientRequestId: randomUUID() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const after = await snapshot(f.targetIssueId, f.workspaceId);
    expect(after.intents).toHaveLength(1);
    expect(after.intents[0]).toMatchObject({ agentId: f.agentId });
    expect(after.intents[0]!.payload).toMatchObject({ crossTaskContinuation: { requestedByAgentId: requesterId, expectedAssigneeAgentId: f.agentId } });
    const requesterRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, requesterId));
    expect(requesterRuns.map((run) => run.id)).toEqual([requesterRunId]);
  });

  it("refuses a cross-company issue id before any write", async () => {
    await setFeature(true);
    const f = await fixture();
    const other = await fixture();
    const before = await snapshot(other.targetIssueId, other.workspaceId);
    const res = await post(f.app, other.targetIssueId, { body: "Continue", resume: true, clientRequestId: randomUUID() });
    expect([403, 404]).toContain(res.status);
    expect(await snapshot(other.targetIssueId, other.workspaceId)).toEqual(before);
  });

  it("G2: a cross-task agent PATCH on the closed target keeps its 403 with no side effects", async () => {
    await setFeature(true);
    const f = await fixture();
    const before = await snapshot(f.targetIssueId, f.workspaceId);
    const res = await request(f.app).patch(`/api/issues/${f.targetIssueId}`).send({ status: "todo" });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await snapshot(f.targetIssueId, f.workspaceId)).toEqual(before);
  });

  // Records every reopen input the routes pass to the workspace service. Must
  // be installed before the fixture builds the routes.
  function recordReopenInputs() {
    const inputs: Array<Record<string, unknown>> = [];
    const real = executionWorkspacesModule.executionWorkspaceService;
    const factory = vi.spyOn(executionWorkspacesModule, "executionWorkspaceService").mockImplementation((...args) => {
      const svc = real(...args);
      const reopen = svc.reopenClosedIsolatedExecutionWorkspaceForIssue;
      svc.reopenClosedIsolatedExecutionWorkspaceForIssue = (input) => { inputs.push(input as Record<string, unknown>); return reopen(input); };
      return svc;
    });
    return { inputs, restore: () => factory.mockRestore() };
  }

  it("L3: the deferred path never takes the eager lifecycle-lock helper and never calls the reopen service", async () => {
    await setFeature(true);
    const recorder = recordReopenInputs();
    const withLock = vi.spyOn(lifecycleLockModule, "withExecutionWorkspaceLifecycleLock");
    try {
      const f = await fixture();
      const res = await post(f.app, f.targetIssueId, { body: "Continue", resume: true, clientRequestId: randomUUID() });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(withLock).not.toHaveBeenCalled();
      expect(recorder.inputs).toHaveLength(0);
    } finally {
      withLock.mockRestore();
      recorder.restore();
    }
  });

  it.each([
    { name: "V4: an agent run bound to the target", actor: "target-run" as const },
    { name: "V5: a board user", actor: "board" as const },
  ])("G3 / $name still reopens eagerly, without the fence and without an intent", async ({ actor }) => {
    await setFeature(true);
    const recorder = recordReopenInputs();
    try {
      const f = await fixture({ actor });
      const res = await post(f.app, f.targetIssueId, { body: "Continue", resume: true });
      // The fixture row has no repository, so the eager rebuild itself fails, as today (#75 M3).
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(res.body).toEqual({ error: "Failed to rebuild the execution workspace" });
      expect(recorder.inputs).toHaveLength(1);
      expect(recorder.inputs[0]).toMatchObject({ workspaceId: f.workspaceId, issue: { id: f.targetIssueId } });
      expect(recorder.inputs[0]).not.toHaveProperty("expectedClosedGeneration");
      const after = await snapshot(f.targetIssueId, f.workspaceId);
      expect(after.intents).toHaveLength(0);
    } finally {
      recorder.restore();
    }
  });

  it.each(["rebind", "generation"] as const)("L1 (%s): a concurrent writer blocks until the deferred transaction commits, then sees todo and the unchanged workspace", async (write) => {
    await setFeature(true);
    const f = await fixture();
    const before = await snapshot(f.targetIssueId, f.workspaceId);
    let writer: Promise<unknown> | null = null;
    let writerSettledInsideTransaction = false;
    crossTaskContinuationTestHooks.beforeCommit = async () => {
      // A separate connection; the deferred transaction holds the issue and workspace rows FOR UPDATE.
      writer = write === "rebind"
        ? db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, f.targetIssueId))
        : db.update(executionWorkspaces).set({ metadata: { lifecycleGeneration: 7 } }).where(eq(executionWorkspaces.id, f.workspaceId));
      writer.then(() => { writerSettledInsideTransaction = true; }, () => { writerSettledInsideTransaction = true; });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(writerSettledInsideTransaction).toBe(false);
    };
    const res = await post(f.app, f.targetIssueId, { body: "Continue", resume: true, clientRequestId: randomUUID() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await writer;
    const after = await snapshot(f.targetIssueId, f.workspaceId);
    expect(after.issue.status).toBe("todo");
    expect(after.intents).toHaveLength(1);
    expect(after.comments).toHaveLength(1);
    // The writer applied after the commit, on top of the committed state.
    if (write === "rebind") {
      expect(after.issue.executionWorkspaceId).toBeNull();
      expect(after.workspace).toEqual(before.workspace);
    } else {
      expect(after.workspace?.metadata).toMatchObject({ lifecycleGeneration: 7 });
      expect({ ...after.workspace, metadata: null, updatedAt: null }).toEqual({ ...before.workspace, metadata: null, updatedAt: null });
    }
  });

  it.each(["rebind", "generation"] as const)("L1 reverse (%s): a writer that commits between classification and the locked re-check makes the request 409 with no writes", async (write) => {
    await setFeature(true);
    const f = await fixture();
    crossTaskContinuationTestHooks.beforeTransaction = async () => {
      if (write === "rebind") await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, f.targetIssueId));
      else await db.update(executionWorkspaces).set({ metadata: { lifecycleGeneration: 7 } }).where(eq(executionWorkspaces.id, f.workspaceId));
    };
    const between = async () => snapshot(f.targetIssueId, f.workspaceId);
    const res = await post(f.app, f.targetIssueId, { body: "Continue", resume: true, clientRequestId: randomUUID() });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({ error: CROSS_TASK_CONTINUATION_MESSAGES.notReopenable });
    const after = await between();
    expect(after.comments).toHaveLength(0);
    expect(after.intents).toHaveLength(0);
    expect(after.issue.status).toBe("done");
  });

  // A low-trust boundary that excludes the target's project, so this agent can no longer read it.
  async function restrictTarget(targetIssueId: string) {
    const [target] = await db.select({ companyId: issues.companyId }).from(issues).where(eq(issues.id, targetIssueId));
    await db.update(issues).set({ executionPolicy: { trustPreset: "low_trust_review", authorizationPolicy: { trustBoundary: {
      mode: "low_trust_review", companyId: target!.companyId, projectIds: [] } } } }).where(eq(issues.id, targetIssueId));
  }

  it("R0 needs read access now: a replay after the target became unreadable gets the same refusal as a fresh request", async () => {
    await setFeature(true);
    const f = await fixture();
    const request1 = { body: "Continue", resume: true, clientRequestId: randomUUID() };
    expect((await post(f.app, f.targetIssueId, request1)).status).toBe(201);
    await restrictTarget(f.targetIssueId);
    const fresh = await post(f.app, f.targetIssueId, { ...request1, clientRequestId: randomUUID() });
    const replay = await post(f.app, f.targetIssueId, request1);
    expect(fresh.status).toBe(404);
    expect(replay.status).toBe(fresh.status);
    expect(replay.body).toEqual(fresh.body);
    expect(replay.body).not.toHaveProperty("replayed");
  });

  it("D4 re-runs the access decisions on the locked row: a policy committed before the transaction refuses like a fresh request, with no writes", async () => {
    await setFeature(true);
    const control = await fixture();
    await restrictTarget(control.targetIssueId);
    const freshRefusal = await post(control.app, control.targetIssueId, { body: "Continue", resume: true, clientRequestId: randomUUID() });

    const f = await fixture();
    const before = await snapshot(f.targetIssueId, f.workspaceId);
    crossTaskContinuationTestHooks.beforeTransaction = async () => { await restrictTarget(f.targetIssueId); };
    const res = await post(f.app, f.targetIssueId, { body: "Continue", resume: true, clientRequestId: randomUUID() });
    expect(res.status, JSON.stringify(res.body)).toBe(freshRefusal.status);
    expect(res.body).toEqual(freshRefusal.body);
    const after = await snapshot(f.targetIssueId, f.workspaceId);
    expect(after.comments).toHaveLength(0);
    expect(after.intents).toHaveLength(0);
    expect(after.issue.status).toBe(before.issue.status);
    expect(after.workspace).toEqual(before.workspace);
  });

  it("D4 accepts an in_progress target with no live execution, like D0, and moves it to todo", async () => {
    await setFeature(true);
    const f = await fixture();
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, f.targetIssueId));
    const before = await snapshot(f.targetIssueId, f.workspaceId);
    const res = await post(f.app, f.targetIssueId, { body: "Continue", resume: true, clientRequestId: randomUUID() });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const after = await snapshot(f.targetIssueId, f.workspaceId);
    expect(after.issue.status).toBe("todo");
    expect(after.intents).toHaveLength(1);
    expect(after.intents[0]!.payload).toMatchObject({ reopenedFrom: "in_progress" });
    expect(after.workspace).toEqual(before.workspace);
  });
});
