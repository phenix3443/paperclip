import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  authUsers,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueExecutionDecisions,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.js";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";
import { executionBlockerPredicate, getExecutionBlocker } from "../services/execution-blocker.js";
import { hasLiveLegacyController } from "../services/legacy-controller-lease.js";
import { runningProcesses } from "../adapters/index.js";
import { continueDecidedReviewReassignments } from "../services/decided-review-reassignment.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres decided review continuation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const CONTROLLER_HELPER = fileURLToPath(new URL("./helpers/legacy-controller-process.ts", import.meta.url));
const SERVER_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 10_000, label = "condition") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describeEmbeddedPostgres("decided review continuation after an expected reviewer reassignment stop", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;
  let scratch: string;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const priorInWorktree = process.env.PAPERCLIP_IN_WORKTREE;
  // Every process a test starts, killed in afterEach whatever the outcome.
  const ownedPids = new Set<number>();
  const ownedGroups = new Set<number>();
  const ownedChildren = new Set<ChildProcess>();

  beforeAll(async () => {
    // Route handlers build their own heartbeat service from process.env. A
    // local worktree marker would suppress the scheduling under test.
    delete process.env.PAPERCLIP_IN_WORKTREE;
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-decided-review-");
    db = createDb(tempDb.connectionString);
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-decided-review-"));
    heartbeat = heartbeatService(db, { runtimeEnv: {} });
  }, 30_000);

  async function killOwned() {
    delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    for (const group of ownedGroups) { try { process.kill(-group, "SIGKILL"); } catch { /* gone */ } }
    for (const pid of ownedPids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    for (const child of ownedChildren) child.kill("SIGKILL");
    await waitFor(() => [...ownedPids].every(pid => !isAlive(pid)), 5_000, "owned processes to exit").catch(() => undefined);
    ownedPids.clear(); ownedGroups.clear(); ownedChildren.clear();
  }

  afterEach(async () => {
    await killOwned();
    await heartbeat.drainActiveRunExecutions();
    await db.delete(environmentLeases);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(issueExecutionDecisions);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentTaskSessions);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
    await db.delete(authUsers);
  }, 30_000);

  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    await tempDb?.cleanup();
    await fs.rm(scratch, { recursive: true, force: true });
    if (priorInWorktree === undefined) delete process.env.PAPERCLIP_IN_WORKTREE;
    else process.env.PAPERCLIP_IN_WORKTREE = priorInWorktree;
  });

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => { (req as any).actor = actor; next(); });
    testApp.use("/api", issueRoutes(db, {} as any));
    testApp.use(errorHandler);
    return testApp;
  }

  // Synthetic fixture: an issue already in review. The reviewer uses a local
  // sessioned adapter whose CLI is a script the test controls: it waits for a
  // gate file, then exits 0 without output, so losing its parent cannot break
  // it with SIGPIPE. Probe invocations (no turn arguments) exit at once.
  async function seedReview() {
    const companyId = randomUUID();
    const userId = randomUUID();
    const authorId = randomUUID();
    const reviewerId = randomUUID();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const prefix = `DR${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`;
    const gate = path.join(scratch, `${randomUUID()}.gate`);
    const cli = path.join(scratch, `${randomUUID()}-reviewer-cli.cjs`);
    await fs.writeFile(cli, `#!/usr/bin/env node
const fs = require("node:fs");
if (!process.argv.includes("--output-format")) process.exit(0);
const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) { clearInterval(timer); process.exit(0); } }, 25);
`, "utf8");
    await fs.chmod(cli, 0o755);
    await db.insert(authUsers).values({ id: userId, name: "Operator", email: `${userId}@example.test`, emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Review Co", issuePrefix: prefix, requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: userId });
    await db.insert(agents).values([
      { id: authorId, companyId, name: "Author", role: "engineer", status: "idle", adapterType: "process",
        adapterConfig: { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"] }, runtimeConfig: {}, permissions: {} },
      { id: reviewerId, companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "gemini_local",
        adapterConfig: { engine: "cli", command: cli, cwd: scratch }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } }, permissions: {} },
    ]);
    await db.insert(issues).values({
      id: issueId, companyId, title: "Review the change", status: "in_review", priority: "medium",
      assigneeAgentId: reviewerId, issueNumber: 1, identifier: `${prefix}-1`,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId: reviewerId }] }] },
      executionState: {
        status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerId }, returnAssignee: { type: "agent", agentId: authorId },
        reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, changesRequestedCount: 0,
      },
    });
    return { companyId, userId, authorId, reviewerId, issueId, stageId, gate, cli };
  }
  type Fixture = Awaited<ReturnType<typeof seedReview>>;

  /** Declared synthetic: a running legacy reviewer whose controller crashed.
   * The child is real and owns its process group; the controller boot id is
   * foreign and its lease already expired, as test 1 produces with real time. */
  async function seedDetachedLegacyReviewerRun(f: Fixture) {
    const child = spawn(f.cli, ["--output-format", "stream-json"], { detached: true, stdio: "ignore" });
    ownedChildren.add(child); ownedPids.add(child.pid!); ownedGroups.add(child.pid!);
    const runId = randomUUID();
    const wakeId = randomUUID();
    const startedAt = new Date(Date.now() - 60_000);
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: f.companyId, agentId: f.reviewerId, source: "assignment",
      triggerDetail: "system", reason: "execution_review_requested", payload: { issueId: f.issueId }, status: "claimed", runId, claimedAt: startedAt });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: f.companyId, agentId: f.reviewerId, invocationSource: "assignment", triggerDetail: "system",
      status: "running", wakeupRequestId: wakeId, runtimeMode: "legacy", runtimeModeResolvedAt: startedAt, startedAt,
      processPid: child.pid!, processGroupId: child.pid!, processStartedAt: startedAt,
      controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now() - 1_000),
      contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "execution_review_requested" },
      responsibleUserId: f.userId,
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));
    return { runId, pid: child.pid!, processGroupId: child.pid! };
  }

  /** Production: the reaper finds a live child without an owning controller. */
  async function reapToDetached(runId: string) {
    await heartbeat.reapOrphanedRuns();
    const run = await heartbeat.getRun(runId);
    expect(run).toMatchObject({ status: "running", errorCode: "process_detached" });
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    expect(events.some(event => (event.payload as Record<string, unknown> | null)?.ownedProcessHandle === false)).toBe(true);
  }

  /** Production: the reviewer requests changes as R, which reassigns the task
   * to the author and stops R through the same mutation. */
  async function recordDecision(f: Fixture, runId: string) {
    const response = await request(app({ type: "agent", source: "agent_key", companyId: f.companyId, agentId: f.reviewerId, runId }))
      .patch(`/api/issues/${f.issueId}`).send({ status: "in_progress", comment: "Please handle the empty input case." });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const run = (await heartbeat.getRun(runId))!;
    expect(run).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned" });
    expect(run.resultJson).toMatchObject({ reassignmentStopConfirmed: true, issueMutationStopId: expect.any(String),
      cancellation: { source: "control_plane", expected: true } });
    const [decision] = await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId));
    expect(decision).toMatchObject({ createdByRunId: runId, outcome: "changes_requested", actorAgentId: f.reviewerId });
    // The real cancel-time hold exists, and source revalidation retires it when
    // the task moves to the author.
    const [cancelTimeHold] = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.fingerprint, `legacy-execution:${runId}`));
    expect(cancelTimeHold).toMatchObject({ status: "cancelled" });
    return decision!;
  }

  /** The explicit physical stop. Records whether the cancel already ended the
   * child; otherwise the gate opens and the child exits on its own. Afterwards
   * nothing blocks the task. */
  async function stopReviewerChild(f: Fixture, pid: number, processGroupId: number) {
    const endedByCancel = !isAlive(pid) && !isAlive(-processGroupId);
    await fs.writeFile(f.gate, "open");
    await waitFor(() => !isAlive(pid) && !isAlive(-processGroupId), 5_000, "reviewer child to exit");
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    return { endedByCancel };
  }

  /** Production: the decision woke the author, whose real run resubmits.
   * The reported incident shows no reviewer run between the resubmission and
   * the Board comment, so its review request was never admitted. Declared
   * stand-in for that unobserved cause: the scheduling gate suppresses the
   * request (a skipped receipt, no run). Without it the request starts a
   * reviewer run and nothing needs recovery. */
  async function resubmitWithSuppressedReviewRequest(f: Fixture) {
    let authorRunId = "";
    await waitFor(async () => {
      const [run] = await db.select().from(heartbeatRuns).where(and(
        eq(heartbeatRuns.agentId, f.authorId), eq(heartbeatRuns.status, "running"),
      ));
      authorRunId = run?.id ?? "";
      return Boolean(run?.processPid);
    }, 10_000, "the author's run to start");
    const resubmittedAt = new Date();
    process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS = "true";
    try {
      const response = await request(app({ type: "agent", source: "agent_key", companyId: f.companyId, agentId: f.authorId, runId: authorRunId }))
        .patch(`/api/issues/${f.issueId}`).send({ status: "done", comment: "Handled the empty input case." });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      // The route sends the review request after responding.
      await waitFor(async () => (await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.agentId, f.reviewerId), eq(agentWakeupRequests.reason, "heartbeat.scheduling_suppressed"),
      ))).length === 1, 5_000, "the suppressed review request");
    } finally {
      delete process.env.PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS;
    }
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(task).toMatchObject({ status: "in_review", assigneeAgentId: f.reviewerId });
    expect(await heartbeat.getRun(authorRunId)).toMatchObject({ status: "cancelled", errorCode: "issue_reassigned" });
    expect(await reviewerRunsAfter(f, resubmittedAt)).toEqual([]);
    return { resubmittedAt, authorRunId };
  }

  async function snapshotReviewHistory(f: Fixture) {
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    return {
      executionState: task!.executionState,
      decisions: await db.select().from(issueExecutionDecisions).where(eq(issueExecutionDecisions.issueId, f.issueId))
        .orderBy(asc(issueExecutionDecisions.createdAt)),
    };
  }

  async function reviewerRunsAfter(f: Fixture, after: Date) {
    return db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.agentId, f.reviewerId), gt(heartbeatRuns.createdAt, after),
      sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`,
    )).orderBy(asc(heartbeatRuns.createdAt));
  }

  async function scan() { return heartbeat.reconcileStrandedAssignedIssues(); }
  async function sweep() { return settleUnrecoverableExecutions(db); }
  async function pass() { return continueDecidedReviewReassignments(db, heartbeat.wakeup); }

  /** Let every admitted run finish, then let release/promotion settle. */
  async function drain(f: Fixture) {
    await waitFor(async () => {
      const live = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`,
        sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`,
      ));
      return live.length === 0;
    }, 15_000, "issue runs to finish");
    await heartbeat.drainActiveRunExecutions();
    const deferred = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.status, "deferred_issue_execution"), sql`${agentWakeupRequests.payload}->>'issueId' = ${f.issueId}`,
    ));
    expect(deferred).toEqual([]);
  }

  /** Execution holds that keep reviewer dispatch blocked. */
  async function blockingHolds(f: Fixture) {
    return db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.sourceIssueId, f.issueId), executionBlockerPredicate(),
    ));
  }

  /** Exactly one reviewer turn was admitted for the resubmission. A turn
   * that ends without a decision keeps baseline follow-ups (retries of that
   * turn); those descend from it and are not further continuations. Parked
   * attempts the stale gate cancelled before dispatch never ran. */
  async function expectOneSuccessor(f: Fixture, after: Date) {
    const runs = (await reviewerRunsAfter(f, after)).filter(run => run.errorCode !== "execution_reconciliation_required");
    const roots = runs.filter(run => !run.retryOfRunId);
    expect(roots).toHaveLength(1);
    const successor = roots[0]!;
    const lineage = new Set([successor.id]);
    for (const run of runs) if (run.retryOfRunId && lineage.has(run.retryOfRunId)) lineage.add(run.id);
    expect(runs.filter(run => !lineage.has(run.id))).toEqual([]);
    expect(successor.contextSnapshot?.decidedReviewContinuation).toBeTruthy();
    return successor;
  }

  async function expectSingleContinuation(f: Fixture, input: {
    resubmittedAt: Date; history: Awaited<ReturnType<typeof snapshotReviewHistory>>; sourceRunId: string;
  }) {
    const successor = await expectOneSuccessor(f, input.resubmittedAt);
    expect(successor.contextSnapshot).toMatchObject({
      forceFreshSession: true,
      decidedReviewContinuation: { sourceRunId: input.sourceRunId, decisionId: input.history.decisions.at(-1)!.id },
    });
    expect(successor.contextSnapshot).not.toHaveProperty("previousRunId");
    expect(await blockingHolds(f)).toEqual([]);
    const settled = await db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.sourceIssueId, f.issueId),
      sql`${issueRecoveryActions.evidence} ? 'decidedReviewContinuation'`,
    ));
    expect(settled.length).toBeGreaterThan(0);
    for (const hold of settled) {
      expect(hold.evidence.decidedReviewContinuation).toMatchObject({ sourceRunId: input.sourceRunId, successorRunId: successor.id });
    }
    expect(await db.select().from(issueComments).where(and(
      eq(issueComments.issueId, f.issueId), eq(issueComments.authorType, "user"),
    ))).toEqual([]);
    expect(await snapshotReviewHistory(f)).toEqual(input.history);
    return successor;
  }

  it("continues the review once after a detached reviewer recorded its decision and was stopped by reassignment", async () => {
    const f = await seedReview();
    // Real launch in a separate controller process, so its in-memory process
    // tracking and lease renewal really disappear when that process dies.
    const controller = spawn(process.execPath, ["--import", "tsx", CONTROLLER_HELPER], {
      cwd: SERVER_ROOT,
      stdio: ["ignore", "pipe", "inherit", "ipc"],
      env: { ...process.env, PAPERCLIP_IN_WORKTREE: "", DECIDED_REVIEW_DATABASE_URL: tempDb!.connectionString,
        DECIDED_REVIEW_AGENT_ID: f.reviewerId, DECIDED_REVIEW_ISSUE_ID: f.issueId },
    });
    ownedChildren.add(controller); ownedPids.add(controller.pid!);
    const ready = await new Promise<{ runId: string; pid: number; processGroupId: number }>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("controller did not report a running reviewer")), 30_000);
      controller.stdout!.on("data", chunk => {
        buffer += String(chunk);
        const line = buffer.split("\n").find(entry => entry.trim().startsWith("{"));
        if (line) { clearTimeout(timer); resolve(JSON.parse(line)); }
      });
      controller.once("exit", code => { clearTimeout(timer); reject(new Error(`controller exited early: ${code}`)); });
    });
    ownedPids.add(ready.pid); ownedGroups.add(ready.processGroupId);
    const runId = ready.runId;
    // This process never launched R, and the controller still owns it.
    expect(runningProcesses.has(runId)).toBe(false);
    const launched = (await heartbeat.getRun(runId))!;
    expect(await hasLiveLegacyController(db, launched)).toBe(true);

    const controllerExit = new Promise(resolve => controller.once("exit", resolve));
    controller.kill("SIGKILL");
    await controllerExit;
    expect(isAlive(ready.pid)).toBe(true);
    expect(isAlive(-ready.processGroupId)).toBe(true);
    const leaseAtKill = (await heartbeat.getRun(runId))!.controllerLeaseExpiresAt;
    await waitFor(async () => !(await hasLiveLegacyController(db, (await heartbeat.getRun(runId))!)), 75_000, "controller lease to expire");
    expect((await heartbeat.getRun(runId))!.controllerLeaseExpiresAt).toEqual(leaseAtKill);

    await reapToDetached(runId);
    expect(await heartbeat.getRun(runId)).toMatchObject({ processPid: ready.pid, processGroupId: ready.processGroupId });

    await recordDecision(f, runId);
    await stopReviewerChild(f, ready.pid, ready.processGroupId);
    await sweep();
    const { resubmittedAt } = await resubmitWithSuppressedReviewRequest(f);
    const history = await snapshotReviewHistory(f);

    await scan();
    await pass();
    // Admitted while still in review: the sweep has nothing left to block.
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]!.status).toBe("in_review");
    await sweep();
    await drain(f);
    for (let i = 0; i < 2; i += 1) { await scan(); await pass(); await sweep(); }
    await drain(f);

    await expectSingleContinuation(f, { resubmittedAt, history, sourceRunId: runId });
  }, 120_000);

  it("restores and continues a review the sweep blocked for the decided reviewer", async () => {
    const f = await seedReview();
    const r = await seedDetachedLegacyReviewerRun(f);
    await reapToDetached(r.runId);
    await recordDecision(f, r.runId);
    await stopReviewerChild(f, r.pid, r.processGroupId);
    // The environment has not finished releasing, so the stop is not proved yet.
    const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: r.runId, provider: "local" }).returning();
    const { resubmittedAt } = await resubmitWithSuppressedReviewRequest(f);
    const history = await snapshotReviewHistory(f);

    await scan();
    await sweep();
    const [blocked] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(blocked!.status).toBe("blocked");
    const [hold] = await blockingHolds(f);
    expect(hold!.evidence.reviewHoldBlock).toEqual({
      runId: r.runId, statusVersion: blocked!.statusVersion, previousStatus: "in_review",
      stageId: f.stageId, lastDecisionId: history.decisions[0]!.id,
    });
    await pass();
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]!.status).toBe("blocked");
    expect(await reviewerRunsAfter(f, resubmittedAt)).toEqual([]);

    await db.update(environmentLeases).set({ releasedAt: new Date(), status: "released" }).where(eq(environmentLeases.id, lease!.id));
    await pass();
    const [restored] = await db.select().from(issues).where(eq(issues.id, f.issueId));
    expect(restored!.status).toBe("in_review");
    expect(restored!.executionState).toEqual(history.executionState);
    await drain(f);
    for (let i = 0; i < 2; i += 1) { await scan(); await pass(); await sweep(); }
    await drain(f);
    await expectSingleContinuation(f, { resubmittedAt, history, sourceRunId: r.runId });
  }, 60_000);

  it.each(["held by the decided reviewer only", "also held by a pre-fix hold on the parked attempt"])(
    "keeps the decided reviewer as the source when parked attempts exist (%s)",
    async (variant) => {
      const f = await seedReview();
      const r = await seedDetachedLegacyReviewerRun(f);
      await reapToDetached(r.runId);
      await recordDecision(f, r.runId);
      await stopReviewerChild(f, r.pid, r.processGroupId);
      const [lease] = await db.insert(environmentLeases).values({ companyId: f.companyId, issueId: f.issueId, heartbeatRunId: r.runId, provider: "local" }).returning();
      const { resubmittedAt } = await resubmitWithSuppressedReviewRequest(f);
      const history = await snapshotReviewHistory(f);
      await scan();
      const [rHold] = await blockingHolds(f);
      expect(rHold!.evidence.runId).toBe(r.runId);

      // Declared seeded: a reviewer attempt already queued when the hold is
      // observed. Its cancellation runs through the real dispatch gate.
      const seedQueued = async () => {
        const id = randomUUID();
        await db.insert(heartbeatRuns).values({ id, companyId: f.companyId, agentId: f.reviewerId, invocationSource: "assignment",
          triggerDetail: "system", status: "queued", contextSnapshot: { issueId: f.issueId, taskId: f.issueId, wakeReason: "execution_review_requested" },
          responsibleUserId: f.userId });
        return id;
      };
      const q1 = await seedQueued();
      await heartbeat.resumeQueuedRuns();
      const cancelledQ1 = (await heartbeat.getRun(q1))!;
      expect(cancelledQ1).toMatchObject({ status: "cancelled", errorCode: "execution_reconciliation_required", startedAt: null });
      expect(cancelledQ1.resultJson).toMatchObject({ stopReason: "execution_reconciliation_required", timeoutSource: "stale_queued_run_gate",
        executionWait: { issueId: f.issueId, recoveryActionId: rHold!.id } });
      if (variant !== "held by the decided reviewer only") {
        // Declared seeded: the hold pre-fix scans put on the parked attempt.
        await db.insert(issueRecoveryActions).values({ companyId: f.companyId, sourceIssueId: f.issueId, kind: "active_run_watchdog",
          status: "resolved", outcome: "blocked", ownerType: "board", returnOwnerAgentId: f.reviewerId,
          cause: "legacy_execution_requires_reconciliation", fingerprint: `legacy-execution:${q1}`,
          nextAction: "Inspect the stopped provider and recorded actions, then reconcile their outcomes before continuing.",
          evidence: { runId: q1, originalFailureCode: "execution_reconciliation_required", adapterRecovery: "unsupported_or_unknown", attempt: 1,
            automaticRecovery: { policy: "preserve_without_replay_v1", runId: q1, replay: "blocked", actionOutcome: "unknown", recordedAt: new Date().toISOString() } },
          resolvedAt: new Date() });
        const q2 = await seedQueued();
        await heartbeat.resumeQueuedRuns();
        expect(await heartbeat.getRun(q2)).toMatchObject({ status: "cancelled", errorCode: "execution_reconciliation_required" });
      }
      const holdIdsBefore = (await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions)
        .where(eq(issueRecoveryActions.sourceIssueId, f.issueId))).map(row => row.id);

      for (let i = 0; i < 3; i += 1) await scan();
      await sweep();
      await db.update(environmentLeases).set({ releasedAt: new Date(), status: "released" }).where(eq(environmentLeases.id, lease!.id));
      await pass();
      await drain(f);
      for (let i = 0; i < 2; i += 1) { await scan(); await pass(); await sweep(); }
      await drain(f);

      const created = await db.select().from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.sourceIssueId, f.issueId), sql`${issueRecoveryActions.fingerprint} like 'legacy-execution:%'`,
      ));
      expect(created.filter(hold => !holdIdsBefore.includes(hold.id))).toEqual([]);
      const successor = await expectSingleContinuation(f, { resubmittedAt, history, sourceRunId: r.runId });
      for (const hold of created.filter(row => row.evidence.decidedReviewContinuation && row.evidence.runId !== r.runId)) {
        expect(hold.evidence.automaticRecovery).toMatchObject({ actionOutcome: "not_performed" });
        expect(hold.evidence.decidedReviewContinuation).toMatchObject({ successorRunId: successor.id });
      }
    },
    60_000,
  );
});
