import { randomUUID } from "node:crypto";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createRunDispatch, type PostCommitEffect } from "../../modules/run-dispatch/index.js";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { createHeartbeatRunState } from "./run-state.js";
import { pendingCaseHandoffForRun } from "./case-handoff-lifecycle.js";
import { buildPaperclipWakePayload } from "./run-preparation.js";
import { createHeartbeatRetries, type HeartbeatRetryDependencies } from "./retries.js";

type Run = typeof heartbeatRuns.$inferSelect;
type Agent = typeof agents.$inferSelect;

const OWNER_REPAIR_ONLY_KEYS = [
  "recoveryActionId",
  "recoveryCause",
  "dispositionRepairInstruction",
  "dispositionRepairAttempt",
  "dispositionRepairMaxAttempts",
  "dispositionRepairFingerprint",
  "dispositionRepairSourceRunId",
  "legacyDispositionEpisode",
  "bypassContinuationSummaryPark",
];
const RECOVERY_CONTRACT = "Recovery contract: your job is to RECOVER this task";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping owner repair retry tests: ${support.reason ?? "unsupported host"}`);

describePostgres("owner disposition repair retry context", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  const now = new Date("2026-11-01T12:00:00Z");

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("owner-repair-retry-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => { await database?.cleanup(); });

  afterEach(async () => {
    await db.delete(issueRecoveryActions);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
  });

  function retries() {
    const state = createHeartbeatRunState(db);
    const deps: HeartbeatRetryDependencies = {
      hasCaseHandoffForRun: async (run) => Boolean(await pendingCaseHandoffForRun(db, run.id, run.companyId)),
      getRun: state.getRun,
      getAgent: state.getAgent,
      resolveSessionBeforeForWakeup: state.resolveSessionBeforeForWakeup,
      resolveResponsibleUserIdForRunContext: vi.fn(async () => null),
      getAgentInvokability: (agent: Agent | null | undefined) => evaluateAgentInvokabilityFromDb(db, agent),
      appendRunEvent: vi.fn(async () => undefined),
      escalatePlanApprovalResumeFailureNeedsAttention: vi.fn(async () => null),
      recordPlanApprovalResumeFailureRetry: vi.fn(async () => null),
      setRunStatusIfRunning: vi.fn(async () => ({ updated: false, run: null })),
      setWakeupStatus: vi.fn(async () => undefined),
      releaseIssueExecutionAndPromote: vi.fn(async () => undefined),
      finalizeAgentStatus: vi.fn(async () => undefined),
      getWorktreeExecutionCutoff: vi.fn(async () => null),
      applyRunDispatchPostCommitEffects: vi.fn<(effects: PostCommitEffect[]) => void>(),
      runDispatch: createRunDispatch(db),
    };
    return createHeartbeatRetries(db, deps);
  }

  type ReviewState = "changes_requested" | "pending" | "none";

  function executionState(review: ReviewState, executorId: string, reviewerId: string) {
    if (review === "none") return null;
    return {
      status: review,
      currentStageId: "stage-1",
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewerId },
      returnAssignee: { type: "agent", agentId: executorId },
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: review === "changes_requested" ? "decision-1" : null,
      lastDecisionOutcome: review === "changes_requested" ? "changes_requested" : null,
      changesRequestedCount: review === "changes_requested" ? 1 : 0,
    };
  }

  async function fixture(input: {
    review: ReviewState;
    action?: {
      status: "active" | "resolved";
      cause?: string;
      owner?: "executor" | "other";
    } | null;
    legacyEpisode?: boolean;
  }) {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Owner repair", issuePrefix: `O${companyId.slice(0, 8)}` });
    const [executor] = await db.insert(agents)
      .values({ companyId, name: "Executor", adapterType: "claude_local", status: "active" }).returning();
    const [other] = await db.insert(agents)
      .values({ companyId, name: "Reviewer", adapterType: "codex_local", status: "active" }).returning();
    const [issue] = await db.insert(issues).values({
      companyId,
      title: "Rework after review",
      status: "in_progress",
      assigneeAgentId: executor.id,
      executionState: executionState(input.review, executor.id, other.id),
    }).returning();

    let actionId: string | null = null;
    if (input.action) {
      const ownerId = input.action.owner === "other" ? other.id : executor.id;
      const cause = input.action.cause ?? "deliberate_wait_without_target";
      const [action] = await db.insert(issueRecoveryActions).values({
        companyId,
        sourceIssueId: issue.id,
        kind: cause,
        status: input.action.status,
        ownerType: "agent",
        ownerAgentId: ownerId,
        returnOwnerAgentId: ownerId,
        cause,
        fingerprint: `fp-${randomUUID()}`,
        nextAction: "Revalidate the issue and record a durable disposition.",
        wakePolicy: cause === "deliberate_wait_without_target"
          ? { type: "bounded_owner_disposition_repair" }
          : { type: "wake_owner" },
        attemptCount: 1,
        maxAttempts: 3,
      }).returning();
      actionId = action.id;
    }

    const contextSnapshot: Record<string, unknown> = {
      issueId: issue.id,
      taskId: issue.id,
      wakeReason: "issue_disposition_repair",
      retryReason: "issue_disposition_repair",
      source: "issue.deliberate_wait_disposition_repair",
      ...(actionId ? { recoveryActionId: actionId } : {}),
      recoveryCause: "deliberate_wait_without_target",
      dispositionRepairFingerprint: "fp-source",
      dispositionRepairAttempt: 1,
      dispositionRepairMaxAttempts: 3,
      bypassContinuationSummaryPark: true,
      dispositionRepairInstruction: "Revalidate the issue and replace the invalid parked summary.",
      ...(input.legacyEpisode
        ? {
            legacyDispositionEpisode: { id: "episode-1", attempt: 1, maxAttempts: 3 },
            dispositionRepairSourceRunId: "source-run",
          }
        : {}),
    };
    const [run] = await db.insert(heartbeatRuns).values({
      companyId,
      agentId: executor.id,
      scopeKind: "issue",
      issueId: issue.id,
      status: "failed",
      errorCode: "server_shutdown_interrupted",
      finishedAt: now,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      contextSnapshot,
    }).returning();
    await db.update(issues).set({ executionRunId: run.id, checkoutRunId: run.id }).where(eq(issues.id, issue.id));
    const issueBefore = await readIssue(issue.id);
    return { companyId, executor, issue, run, actionId, issueBefore };
  }

  async function readIssue(issueId: string) {
    return db.select({
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      executionState: issues.executionState,
      executionPolicy: issues.executionPolicy,
    }).from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]);
  }

  async function scheduleRetry(run: Run, agent: Agent) {
    const result = await retries().scheduleBoundedRetryForRun(run, agent, { now, random: () => 0 });
    expect(result.outcome).toBe("scheduled");
    const [successor] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run.id));
    expect(successor).toBeDefined();
    const context = successor!.contextSnapshot as Record<string, unknown>;
    const payload = await buildPaperclipWakePayload({
      db,
      companyId: run.companyId,
      agentId: run.agentId,
      runId: successor!.id,
      contextSnapshot: context,
    });
    return { context, payload, prompt: renderPaperclipWakePrompt(payload) };
  }

  function expectOrdinaryRetry(scheduled: Awaited<ReturnType<typeof scheduleRetry>>, sourceRunId: string) {
    for (const key of OWNER_REPAIR_ONLY_KEYS) expect(scheduled.context).not.toHaveProperty(key);
    expect(scheduled.context).toMatchObject({
      source: "issue.rework_handback_continuation_recovery",
      retryOfRunId: sourceRunId,
      wakeReason: "transient_failure_retry",
      retryReason: "transient_failure",
    });
    expect(scheduled.context.executionRetryAccounting).toBeTruthy();
    expect(scheduled.payload?.recovery).toBeNull();
    expect(scheduled.payload?.dispositionRepair ?? null).toBeNull();
    expect(scheduled.prompt).not.toContain(RECOVERY_CONTRACT);
  }

  function expectRepairRetry(scheduled: Awaited<ReturnType<typeof scheduleRetry>>) {
    expect(scheduled.context).toMatchObject({
      source: "issue.deliberate_wait_disposition_repair",
      recoveryCause: "deliberate_wait_without_target",
      dispositionRepairFingerprint: "fp-source",
      bypassContinuationSummaryPark: true,
    });
    expect(scheduled.payload?.recovery).not.toBeNull();
    expect(scheduled.prompt).toContain(RECOVERY_CONTRACT);
  }

  it("R4: drops the repair context once the referenced owner repair is resolved", async () => {
    const f = await fixture({ review: "none", action: { status: "resolved" } });
    expectOrdinaryRetry(await scheduleRetry(f.run, f.executor), f.run.id);
    expect(await readIssue(f.issue.id)).toEqual(f.issueBefore);
  });

  it("R4b: drops the repair context on a hand-back and leaves the active action to the sweep", async () => {
    const f = await fixture({ review: "changes_requested", action: { status: "active" } });
    expectOrdinaryRetry(await scheduleRetry(f.run, f.executor), f.run.id);
    const [action] = await db.select({ status: issueRecoveryActions.status })
      .from(issueRecoveryActions).where(eq(issueRecoveryActions.id, f.actionId!));
    expect(action?.status).toBe("active");
    expect(await readIssue(f.issue.id)).toEqual(f.issueBefore);
  });

  it("R4c: drops a repair context without an action id on a hand-back", async () => {
    const f = await fixture({ review: "changes_requested", action: null });
    expectOrdinaryRetry(await scheduleRetry(f.run, f.executor), f.run.id);
    expect(await readIssue(f.issue.id)).toEqual(f.issueBefore);
  });

  it("N2b: keeps an unrelated active recovery on a hand-back", async () => {
    const f = await fixture({
      review: "changes_requested",
      action: { status: "active", cause: "successful_run_missing_state", owner: "other" },
    });
    const scheduled = await scheduleRetry(f.run, f.executor);
    expect(scheduled.context.recoveryActionId).toBe(f.actionId);
    expectRepairRetry(scheduled);
  });

  it("N5: keeps a live owner repair while review is pending", async () => {
    const f = await fixture({ review: "pending", action: { status: "active" } });
    const scheduled = await scheduleRetry(f.run, f.executor);
    expect(scheduled.context.recoveryActionId).toBe(f.actionId);
    expectRepairRetry(scheduled);
  });

  it.each([
    ["a pending review", { review: "pending" as const }],
    ["a legacy repair episode", { review: "changes_requested" as const, legacyEpisode: true }],
    ["a task without execution policy", { review: "none" as const }],
  ])("N5b: keeps a repair context without an action id for %s", async (_label, input) => {
    const f = await fixture({ ...input, action: null });
    const scheduled = await scheduleRetry(f.run, f.executor);
    expectRepairRetry(scheduled);
    if (input.legacyEpisode) expect(scheduled.context.legacyDispositionEpisode).toBeTruthy();
  });
});
