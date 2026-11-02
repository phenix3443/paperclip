import { executionDecisionInputsDigest } from "@paperclipai/shared";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  companyMemberships,
  createDb,
  issueComments,
  issueExecutionDecisions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres review hold route tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("board holds on a pending review", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-hold-routes-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seedHeldReview(changesRequestedCount: number, status: "in_review" | "blocked") {
    const companyId = randomUUID();
    const authorAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const boardUserId = "hold-board";
    const prefix = `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: `${prefix} Company`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values(
      [authorAgentId, reviewerAgentId].map((id, index) => ({
        id,
        companyId,
        name: `${prefix} Agent ${index}`,
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      })),
    );
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: boardUserId,
      status: "active",
      membershipRole: "operator",
    });
    const stageId = randomUUID();
    const issueId = randomUUID();
    const executionState = {
      status: "pending",
      currentStageId: stageId,
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewerAgentId },
      returnAssignee: { type: "agent", agentId: authorAgentId },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: "changes_requested",
      changesRequestedCount,
    };
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `${prefix}-1`,
      title: "Held review",
      status,
      priority: "medium",
      assigneeAgentId: reviewerAgentId,
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [{
          id: stageId,
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: randomUUID(), type: "agent", agentId: reviewerAgentId }],
        }],
      },
      executionState,
    });
    const board = app({
      type: "board",
      source: "session",
      userId: boardUserId,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "operator" }],
      isInstanceAdmin: false,
    });
    return { issueId, reviewerAgentId, executionState, board };
  }

  async function readIssue(issueId: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    return row!;
  }

  async function commentCount(issueId: string) {
    const rows = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    return rows.length;
  }

  async function reviewWakes(agentId: string) {
    return db
      .select()
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.agentId, agentId),
          eq(agentWakeupRequests.reason, "execution_review_requested"),
        ),
      );
  }

  async function seedHumanHold() {
    const fixture = await seedHeldReview(3, "in_review");
    const row = await readIssue(fixture.issueId);
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } })
      .where(eq(agents.id, fixture.executionState.returnAssignee.agentId));
    const previousDecisions = await db.insert(issueExecutionDecisions).values(
      [1, 2, 3].map(round => ({ companyId: row.companyId, issueId: row.id,
        stageId: fixture.executionState.currentStageId, stageType: "review", actorAgentId: fixture.reviewerAgentId,
        outcome: "changes_requested", body: `Earlier round ${round}` })),
    ).returning();
    await db.update(issues).set({
      assigneeAgentId: null, assigneeUserId: "hold-board", responsibleUserId: "hold-board",
      executionState: { ...fixture.executionState, lastDecisionId: previousDecisions[2].id,
        currentParticipant: { type: "user", userId: "hold-board" } },
      monitorNextCheckAt: new Date("2026-12-01T00:00:00.000Z"),
      monitorWakeRequestedAt: new Date("2026-11-01T00:00:00.000Z"),
      monitorLastTriggeredAt: new Date("2026-10-01T00:00:00.000Z"),
    }).where(eq(issues.id, row.id));
    return { ...fixture, previousDecisions };
  }

  it("prioritizes a stale digest over a replay and preserves matching-digest replay semantics", async () => {
    const fixture = await seedHumanHold();
    const before = await readIssue(fixture.issueId);
    const expectedExecutionDecisionDigest = await executionDecisionInputsDigest(before);
    const commentClientRequestId = randomUUID();
    await db.insert(issueComments).values({ companyId: before.companyId, issueId: before.id,
      authorUserId: "hold-board", body: "original comment", clientRequestId: commentClientRequestId });
    const payload = { status: "in_progress", comment: "different comment", commentClientRequestId };
    const stale = await request(fixture.board).patch(`/api/issues/${before.id}`).send({
      ...payload, expectedExecutionDecisionDigest: "0".repeat(64),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.details.code).toBe("execution_policy_transition_stale");
    const replay = await request(fixture.board).patch(`/api/issues/${before.id}`).send({
      ...payload, expectedExecutionDecisionDigest,
    });
    expect(replay.status).toBe(409);
    expect(replay.body.error).toContain("request ID was already used for different content");
    expect(await readIssue(before.id)).toEqual(before);
    expect(await commentCount(before.id)).toBe(1);
    expect(await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, before.id)))
      .toEqual(expect.arrayContaining(fixture.previousDecisions));
  });

  it.each(["guarded", "human"] as const)("commits only the %s winner when a caller races a human decision", async winner => {
    const fixture = await seedHumanHold();
    const before = await readIssue(fixture.issueId);
    const expectedExecutionDecisionDigest = await executionDecisionInputsDigest(before);
    const commentClientRequestId = randomUUID();
    const originalTransaction = db.transaction.bind(db);
    const arrived = Promise.withResolvers<void>();
    const firstArrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const firstCommitted = Promise.withResolvers<void>();
    let arrivals = 0;
    const spy = vi.spyOn(db, "transaction").mockImplementation(async (callback, config) => {
      const index = arrivals++;
      if (index < 2) {
        if (index === 0) firstArrived.resolve();
        if (arrivals === 2) arrived.resolve();
        await release.promise;
        const isWinner = index === (winner === "guarded" ? 0 : 1);
        if (!isWinner) await firstCommitted.promise;
        try { return await originalTransaction(callback, config); }
        finally { if (isWinner) firstCommitted.resolve(); }
      }
      return originalTransaction(callback, config);
    });
    try {
      const guarded = request(fixture.board).patch(`/api/issues/${before.id}`).send({
        status: "in_progress", comment: "Caller decision", expectedExecutionDecisionDigest,
        commentClientRequestId,
      }).then(response => response);
      await firstArrived.promise;
      const human = request(fixture.board).patch(`/api/issues/${before.id}`).send({
        status: "in_progress", comment: "Human decision",
      }).then(response => response);
      await arrived.promise;
      release.resolve();
      const responses = await Promise.all([guarded, human]);
      expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
      const rejected = responses.find(response => response.status === 409)!;
      expect(rejected.body.details.code).toBe("execution_policy_transition_stale");
      const after = await readIssue(before.id);
      expect(after.status).toBe("in_progress");
      expect(after.assigneeAgentId).toBe(fixture.executionState.returnAssignee.agentId);
      expect(after.executionPolicy).toEqual(before.executionPolicy);
      expect(after.responsibleUserId).toBe(before.responsibleUserId);
      expect(after.executionState).toMatchObject({ status: "changes_requested", changesRequestedCount: 0 });
      const replay = await request(fixture.board).patch(`/api/issues/${before.id}`).send({
        status: "in_progress", comment: "Caller decision", expectedExecutionDecisionDigest, commentClientRequestId,
      });
      expect(replay.status).toBe(409);
      expect(replay.body.details.code).toBe("execution_policy_transition_stale");
      expect(await readIssue(before.id)).toEqual(after);
      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, before.id));
      const decisions = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, before.id));
      expect(comments).toHaveLength(1);
      expect(decisions).toHaveLength(4);
      expect(decisions).toEqual(expect.arrayContaining(fixture.previousDecisions));
      expect(comments[0].body).toBe(winner === "guarded" ? "Caller decision" : "Human decision");
      expect(decisions.find(decision => !fixture.previousDecisions.some(previous => previous.id === decision.id))?.body)
        .toBe(comments[0].body);
    } finally {
      release.resolve(); firstCommitted.resolve(); spy.mockRestore();
    }
  });

  describe.each([1, 2])("with changesRequestedCount %i", (count) => {
    it("keeps the cycle through a board blocked hold and an unrelated edit, then restores the same reviewer", async () => {
      const seeded = await seedHeldReview(count, "in_review");

      const hold = await request(seeded.board)
        .patch(`/api/issues/${seeded.issueId}`)
        .send({ status: "blocked", unblockDescriptor: { owner: "board", action: "Restore the reviewer" } });
      expect(hold.status, JSON.stringify(hold.body)).toBe(200);
      let row = await readIssue(seeded.issueId);
      expect(row.status).toBe("blocked");
      expect(row.assigneeAgentId).toBe(seeded.reviewerAgentId);
      expect(row.executionState).toEqual(seeded.executionState);

      const edit = await request(seeded.board)
        .patch(`/api/issues/${seeded.issueId}`)
        .send({ priority: "high" });
      expect(edit.status, JSON.stringify(edit.body)).toBe(200);
      row = await readIssue(seeded.issueId);
      expect(row.status).toBe("blocked");
      expect(row.priority).toBe("high");
      expect(row.executionState).toEqual(seeded.executionState);
      expect(await reviewWakes(seeded.reviewerAgentId)).toHaveLength(0);

      const restore = await request(seeded.board)
        .patch(`/api/issues/${seeded.issueId}`)
        .send({ status: "in_review" });
      expect(restore.status, JSON.stringify(restore.body)).toBe(200);
      row = await readIssue(seeded.issueId);
      expect(row.status).toBe("in_review");
      expect(row.assigneeAgentId).toBe(seeded.reviewerAgentId);
      expect(row.executionState).toMatchObject({
        status: "pending",
        currentStageId: seeded.executionState.currentStageId,
        currentParticipant: seeded.executionState.currentParticipant,
        returnAssignee: seeded.executionState.returnAssignee,
        lastDecisionOutcome: "changes_requested",
        changesRequestedCount: count,
      });
      await vi.waitFor(async () => {
        expect(await reviewWakes(seeded.reviewerAgentId)).toHaveLength(1);
      });
      const decisions = await db
        .select()
        .from(issueExecutionDecisions)
        .where(eq(issueExecutionDecisions.issueId, seeded.issueId));
      expect(decisions).toHaveLength(0);
    });

    it.each(["todo", "in_progress"])("rejects a board PATCH to %s on the held review without writing", async (status) => {
      const seeded = await seedHeldReview(count, "blocked");

      const res = await request(seeded.board)
        .patch(`/api/issues/${seeded.issueId}`)
        .send({ status, comment: "Move it along." });

      expect(res.status, JSON.stringify(res.body)).toBe(422);
      const row = await readIssue(seeded.issueId);
      expect(row.status).toBe("blocked");
      expect(row.executionState).toEqual(seeded.executionState);
      expect(await commentCount(seeded.issueId)).toBe(0);
    });

    it("keeps the hold when a board user comments through PATCH or the comment route", async () => {
      const seeded = await seedHeldReview(count, "blocked");

      const patchComment = await request(seeded.board)
        .patch(`/api/issues/${seeded.issueId}`)
        .send({ comment: "Still waiting on the reviewer." });
      expect(patchComment.status, JSON.stringify(patchComment.body)).toBe(200);
      let row = await readIssue(seeded.issueId);
      expect(row.status).toBe("blocked");
      expect(row.executionState).toEqual(seeded.executionState);

      const routeComment = await request(seeded.board)
        .post(`/api/issues/${seeded.issueId}/comments`)
        .send({ body: "Still waiting on the reviewer." });
      expect(routeComment.status, JSON.stringify(routeComment.body)).toBe(201);
      row = await readIssue(seeded.issueId);
      expect(row.status).toBe("blocked");
      expect(row.assigneeAgentId).toBe(seeded.reviewerAgentId);
      expect(row.executionState).toEqual(seeded.executionState);
      expect(await commentCount(seeded.issueId)).toBe(2);
    });

    it("rejects a board PATCH reopen and keeps the cycle on an explicit comment-route reopen", async () => {
      const seeded = await seedHeldReview(count, "blocked");

      const patchReopen = await request(seeded.board)
        .patch(`/api/issues/${seeded.issueId}`)
        .send({ comment: "Reopen it.", reopen: true });
      expect(patchReopen.status, JSON.stringify(patchReopen.body)).toBe(422);
      let row = await readIssue(seeded.issueId);
      expect(row.status).toBe("blocked");
      expect(row.executionState).toEqual(seeded.executionState);
      expect(await commentCount(seeded.issueId)).toBe(0);

      const routeReopen = await request(seeded.board)
        .post(`/api/issues/${seeded.issueId}/comments`)
        .send({ body: "Reopen it.", reopen: true });
      expect(routeReopen.status, JSON.stringify(routeReopen.body)).toBe(201);
      row = await readIssue(seeded.issueId);
      expect(row.status).toBe("todo");
      expect(row.assigneeAgentId).toBe(seeded.reviewerAgentId);
      expect(row.executionState).toEqual(seeded.executionState);
      const decisions = await db
        .select()
        .from(issueExecutionDecisions)
        .where(eq(issueExecutionDecisions.issueId, seeded.issueId));
      expect(decisions).toHaveLength(0);
    });
  });
});
