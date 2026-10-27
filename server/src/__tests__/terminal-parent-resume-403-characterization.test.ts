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
  issueTreeHolds,
  issues,
  projects,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// Characterization for phenix3443/paperclip#75. It drives the real comment
// route, access gates and execution workspace guard against PostgreSQL with
// synthetic rows only. It records current behavior; it does not change it.

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
    return { issue: issue!, workspace: workspace ?? null, comments, audits, runCount: runs.length };
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
    // Same production signature as the incident: the cap audit committed with
    // allowed=true, and nothing else changed.
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
    // A 201 proves the comment, not a successor. The wake is enqueued after the
    // response, so successor evidence is a separate read of the run table.
    await vi.waitFor(async () => {
      const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
      const successor = runs.find((run) => run.id !== f.sourceRunId);
      expect(successor).toMatchObject({ status: "queued", contextSnapshot: { issueId: f.targetIssueId } });
    }, { timeout: 5_000 });
  });

  it("M3: a run bound to the target passes the run identity guard (no cap audit; any refusal is a different branch)", async () => {
    const f = await fixture({ runBoundTo: "target" });
    const res = await resume(f);
    // The guard admits the target-bound run. The fixture has no repository,
    // so the rebuild itself fails closed and the row stays archived.
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
    // The fixture company uses the default open issue write policy, so a
    // visible cross-agent resume is admitted. This is not new authority: it is
    // the existing boundary that the archived workspace case must not widen.
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
});
