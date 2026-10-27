import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueTreeHolds,
  issues,
  agentWakeupRequests,
  projects,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { CROSS_TASK_CONTINUATION_COMMITTER_ID } from "../services/cross-task-continuation.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, errorMessage: null })),
    })),
  };
});

const CROSS_ISSUE_ACTIVITY = "issue.cross_issue_influence_observed";

type FixtureOptions = {
  workspace?: "archived" | "none";
  targetAssignee?: "same" | "other";
  targetStatus?: "done" | "in_progress" | "in_review";
  runBoundTo?: "source" | "target";
  actorCompany?: "same" | "other";
  actorRun?: "present" | "absent";
  pauseHold?: boolean;
  activeTargetRun?: boolean;
  pendingStage?: "review" | "approval";
  protectedWritePolicy?: boolean;
};

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("terminal parent resume comment (#75 characterization)", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-terminal-parent-resume-");
    db = createDb(temporary.connectionString, { maxConnections: 6 });
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);
  afterAll(async () => { await temporary?.cleanup(); });

  async function fixture(options: FixtureOptions = {}) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const otherAgentId = randomUUID();
    const sourceIssueId = randomUUID();
    const targetIssueId = randomUUID();
    const workspaceId = randomUUID();
    const sourceRunId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Resume", issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Project", status: "in_progress" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    for (const [id, name] of [[agentId, "Scheduler"], [otherAgentId, "Other"]] as const) {
      await db.insert(agents).values({
        id, companyId, name, role: "engineer", status: "active", adapterType: "codex_local",
        adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {},
      });
    }
    await db.insert(issues).values({
      id: sourceIssueId, companyId, projectId, title: "Source routine task", status: "in_progress", assigneeAgentId: agentId,
    });
    await db.insert(issues).values({
      id: targetIssueId, companyId, projectId, title: "Done parent", status: options.targetStatus ?? "done",
      assigneeAgentId: options.targetAssignee === "other" ? otherAgentId : agentId,
      responsibleUserId: "responsible-user",
      executionWorkspaceSettings: { mode: "isolated_workspace" },
      ...(options.protectedWritePolicy
        ? { executionPolicy: { trustPreset: "low_trust_review", authorizationPolicy: { trustBoundary: { mode: "low_trust_review", companyId, projectIds: [projectId] } } } }
        : {}),
    });
    if ((options.workspace ?? "archived") === "archived") {
      await db.insert(executionWorkspaces).values({
        id: workspaceId, companyId, projectId, sourceIssueId: targetIssueId, mode: "isolated_workspace",
        strategyType: "git_worktree", name: "Archived workspace", status: "archived", providerType: "git_worktree",
        branchName: "fix/archived-parent", closedAt: new Date(),
      });
      await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, targetIssueId));
    }
    const runIssueId = options.runBoundTo === "target" ? targetIssueId : sourceIssueId;
    await db.insert(heartbeatRuns).values({
      id: sourceRunId, companyId, agentId, status: "running", invocationSource: "assignment", triggerDetail: "system",
      contextSnapshot: { issueId: runIssueId, taskId: runIssueId },
    });
    if (options.activeTargetRun) {
      const targetRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: targetRunId, companyId, agentId, status: "running", invocationSource: "assignment", triggerDetail: "system",
        contextSnapshot: { issueId: targetIssueId, taskId: targetIssueId },
      });
      await db.update(issues).set({ executionRunId: targetRunId, checkoutRunId: targetRunId }).where(eq(issues.id, targetIssueId));
    }
    if (options.pendingStage) {
      const reviewStageId = randomUUID();
      const approvalStageId = randomUUID();
      const stageId = options.pendingStage === "review" ? reviewStageId : approvalStageId;
      const participant = options.pendingStage === "review"
        ? { type: "agent", agentId: otherAgentId }
        : { type: "user", userId: "responsible-user" };
      const [decision] = await db.insert(issueExecutionDecisions).values({
        companyId, issueId: targetIssueId, stageId: reviewStageId, stageType: "review",
        actorAgentId: otherAgentId, outcome: "changes_requested", body: "fixture prior review round",
      }).returning();
      await db.update(issues).set({
        executionPolicy: {
          mode: "normal", commentRequired: true, maxReviewRounds: null,
          stages: [
            { id: reviewStageId, type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "agent", agentId: otherAgentId }] },
            { id: approvalStageId, type: "approval", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "user", userId: "responsible-user" }] },
          ],
        },
        executionState: {
          status: "pending", currentStageId: stageId,
          currentStageIndex: options.pendingStage === "review" ? 0 : 1,
          currentStageType: options.pendingStage,
          currentParticipant: participant,
          returnAssignee: { type: "agent", agentId },
          reviewRequest: null,
          completedStageIds: options.pendingStage === "review" ? [] : [reviewStageId],
          lastDecisionId: decision!.id, lastDecisionOutcome: "changes_requested",
          changesRequestedCount: options.pendingStage === "review" ? 1 : 0,
        },
      }).where(eq(issues.id, targetIssueId));
    }
    if (options.pauseHold) {
      await db.insert(issueTreeHolds).values({ companyId, rootIssueId: targetIssueId, mode: "pause", status: "active", reason: "fixture pause" });
    }
    const actorCompanyId = options.actorCompany === "other" ? randomUUID() : companyId;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent", agentId, companyId: actorCompanyId, source: "agent_key",
        ...(options.actorRun === "absent" ? {} : { runId: sourceRunId }),
      } as never;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return { app, companyId, agentId, sourceRunId, targetIssueId, workspaceId };
  }

  async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, f.targetIssueId));
    const [workspace] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, f.targetIssueId));
    const audits = await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, f.companyId), eq(activityLog.action, CROSS_ISSUE_ACTIVITY), eq(activityLog.entityId, f.targetIssueId),
    ));
    const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    const decisions = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.targetIssueId));
    const intents = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, f.companyId),
      eq(agentWakeupRequests.requestedByActorId, CROSS_TASK_CONTINUATION_COMMITTER_ID),
    ));
    return { issue: issue!, workspace: workspace ?? null, comments, audits, runCount: runs.length, decisions, intents };
  }

  const resume = (f: Awaited<ReturnType<typeof fixture>>) =>
    request(f.app).post(`/api/issues/${f.targetIssueId}/comments`).send({ body: "调度请求: fixture", resume: true });

  it("M1: same-agent cross-task resume of a done parent with an archived isolated workspace is refused by the workspace run identity guard after the cap audit", async () => {
    const f = await fixture();
    const before = await snapshot(f);
    const res = await resume(f);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Task workspace run identity is unavailable" });
    const after = await snapshot(f);
    expect(after.audits).toHaveLength(1);
    expect(after.audits[0]!.details).toMatchObject({ kind: "comment", count: 1, allowed: true });
    expect(after.comments).toHaveLength(0);
    expect(after.issue.status).toBe("done");
    expect(after.issue.executionState).toEqual(before.issue.executionState);
    expect(after.workspace).toEqual(before.workspace);
    expect(after.runCount).toBe(before.runCount);
  });

  it("M2: the same request without a closed workspace binding is accepted, so the workspace reopen is the refusing step", async () => {
    const f = await fixture({ workspace: "none" });
    const res = await resume(f);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const after = await snapshot(f);
    expect(after.comments).toHaveLength(1);
    expect(after.issue.status).toBe("todo");
    expect(after.audits).toHaveLength(1);
    await vi.waitFor(async () => {
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
      const successor = runs.find((run) => run.id !== f.sourceRunId);
      expect(successor).toMatchObject({ status: "queued", contextSnapshot: { issueId: f.targetIssueId } });
    }, { timeout: 5_000 });
  });

  it("M3: a run bound to the target passes the run identity guard (no cap audit; any refusal is a different branch)", async () => {
    const f = await fixture({ runBoundTo: "target" });
    const res = await resume(f);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "Failed to rebuild the execution workspace" });
    const after = await snapshot(f);
    expect(after.audits).toHaveLength(0);
    expect(after.comments).toHaveLength(0);
    expect(after.issue.status).toBe("done");
    expect(after.workspace?.status).toBe("archived");
  });

  it("M4a: another agent's done parent with an archived workspace reaches the same workspace guard after the cap audit", async () => {
    const f = await fixture({ targetAssignee: "other" });
    const before = await snapshot(f);
    const res = await resume(f);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Task workspace run identity is unavailable" });
    const after = await snapshot(f);
    expect(after.audits).toHaveLength(1);
    expect(after.comments).toHaveLength(0);
    expect(after.issue.status).toBe("done");
    expect(after.workspace).toEqual(before.workspace);
  });

  it("M4b: another agent's done parent without a workspace shows the ownership boundary that a fix must keep", async () => {
    const f = await fixture({ targetAssignee: "other", workspace: "none" });
    const res = await resume(f);
    const after = await snapshot(f);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.metadata).toMatchObject({ authorizationReason: "allow_visible_issue_write" });
    expect(after.comments).toHaveLength(1);
    expect(after.issue.status).toBe("todo");
    expect(after.audits).toHaveLength(1);
  });

  it("M5: an actor from another company stays denied with no effects", async () => {
    const f = await fixture({ actorCompany: "other" });
    const before = await snapshot(f);
    const res = await resume(f);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Issue not found" });
    const after = await snapshot(f);
    expect(after.audits).toHaveLength(0);
    expect(after.comments).toHaveLength(0);
    expect(after.issue.status).toBe("done");
    expect(after.workspace).toEqual(before.workspace);
  });

  it("M6: an agent request without run authority stays denied with no effects", async () => {
    const f = await fixture({ actorRun: "absent" });
    const before = await snapshot(f);
    const res = await resume(f);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/^Cross-issue writes need a run to attribute them to/);
    const after = await snapshot(f);
    expect(after.audits).toHaveLength(0);
    expect(after.comments).toHaveLength(0);
    expect(after.issue.status).toBe("done");
    expect(after.workspace).toEqual(before.workspace);
  });

  it("M7: an active pause hold on the parent stays a 409 before the cap gate", async () => {
    const f = await fixture({ pauseHold: true });
    const before = await snapshot(f);
    const res = await resume(f);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Issue follow-up blocked by active subtree pause hold");
    const after = await snapshot(f);
    expect(after.audits).toHaveLength(0);
    expect(after.comments).toHaveLength(0);
    expect(after.workspace).toEqual(before.workspace);
  });

  it("M8: an in_progress parent with an active run and no closed workspace accepts the comment", async () => {
    const f = await fixture({ workspace: "none", targetStatus: "in_progress", activeTargetRun: true });
    const res = await resume(f);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const after = await snapshot(f);
    expect(after.comments).toHaveLength(1);
  });

  it("M9: an in_review parent is not resumable through a comment and stays unchanged", async () => {
    const f = await fixture({ workspace: "none", targetStatus: "in_review" });
    const before = await snapshot(f);
    const res = await resume(f);
    const after = await snapshot(f);
    expect(after.issue.status).toBe(before.issue.status);
    expect(after.issue.executionState).toEqual(before.issue.executionState);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Issue is not resumable through comment follow-up intent");
    expect(after.comments).toHaveLength(0);
  });

  for (const stage of ["review", "approval"] as const) {
    it(`M9-${stage}: an in_review parent with a pending ${stage} stage and prior decision history keeps its stage, history, comments, workspace and runs`, async () => {
      const f = await fixture({ targetStatus: "in_review", pendingStage: stage });
      const before = await snapshot(f);
      expect(before.issue.executionState).toMatchObject({ status: "pending", currentStageType: stage, lastDecisionOutcome: "changes_requested" });
      expect(before.decisions).toHaveLength(1);
      expect(before.workspace?.status).toBe("archived");
      const res = await resume(f);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("Issue is not resumable through comment follow-up intent");
      const after = await snapshot(f);
      expect(after.issue.status).toBe("in_review");
      expect(after.issue.executionPolicy).toEqual(before.issue.executionPolicy);
      expect(after.issue.executionState).toEqual(before.issue.executionState);
      expect(after.issue.assigneeAgentId).toBe(before.issue.assigneeAgentId);
      expect(after.decisions).toEqual(before.decisions);
      expect(after.comments).toHaveLength(0);
      expect(after.audits).toHaveLength(0);
      expect(after.workspace).toEqual(before.workspace);
      expect(after.runCount).toBe(before.runCount);
    });
  }

  // #75 section 5 review conditions for the deferred continuation (#69). The
  // setting is instance-wide, so each case turns it on and back off.
  async function withDeferredContinuation<T>(body: () => Promise<T>): Promise<T> {
    const settings = instanceSettingsService(db);
    await settings.updateExperimental({ enableCrossTaskDeferredContinuation: true });
    try { return await body(); }
    finally { await settings.updateExperimental({ enableCrossTaskDeferredContinuation: false }); }
  }
  const resumeWithRequestId = (f: Awaited<ReturnType<typeof fixture>>) =>
    request(f.app).post(`/api/issues/${f.targetIssueId}/comments`)
      .send({ body: "调度请求: fixture", resume: true, clientRequestId: randomUUID() });

  it("M1 with the setting on: commits exactly one comment and one continuation intent and leaves the archived workspace untouched", async () => {
    await withDeferredContinuation(async () => {
      const f = await fixture();
      const before = await snapshot(f);
      const res = await resumeWithRequestId(f);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const after = await snapshot(f);
      expect(after.comments).toHaveLength(1);
      expect(after.intents).toHaveLength(1);
      expect(after.intents[0]).toMatchObject({ agentId: f.agentId, payload: { issueId: f.targetIssueId } });
      expect(after.issue.status).toBe("todo");
      expect(after.workspace).toEqual(before.workspace);
    });
  });

  it("M4a with the setting on admits through the same access decision as M4b", async () => {
    await withDeferredContinuation(async () => {
      const a = await fixture({ targetAssignee: "other" });
      const resA = await resumeWithRequestId(a);
      const b = await fixture({ targetAssignee: "other", workspace: "none" });
      const resB = await resumeWithRequestId(b);
      expect(resB.status, JSON.stringify(resB.body)).toBe(201);
      expect(resA.status, JSON.stringify(resA.body)).toBe(201);
      const [commentA] = (await snapshot(a)).comments;
      const [commentB] = (await snapshot(b)).comments;
      expect(commentA?.metadata).toMatchObject({ authorizationReason: "allow_visible_issue_write" });
      expect(commentB?.metadata).toMatchObject({ authorizationReason: "allow_visible_issue_write" });
      const afterA = await snapshot(a);
      expect(afterA.intents).toHaveLength(1);
      // The intent and its successor belong to the target's assignee, not the requester.
      expect(afterA.intents[0]!.agentId).not.toBe(a.agentId);
    });
  });

  it("M4a and M4b with the setting on are refused alike by a restrictive write policy, with no effects", async () => {
    await withDeferredContinuation(async () => {
      const responses: Array<{ status: number; body: unknown }> = [];
      for (const workspace of ["archived", "none"] as const) {
        const f = await fixture({ targetAssignee: "other", workspace, protectedWritePolicy: true });
        const before = await snapshot(f);
        const res = await resumeWithRequestId(f);
        responses.push({ status: res.status, body: res.body });
        expect(res.status, `${workspace}: ${JSON.stringify(res.body)}`).toBe(403);
        const after = await snapshot(f);
        expect(after.comments).toHaveLength(0);
        expect(after.intents).toHaveLength(0);
        expect(after.audits).toHaveLength(before.audits.length);
        expect(after.issue.status).toBe(before.issue.status);
        expect(after.workspace).toEqual(before.workspace);
        expect(after.runCount).toBe(before.runCount);
      }
      // The archived-workspace request (M4a) gets the same refusal as M4b.
      expect(responses[0]).toEqual(responses[1]);
    });
  });

  const unchangedRefusals: Array<{ name: string; options: FixtureOptions; status: number; error: RegExp }> = [
    { name: "M5", options: { actorCompany: "other" }, status: 404, error: /^Issue not found$/ },
    { name: "M6", options: { actorRun: "absent" }, status: 403, error: /^Cross-issue writes need a run to attribute them to/ },
    { name: "M7", options: { pauseHold: true }, status: 409, error: /^Issue follow-up blocked by active subtree pause hold$/ },
    { name: "M9", options: { workspace: "none", targetStatus: "in_review" }, status: 409, error: /^Issue is not resumable through comment follow-up intent$/ },
    { name: "M9-review", options: { targetStatus: "in_review", pendingStage: "review" }, status: 409, error: /^Issue is not resumable through comment follow-up intent$/ },
    { name: "M9-approval", options: { targetStatus: "in_review", pendingStage: "approval" }, status: 409, error: /^Issue is not resumable through comment follow-up intent$/ },
  ];
  for (const refusal of unchangedRefusals) {
    it(`${refusal.name} with the setting on keeps its refusal and has no effects`, async () => {
      await withDeferredContinuation(async () => {
        const f = await fixture(refusal.options);
        const before = await snapshot(f);
        const res = await resumeWithRequestId(f);
        expect(res.status, JSON.stringify(res.body)).toBe(refusal.status);
        expect(res.body.error).toMatch(refusal.error);
        const after = await snapshot(f);
        expect(after.comments).toHaveLength(0);
        expect(after.intents).toHaveLength(0);
        expect(after.audits).toHaveLength(before.audits.length);
        expect(after.issue.status).toBe(before.issue.status);
        expect(after.issue.executionPolicy).toEqual(before.issue.executionPolicy);
        expect(after.issue.executionState).toEqual(before.issue.executionState);
        expect(after.issue.assigneeAgentId).toBe(before.issue.assigneeAgentId);
        expect(after.decisions).toEqual(before.decisions);
        expect(after.workspace).toEqual(before.workspace);
        expect(after.runCount).toBe(before.runCount);
      });
    });
  }
});
