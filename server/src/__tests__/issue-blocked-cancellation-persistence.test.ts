import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, agents, companies, createDb, heartbeatRuns, issueComments, issueExecutionDecisions,
  issueRelations, issues, principalPermissionGrants } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import { executionPolicyTransitionInputFingerprint } from "../services/issue-execution-policy.js";
import { issueRoutes } from "../routes/issues.js";
import { issueService } from "../services/issues.js";
import * as issueServices from "../services/issues.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const barrier = { afterRead: null as null | (() => Promise<void>) };

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("blocked cancellation snapshots", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-blocked-cancel-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { barrier.afterRead = null; await db?.$client.end(); await database?.cleanup(); });

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
    const blockers = await db.insert(issues).values(["done", "done"].map(status => ({
      companyId: company.id, title: "Completed blocker", status }))).returning();
    await db.insert(issueRelations).values(blockers.map(blocker => ({ companyId: company.id, issueId: issue.id,
      relatedIssueId: blocker.id, type: "blocks" as const })));
    await db.insert(issueExecutionDecisions).values({ id: decisionId, companyId: company.id, issueId: issue.id,
      stageId, stageType: "review", actorAgentId: manager.id, outcome: "approved", body: "Earlier decision" });
    const [actorRun] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: manager.id, status: "running",
      runtimeMode: "legacy", runtimeModeResolvedAt: new Date(), contextSnapshot: { issueId: issue.id } }).returning();
    const app = express(); app.use(express.json()); app.use((req, _res, next) => {
      req.actor = { type: "agent", agentId: manager.id, companyId: company.id, source: "agent_key", runId: actorRun.id }; next();
    });
    const actual = issueServices.issueService;
    const factory = vi.spyOn(issueServices, "issueService").mockImplementation((...args) => {
      const service = actual(...args);
      return { ...service, getById: async (...input) => {
        const row = await service.getById(...input);
        const pending = barrier.afterRead;
        barrier.afterRead = null;
        await pending?.();
        return row;
      } };
    });
    try { app.use("/api", issueRoutes(db, {} as never)); } finally { factory.mockRestore(); }
    app.use(errorHandler);
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


  it.each(["policy", "null-policy", "clear-policy", "state", "participant", "count", "null-state", "status", "assignee", "monitor"])(
    "rejects changed cancellation inputs: %s", async change => {
      const f = await fixture();
      if (change.startsWith("null-")) {
        await db.update(issues).set({ executionPolicy: null, executionState: null }).where(eq(issues.id, f.issue.id));
      }
      const patches: Record<string, Partial<typeof issues.$inferInsert>> = {
        policy: { executionPolicy: { ...f.policy, maxReviewRounds: 4 } },
        "null-policy": { executionPolicy: f.policy },
        "clear-policy": { executionPolicy: null },
        state: { executionState: { ...f.history, currentStageIndex: 1 } },
        participant: { executionState: { ...f.history, currentParticipant: { type: "agent", agentId: f.owner.id } } },
        count: { executionState: { ...f.history, changesRequestedCount: 3 } },
        "null-state": { executionState: f.history },
        status: { status: "in_progress" },
        assignee: { assigneeAgentId: f.manager.id },
        monitor: { monitorNotes: "New monitoring intent" },
      };
      const notifications = vi.fn();
      const unsubscribe = subscribeCompanyLiveEvents(f.company.id, notifications);
      try {
        barrier.afterRead = async () => { await db.update(issues).set(patches[change]).where(eq(issues.id, f.issue.id)); };
        const res = await request(f.app).patch(`/api/issues/${f.issue.id}`).send({ status: "cancelled", comment: "Stale cancel" });
        expect(res.status, JSON.stringify(res.body)).toBe(409);
        expect(res.body.details.code).toBe("execution_policy_transition_changed");
        expect(await issueService(db).getById(f.issue.id)).toMatchObject({ status: "blocked", ...patches[change] });
        expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issue.id))).toHaveLength(0);
        expect(await db.select().from(activityLog).where(eq(activityLog.entityId, f.issue.id))).toHaveLength(0);
        expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issue.id))).toHaveLength(1);
        expect(notifications).not.toHaveBeenCalled();
      } finally { unsubscribe(); barrier.afterRead = null; }
    },
  );

  it("accepts an unchanged null policy and state", async () => {
    const f = await fixture();
    await db.update(issues).set({ executionPolicy: null, executionState: null }).where(eq(issues.id, f.issue.id));
    const res = await request(f.app).patch(`/api/issues/${f.issue.id}`).send({ status: "cancelled" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await issueService(db).getById(f.issue.id)).toMatchObject({ status: "cancelled", executionPolicy: null, executionState: null });
  });

  it("rejects state changed while waiting for the persistence row lock", async () => {
    const f = await fixture();
    const competitor = createDb(database.connectionString);
    let ready!: () => void;
    const locked = new Promise<void>(resolve => { ready = resolve; });
    let dispatched!: () => void;
    let deadline: ReturnType<typeof setTimeout>;
    const waiting = new Promise<void>((resolve, reject) => {
      dispatched = resolve;
      deadline = setTimeout(() => reject(new Error("Persistence lock query was not dispatched")), 5_000);
    });
    const previousDebug = db.$client.options.debug;
    db.$client.options.debug = (_connection, query) => { if (query.endsWith("for update")) dispatched(); };
    const changed = { ...f.history, changesRequestedCount: 3 };
    const writer = competitor.transaction(async tx => {
      await tx.select().from(issues).where(eq(issues.id, f.issue.id)).for("update");
      ready();
      await waiting;
      await tx.update(issues).set({ executionState: changed }).where(eq(issues.id, f.issue.id));
    });
    try {
      await Promise.race([locked, writer]);
      const saving = issueService(db).update(f.issue.id, { status: "cancelled",
        expectedExecutionPolicy: f.issue.executionPolicy,
        expectedExecutionPolicyTransition: executionPolicyTransitionInputFingerprint(f.issue) });
      const rejected = expect(saving).rejects.toMatchObject({ status: 409, details: { code: "execution_policy_transition_changed" } });
      await writer;
      await rejected;
      expect(await issueService(db).getById(f.issue.id)).toMatchObject({ status: "blocked", executionState: changed });
    } finally { dispatched(); clearTimeout(deadline!); await writer; db.$client.options.debug = previousDebug; await competitor.$client.end(); }
  });

  it.each(["missing", "wrong", "other-request", "exact"])("keeps stopped-run authority with a %s receipt", async receipt => {
    const f = await fixture();
    const stopId = randomUUID(), oldStopId = randomUUID();
    await db.update(heartbeatRuns).set({ status: "cancelled", errorCode: "issue_reassigned",
      resultJson: { reassignmentStopConfirmed: true, issueMutationStopId: stopId } }).where(eq(heartbeatRuns.id, f.actorRun.id));
    const saving = issueService(db).update(f.issue.id, { status: "cancelled", actorAgentId: f.manager.id,
      actorRunId: f.actorRun.id, actorRunStopId: receipt === "missing" ? undefined : receipt === "exact" ? stopId : receipt === "other-request" ? oldStopId : randomUUID(),
      expectedExecutionPolicy: f.issue.executionPolicy,
      expectedExecutionPolicyTransition: executionPolicyTransitionInputFingerprint(f.issue) });
    if (receipt === "exact") await expect(saving).resolves.toMatchObject({ status: "cancelled" });
    else await expect(saving).rejects.toMatchObject({ status: 403, details: { code: "agent_run_cancelled" } });
    expect(await issueService(db).getById(f.issue.id)).toMatchObject({ status: receipt === "exact" ? "cancelled" : "blocked" });
  });
});
