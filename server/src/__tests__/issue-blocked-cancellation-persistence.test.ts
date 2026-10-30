import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issueExecutionDecisions,
  issueRelations, issues, principalPermissionGrants } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import { runningProcesses } from "../adapters/index.js";
import { terminateLocalService } from "../services/local-service-supervisor.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.mock("../services/local-service-supervisor.js", async original => ({
  ...await original<typeof import("../services/local-service-supervisor.js")>(),
  terminateLocalService: vi.fn(),
}));

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("blocked cancellation with persisted state", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-blocked-cancel-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function fixture() {
    const [company] = await db.insert(companies).values({ name: "Synthetic cancellation", issuePrefix: `C${randomUUID().slice(0, 6)}` }).returning();
    const [manager] = await db.insert(agents).values({ companyId: company.id, name: "Manager", role: "cto", adapterType: "process" }).returning();
    const [owner] = await db.insert(agents).values({ companyId: company.id, name: "Owner", reportsTo: manager.id, adapterType: "process" }).returning();
    await db.insert(principalPermissionGrants).values({ companyId: company.id, principalType: "agent", principalId: manager.id,
      permissionKey: "tasks:manage_active_checkouts" });
    const stageId = randomUUID(), decisionId = randomUUID();
    const policy = { mode: "normal", commentRequired: true, maxReviewRounds: 3,
      stages: [{ id: stageId, type: "review", participants: [{ id: randomUUID(), type: "agent", agentId: manager.id }], approvalsNeeded: 1 }] };
    const history = { status: "completed", currentStageId: null, currentStageIndex: null, currentStageType: null,
      currentParticipant: null, returnAssignee: { type: "agent", agentId: owner.id }, completedStageIds: [stageId],
      lastDecisionId: decisionId, lastDecisionOutcome: "approved", changesRequestedCount: 2 };
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Blocked synthetic task", status: "blocked",
      assigneeAgentId: owner.id, executionPolicy: policy, executionState: history }).returning();
    const blockers = await db.insert(issues).values(["todo", "in_progress"].map(status => ({
      companyId: company.id, title: "Unfinished blocker", status }))).returning();
    await db.insert(issueRelations).values(blockers.map(blocker => ({ companyId: company.id, issueId: issue.id,
      relatedIssueId: blocker.id, type: "blocks" as const })));
    await db.insert(issueExecutionDecisions).values({ id: decisionId, companyId: company.id, issueId: issue.id,
      stageId, stageType: "review", actorAgentId: manager.id, outcome: "approved", body: "Earlier decision" });
    const [actorRun] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: manager.id, status: "running",
      runtimeMode: "legacy", runtimeModeResolvedAt: new Date(), contextSnapshot: { issueId: issue.id } }).returning();
    const app = express(); app.use(express.json()); app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: manager.id, companyId: company.id, source: "agent_key", runId: actorRun.id }; next();
    });
    app.use("/api", issueRoutes(db, {} as never)); app.use(errorHandler);
    return { app, issue, company, owner, manager, actorRun, policy, history, blockers };
  }

  it("commits cancellation and comment while retaining dependencies and review history", async () => {
    const f = await fixture();
    const res = await request(f.app).patch(`/api/issues/${f.issue.id}`).send({ status: "cancelled", comment: "Cancel synthetic work" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const saved = await issueService(db).getById(f.issue.id);
    expect(saved).toMatchObject({ status: "cancelled", assigneeAgentId: f.owner.id, executionPolicy: f.policy, executionState: f.history });
    expect(await db.select().from(issueRelations).where(eq(issueRelations.issueId, f.issue.id))).toHaveLength(2);
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issue.id))).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).toHaveLength(1);
  });

  it.each(["confirmed", "failure", "concurrent", "self-stop"])("waits for real process Stop before commit: %s", async outcome => {
    const failure = outcome === "failure";
    const f = await fixture();
    const child: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    let stoppedRunId: string | null = null;
    try {
      const run = outcome === "self-stop" ? f.actorRun : (await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.owner.id,
        status: "running", runtimeMode: "legacy", runtimeModeResolvedAt: new Date(), contextSnapshot: { issueId: f.issue.id } }).returning())[0];
      await db.update(issues).set({ executionRunId: run.id, ...(outcome === "self-stop" ? { assigneeAgentId: f.manager.id } : {}) }).where(eq(issues.id, f.issue.id));
      stoppedRunId = run.id;
      runningProcesses.set(run.id, { child, graceSec: 1, processGroupId: null });
      const actual = await vi.importActual<typeof import("../services/local-service-supervisor.js")>("../services/local-service-supervisor.js");
      vi.mocked(terminateLocalService).mockImplementationOnce(async (...args) => {
        expect((await issueService(db).getById(f.issue.id))?.status).toBe("blocked");
        if (failure) throw new Error("Controlled termination failure");
        await actual.terminateLocalService(...args);
        if (outcome === "concurrent") await db.update(issues).set({ executionPolicy: { ...f.policy, maxReviewRounds: 4 } }).where(eq(issues.id, f.issue.id));
      });
      const res = await request(f.app).patch(`/api/issues/${f.issue.id}`).send({ status: "cancelled", comment: "Stop synthetic process" });
      const committed = outcome === "confirmed" || outcome === "self-stop";
      expect(res.status, JSON.stringify(res.body)).toBe(failure ? 500 : committed ? 200 : 409);
      expect((await issueService(db).getById(f.issue.id))?.status).toBe(committed ? "cancelled" : "blocked");
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).toHaveLength(committed ? 1 : 0);
      expect(terminateLocalService).toHaveBeenCalled();
      if (!failure) expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      if (stoppedRunId) runningProcesses.delete(stoppedRunId);
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
        child.kill("SIGKILL"); await exited;
      }
      vi.mocked(terminateLocalService).mockReset();
    }
  }, 20_000);
});
