import { appendFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, authUsers, createDb, heartbeatRuns, issueExecutionDecisions, issueRecoveryActions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedReviewerIntent } from "./helpers/reviewer-intent.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createReviewerAssignmentIntent } from "../services/heartbeat/reviewer-assignment-continuation.js";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { parseIssueExecutionState } from "../services/issue-execution-policy.js";
import { verifyDispatchEvidenceSource } from "./helpers/dispatch-evidence-source.js";

const support = await getEmbeddedPostgresTestSupport();

describe("isolated original reviewer continuation evidence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    verifyDispatchEvidenceSource();
    expect(support).toMatchObject({ supported: true });
    database = await startEmbeddedPostgresTestDatabase("reviewer-continuation-evidence-");
    db = createDb(database.connectionString);
    await db.insert(authUsers).values({ id: "board", name: "Synthetic sponsor", email: "reviewer@example.test",
      createdAt: new Date(), updatedAt: new Date() });
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterEach(async () => { await heartbeatService(db).drainActiveRunExecutions(); });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function snapshot(issueId: string) {
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    return { executionPolicy: issue.executionPolicy, executionState: issue.executionState,
      responsibleUserId: issue.responsibleUserId, assigneeAgentId: issue.assigneeAgentId,
      decisions: await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, issueId)) };
  }

  async function seed() {
    const f = await seedReviewerIntent(db, false);
    const state = parseIssueExecutionState(f.issue.executionState)!;
    const decisions = await db.insert(issueExecutionDecisions).values([0, 1].map(index => ({ companyId: f.companyId,
      issueId: f.issueId, stageId: state.currentStageId!, stageType: "review", actorAgentId: f.agentId,
      outcome: "changes_requested", body: `Synthetic historical decision ${index}`, createdByRunId: f.source.id }))).returning();
    await db.update(issues).set({ executionState: { ...state, lastDecisionId: decisions[1].id,
      lastDecisionOutcome: "changes_requested", reviewRequest: { instructions: "Review synthetic submission 0123456789012345678901234567890123456789" } } })
      .where(eq(issues.id, f.issueId));
    return f;
  }

  async function evidence(label: string, f: Awaited<ReturnType<typeof seed>>, extra: Record<string, unknown> = {}) {
    if (!process.env.DISPATCH_EVIDENCE_FILE) return;
    const value = { label, cwd: process.cwd(), sourceSha: process.env.DISPATCH_EVIDENCE_SOURCE_SHA ?? "unspecified",
      database: "disposable embedded PostgreSQL", companyId: f.companyId, issueId: f.issueId, ...extra,
      databaseIdentity: (await db.execute(sql`select version() as version, current_database() as database, inet_server_port() as port`))[0],
      preserved: await snapshot(f.issueId),
      issue: (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0],
      actions: await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, f.issueId)),
      wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId)),
      runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId)) };
    await appendFile(process.env.DISPATCH_EVIDENCE_FILE, JSON.stringify(value) + "\n");
  }

  it.each(["pre-start agent_paused", "started quota failure"])("preserves resolved no-replay hold after %s even when the reviewer becomes idle", async kind => {
    const f = await seed(), before = await snapshot(f.issueId);
    const started = kind === "started quota failure";
    await db.update(agents).set({ status: "paused", pauseReason: started ? "quota" : "manual" }).where(eq(agents.id, f.agentId));
    const [failed] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, runtimeMode: "legacy",
      status: "failed", errorCode: started ? "quota_exceeded" : "agent_paused", startedAt: started ? new Date() : null,
      finishedAt: new Date(), contextSnapshot: { issueId: f.issueId, wakeReason: "execution_review_requested" },
      resultJson: started ? { providerWorkStarted: true, actionOutcome: "unknown" }
        : { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }).returning();
    await db.update(issues).set({ executionRunId: failed.id }).where(eq(issues.id, f.issueId));
    const [action] = await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId,
      kind: "active_run_watchdog", status: "active", ownerType: "board", returnOwnerAgentId: f.agentId,
      cause: "legacy_execution_requires_reconciliation", fingerprint: failed.id, evidence: { runId: failed.id },
      nextAction: "Synthetic reconciliation remains unverified" }).returning();
    await settleUnrecoverableExecutions(db);
    const [settled] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id));
    expect(settled).toMatchObject({ status: "resolved", outcome: "blocked", evidence: {
      reviewHoldBlock: { runId: failed.id, previousStatus: "in_review", stageId: parseIssueExecutionState(before.executionState)!.currentStageId },
      automaticRecovery: { policy: "preserve_without_replay_v1", replay: "blocked" } } });
    await db.update(agents).set({ status: "idle", pauseReason: null }).where(eq(agents.id, f.agentId));
    const receipt = await db.transaction(tx => createReviewerAssignmentIntent(tx, { companyId: f.companyId, issueId: f.issueId,
      sourceRunId: f.source.id, requestedByActorType: "agent", requestedByActorId: f.source.agentId }));
    expect(receipt).toBeNull();
    await heartbeatService(db).reconcileReviewerAssignments();
    expect(await snapshot(f.issueId)).toEqual(before);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0].status).toBe("blocked");
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({ recoveryActionId: action.id });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(1);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action.id)))[0]).toEqual(settled);
    await evidence(`resolved-no-replay-${kind}`, f, { sourceRunId: f.source.id, failedRunId: failed.id,
      continuationReceipt: receipt, refusal: "createReviewerAssignmentIntent requires in_review; resolved action remains an execution blocker" });
  });

  it("does not invent an outbox for a skipped paused assignment when no matching intent exists", async () => {
    const f = await seed(), before = await snapshot(f.issueId);
    await db.update(agents).set({ status: "paused", pauseReason: "manual" }).where(eq(agents.id, f.agentId));
    const service = heartbeatService(db);
    await expect(service.wakeup(f.agentId, { source: "assignment", reason: "execution_review_requested",
      payload: { issueId: f.issueId }, requestedByActorType: "agent", requestedByActorId: f.source.agentId }))
      .rejects.toThrow("Agent is not invokable in its current state");
    await db.update(agents).set({ status: "idle", pauseReason: null }).where(eq(agents.id, f.agentId));
    await service.reconcileReviewerAssignments();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(0);
    expect(await snapshot(f.issueId)).toEqual(before);
    await evidence("skipped-without-intent", f, { refusal: "no matching durable reviewer assignment intent" });
  });

  it("binds an eligible original-reviewer intent to one queued successor across service instances", async () => {
    const f = await seed(), before = await snapshot(f.issueId);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    const receipt = await db.transaction(tx => createReviewerAssignmentIntent(tx, { companyId: f.companyId, issueId: f.issueId,
      sourceRunId: f.source.id, requestedByActorType: "agent", requestedByActorId: f.source.agentId }));
    expect(receipt).toBeTruthy();
    await Promise.all([heartbeatService(db).reconcileReviewerAssignments(), heartbeatService(db).reconcileReviewerAssignments()]);
    const [consumed] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt!.id));
    expect(consumed).toMatchObject({ status: "coalesced", agentId: f.agentId });
    expect(consumed.runId).toBeTruthy();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, consumed.runId!));
    expect(run).toMatchObject({ agentId: f.agentId, status: "queued", startedAt: null, responsibleUserId: "board" });
    expect(await snapshot(f.issueId)).toEqual(before);
    await evidence("original-reviewer-queued-positive", f, { sourceRunId: f.source.id, receiptBefore: receipt,
      receiptAfter: consumed, providerStart: "absent; reviewer held busy in this control" });
  });

  it.each(["manual", null])("retains a matching intent while pause provenance is %s", async pauseReason => {
    const f = await seed(), before = await snapshot(f.issueId);
    const receipt = await db.transaction(tx => createReviewerAssignmentIntent(tx, { companyId: f.companyId, issueId: f.issueId,
      sourceRunId: f.source.id, requestedByActorType: "agent", requestedByActorId: f.source.agentId }));
    expect(receipt).toBeTruthy();
    await db.update(agents).set({ status: "paused", pauseReason }).where(eq(agents.id, f.agentId));
    await heartbeatService(db).reconcileReviewerAssignments();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(0);
    const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt!.id));
    expect(after).toMatchObject({ status: "deferred_issue_execution", runId: null });
    expect(await snapshot(f.issueId)).toEqual(before);
    await evidence("paused-matching-intent", f, { pauseReason, receiptBefore: receipt, receiptAfter: after });
  });

  it.each(["submission", "return-owner", "participant", "responsible-user", "decision"])("retires a stale intent after the %s changes without rewriting review history", async changed => {
    const f = await seed();
    const receipt = await db.transaction(tx => createReviewerAssignmentIntent(tx, { companyId: f.companyId, issueId: f.issueId,
      sourceRunId: f.source.id, requestedByActorType: "agent", requestedByActorId: f.source.agentId }));
    expect(receipt).toBeTruthy();
    const before = await snapshot(f.issueId), state = parseIssueExecutionState(before.executionState)!;
    const executionState = { ...state };
    if (changed === "submission") executionState.reviewRequest = { instructions: "Review synthetic replacement submission 2222222222222222222222222222222222222222" };
    if (changed === "return-owner") executionState.returnAssignee = { type: "agent", agentId: f.agentId };
    if (changed === "participant") executionState.currentParticipant = { type: "agent", agentId: f.source.agentId };
    if (changed === "decision") executionState.lastDecisionId = before.decisions[0].id;
    await db.update(issues).set({ executionState, ...(changed === "responsible-user" ? { responsibleUserId: "replacement-sponsor" } : {}) })
      .where(eq(issues.id, f.issueId));
    const changedSnapshot = await snapshot(f.issueId);
    await heartbeatService(db).reconcileReviewerAssignments();
    const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, receipt!.id));
    expect(after).toMatchObject({ status: "cancelled", runId: null, payload: receipt!.payload });
    expect(after.error).toMatch(/superseded/);
    expect(await snapshot(f.issueId)).toEqual(changedSnapshot);
    expect(changedSnapshot.decisions).toEqual(before.decisions);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(0);
    await evidence(`stale-reviewer-intent-${changed}`, f, { receiptBefore: receipt, receiptAfter: after });
  });
});
