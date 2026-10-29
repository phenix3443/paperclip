import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("review submission generation", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("review-submission-generation-");
    db = createDb(fixture.connectionString);
    await db.insert(authUsers).values({ id: "board", name: "Review sponsor", email: "sponsor@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 90_000);
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterAll(async () => { await db?.$client.end(); await fixture?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), authorId = randomUUID(), issueId = randomUUID(), stageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Consumer fixture", issuePrefix: "C" + companyId.slice(0, 7), defaultResponsibleUserId: "board" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board",
      membershipRole: "operator", status: "active" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
      { id: authorId, companyId, name: "Author", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
    ]);
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Pending review", status: "in_review",
      responsibleUserId: "board", assigneeAgentId: agentId,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId }] }] },
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", agentId }, returnAssignee: { type: "agent", agentId: authorId },
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, changesRequestedCount: 2,
        reviewRequest: { instructions: "Review the same submission" } } }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId: authorId, status: "cancelled",
      errorCode: "issue_reassigned", finishedAt: new Date(), responsibleUserId: "board", contextSnapshot: { issueId },
      resultJson: { executionCancellation: { state: "acknowledged" }, reassignmentStopConfirmed: true } }).returning();
    return { companyId, agentId, issueId, source, issue };
  }

  it.each([false, true])("preserves same-submission merged comments (locked: %s)", async locked => {
    const f = await seed();
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" }).returning();
    const marker = join(tmpdir(), `inline-comment-${randomUUID()}`);
    await db.update(agents).set({ adapterConfig: { command: process.execPath,
      args: ["-e", `require('node:fs').appendFileSync(${JSON.stringify(marker)},process.env.PAPERCLIP_RUN_ID+'\\n')`] } }).where(eq(agents.id, f.agentId));
    const service = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    async function commentWake(body: string) {
      const [comment] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId, authorUserId: "board", body }).returning();
      const run = await service.wakeup(f.agentId, { source: "automation", reason: "issue_commented",
        payload: { issueId: f.issueId, commentId: comment.id }, contextSnapshot: { wakeCommentId: comment.id },
        requestedByActorType: "user", requestedByActorId: "board" });
      return { run, comment };
    }
    try {
      const first = await commentWake("FIRST_INLINE_BODY_177");
      expect(first.run).toBeTruthy();
      if (locked) await db.update(issues).set({ executionRunId: first.run!.id }).where(eq(issues.id, f.issueId));
      const second = await commentWake("SECOND_INLINE_BODY_177");
      expect(second.run?.id).toBe(first.run!.id);
      const [queued] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first.run!.id));
      const [root] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, first.run!.wakeupRequestId!));
      const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
      expect(wakes.find(w => w.payload?.commentId === second.comment.id)?.runId).toBe(first.run!.id);
      await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, busy.id));
      await service.resumeQueuedRuns(); await service.drainActiveRunExecutions();
      const [finished] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, first.run!.id));
      console.log("INLINE_REPRO", JSON.stringify({ locked, first: first.comment.id, second: second.comment.id,
        beforeIds: queued.contextSnapshot?.wakeCommentIds, rootIds: root.payload?._paperclipWakeContext,
        afterIds: finished.contextSnapshot?.wakeCommentIds, status: finished.status,
        providerRunIds: await readFile(marker, "utf8") }));
      expect(finished.status).toBe("succeeded");
      expect(finished.contextSnapshot?.wakeCommentIds).toEqual(expect.arrayContaining([first.comment.id, second.comment.id]));
    } finally { await service.drainActiveRunExecutions(); await rm(marker, { force: true }); }
  });
});
