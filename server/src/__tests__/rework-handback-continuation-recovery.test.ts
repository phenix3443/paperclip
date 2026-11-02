import { randomUUID } from "node:crypto";
import { and, eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  EMBEDDED_POSTGRES_TEST_TIMEOUT_MS,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { truncateTablesWithDeadlockRetry } from "./helpers/truncate-with-deadlock-retry.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Rework continued.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import {
  REWORK_HANDBACK_CONTINUATION_KEY_PREFIX,
  REWORK_HANDBACK_CONTINUATION_SOURCE,
  reworkHandbackContinuationKey,
} from "../services/recovery/rework-handback-continuation.ts";

const PARK_ERROR = "issue_continuation_waiting_on_review";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping rework hand-back recovery tests: ${support.reason ?? "unsupported host"}`);

describePostgres("rework hand-back continuation recovery", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rework-handback-");
    db = createDb(tempDb.connectionString);
    const now = new Date();
    await db.insert(authUsers).values({
      id: "responsible-user",
      name: "Responsible User",
      email: "responsible-user@example.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterEach(async () => {
    await truncateTablesWithDeadlockRetry(
      db,
      "TRUNCATE TABLE issue_recovery_actions, heartbeat_run_events, heartbeat_runs, agent_wakeup_requests, issue_comments, activity_log, issues, agents, company_memberships, companies RESTART IDENTITY CASCADE",
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  type Review = "changes_requested" | "pending";

  async function seed(input: {
    review?: Review;
    parkedRuns?: number;
    startedAt?: Date | null;
  } = {}) {
    const companyId = randomUUID();
    const executorId = randomUUID();
    const reviewerId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "responsible-user",
      status: "active",
      membershipRole: "member",
    });
    const agentRow = (id: string, name: string) => ({
      id, companyId, name, role: "engineer" as const, status: "idle" as const,
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    await db.insert(agents).values([agentRow(executorId, "Executor"), agentRow(reviewerId, "Reviewer")]);

    const review = input.review ?? "changes_requested";
    const executionPolicy = {
      mode: "normal",
      commentRequired: true,
      stages: [{
        id: "stage-1",
        type: "review",
        approvalsNeeded: 1,
        participants: [{ id: "participant-1", type: "agent", agentId: reviewerId, userId: null }],
      }],
    };
    const executionState = {
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
    const startedAt = new Date("2026-11-01T10:00:00.000Z");
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Rework after review",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: executorId,
      responsibleUserId: "responsible-user",
      executionPolicy,
      executionState,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      startedAt,
    });

    const parkedRunIds: string[] = [];
    const count = input.parkedRuns ?? 1;
    for (let index = 0; index < count; index += 1) {
      const runId = randomUUID();
      const finishedAt = new Date(startedAt.getTime() + (index + 1) * 60_000);
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId: executorId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "cancelled",
        scopeKind: "issue",
        issueId,
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_continuation_needed",
          retryReason: "issue_continuation_needed",
        },
        startedAt: input.startedAt === undefined ? null : input.startedAt,
        finishedAt,
        createdAt: finishedAt,
        updatedAt: finishedAt,
        errorCode: PARK_ERROR,
        error: "Continuation parked: issue is waiting on review/approval",
        resultJson: { stopReason: PARK_ERROR, timeoutSource: "stale_queued_run_gate" },
      });
      parkedRunIds.push(runId);
    }
    const before = await readIssue(issueId);
    return { companyId, executorId, reviewerId, issueId, parkedRunId: parkedRunIds.at(-1)!, before };
  }

  async function readIssue(issueId: string) {
    const [row] = await db.select().from(issues).where(eq(issues.id, issueId));
    return row!;
  }

  function invariants(row: Awaited<ReturnType<typeof readIssue>>) {
    return {
      assigneeAgentId: row.assigneeAgentId,
      assigneeUserId: row.assigneeUserId,
      responsibleUserId: row.responsibleUserId,
      executionPolicy: row.executionPolicy,
      executionState: row.executionState,
      lastStatusDecisionId: row.lastStatusDecisionId,
      executionWorkspaceId: row.executionWorkspaceId,
    };
  }

  function keyFor(seeded: Awaited<ReturnType<typeof seed>>) {
    return reworkHandbackContinuationKey({
      issueId: seeded.issueId,
      lastStatusDecisionId: seeded.before.lastStatusDecisionId,
      statusVersion: seeded.before.statusVersion,
      parkedRunId: seeded.parkedRunId,
    });
  }

  function keyRows(agentId: string) {
    return db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.agentId, agentId),
      like(agentWakeupRequests.idempotencyKey, `${REWORK_HANDBACK_CONTINUATION_KEY_PREFIX}%`),
    ));
  }

  function successorRuns(parkedRunId: string) {
    return db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, parkedRunId));
  }

  function ownerRepairActions(issueId: string) {
    return db.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.sourceIssueId, issueId),
      eq(issueRecoveryActions.kind, "deliberate_wait_without_target"),
    ));
  }

  function directWake(seeded: Awaited<ReturnType<typeof seed>>, key: string) {
    return heartbeatService(db).wakeup(seeded.executorId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_continuation_needed",
      payload: { issueId: seeded.issueId, retryOfRunId: seeded.parkedRunId },
      requestedByActorType: "system",
      requestedByActorId: null,
      idempotencyKey: key,
      allowRunCoalescing: false,
      issueStateGuard: {
        statuses: ["in_progress"],
        assigneeAgentId: seeded.executorId,
        statusVersion: seeded.before.statusVersion,
      },
      contextSnapshot: {
        issueId: seeded.issueId,
        taskId: seeded.issueId,
        wakeReason: "issue_continuation_needed",
        retryReason: "issue_continuation_needed",
        source: REWORK_HANDBACK_CONTINUATION_SOURCE,
        retryOfRunId: seeded.parkedRunId,
      },
    });
  }

  it("R3: requeues one ordinary continuation instead of an owner disposition repair", async () => {
    const seeded = await seed();
    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result.issueIds).toContain(seeded.issueId);
    expect(result.dispositionRepairRequeued).toBe(0);
    expect(await ownerRepairActions(seeded.issueId)).toHaveLength(0);
    const rows = await keyRows(seeded.executorId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.idempotencyKey).toBe(keyFor(seeded));
    const runs = await successorRuns(seeded.parkedRunId);
    expect(runs).toHaveLength(1);
    expect(rows[0]!.runId).toBe(runs[0]!.id);
    expect(runs[0]!.contextSnapshot).toMatchObject({
      issueId: seeded.issueId,
      wakeReason: "issue_continuation_needed",
      retryReason: "issue_continuation_needed",
      source: REWORK_HANDBACK_CONTINUATION_SOURCE,
      retryOfRunId: seeded.parkedRunId,
    });
    for (const key of ["recoveryActionId", "recoveryCause", "dispositionRepairInstruction", "dispositionRepairFingerprint"]) {
      expect(runs[0]!.contextSnapshot).not.toHaveProperty(key);
    }
    expect(runs[0]!.contextSnapshot).not.toHaveProperty("executionRetryAccounting");
    expect(invariants(await readIssue(seeded.issueId))).toEqual(invariants(seeded.before));
  });

  it("R3b: escalates after three consecutive parked continuations and queues nothing", async () => {
    const seeded = await seed({ parkedRuns: 3 });
    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result.escalated).toBeGreaterThanOrEqual(1);
    expect(await keyRows(seeded.executorId)).toHaveLength(0);
    expect(await successorRuns(seeded.parkedRunId)).toHaveLength(0);
    const after = await readIssue(seeded.issueId);
    expect(after.status).toBe("blocked");
    expect(after.assigneeAgentId).toBe(seeded.executorId);
    expect(after.executionState).toEqual(seeded.before.executionState);
  });

  it("R3c: concurrent sweeps leave one receipt and one successor run", async () => {
    const seeded = await seed();
    await Promise.all([
      heartbeatService(db).reconcileStrandedAssignedIssues(),
      heartbeatService(db).reconcileStrandedAssignedIssues(),
    ]);
    const rows = await keyRows(seeded.executorId);
    expect(rows).toHaveLength(1);
    const runs = await successorRuns(seeded.parkedRunId);
    expect(runs).toHaveLength(1);
    expect(rows[0]!.runId).toBe(runs[0]!.id);
  });

  it("R3c: a repeated request with the same key replays the bound run and writes nothing", async () => {
    const seeded = await seed();
    const key = keyFor(seeded);
    const first = await directWake(seeded, key);
    expect(first).not.toBeNull();
    const second = await directWake(seeded, key);
    expect(second?.id).toBe(first!.id);
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, first!.id));
    const third = await directWake(seeded, key);
    expect(third?.id).toBe(first!.id);
    expect(await keyRows(seeded.executorId)).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, seeded.executorId)))
      .toHaveLength(2);
  });

  it("R3c: a malformed request with the key is skipped without a receipt", async () => {
    const seeded = await seed();
    const key = keyFor(seeded);
    const run = await heartbeatService(db).wakeup(seeded.executorId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_continuation_needed",
      payload: { issueId: seeded.issueId },
      requestedByActorType: "system",
      idempotencyKey: key,
      contextSnapshot: { issueId: seeded.issueId, retryOfRunId: seeded.parkedRunId },
    });
    expect(run).toBeNull();
    expect(await keyRows(seeded.executorId)).toHaveLength(0);
  });

  it("R3c: a spent key escalates once when nothing else is live", async () => {
    const seeded = await seed();
    await db.insert(agentWakeupRequests).values({
      companyId: seeded.companyId,
      agentId: seeded.executorId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_state_guard_mismatch",
      payload: { issueId: seeded.issueId },
      status: "skipped",
      requestedByActorType: "system",
      idempotencyKey: keyFor(seeded),
      finishedAt: new Date(),
    });
    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result.escalated).toBeGreaterThanOrEqual(1);
    expect(await keyRows(seeded.executorId)).toHaveLength(1);
    expect(await successorRuns(seeded.parkedRunId)).toHaveLength(0);
    expect(await ownerRepairActions(seeded.issueId)).toHaveLength(0);
    expect((await readIssue(seeded.issueId)).status).toBe("blocked");
  });

  it("R3c: a guard denial after a status change spends the stale key and admits the new one", async () => {
    const seeded = await seed();
    const staleKey = keyFor(seeded);
    await db.update(issues).set({ statusVersion: seeded.before.statusVersion + 1 })
      .where(eq(issues.id, seeded.issueId));
    expect(await directWake(seeded, staleKey)).toBeNull();
    expect(await keyRows(seeded.executorId)).toMatchObject([{ status: "skipped", reason: "issue_state_guard_mismatch" }]);
    expect(await directWake(seeded, staleKey)).toBeNull();
    expect(await keyRows(seeded.executorId)).toHaveLength(1);

    await heartbeatService(db).reconcileStrandedAssignedIssues();
    const rows = await keyRows(seeded.executorId);
    expect(rows).toHaveLength(2);
    const fresh = rows.find((row) => row.idempotencyKey !== staleKey)!;
    expect(fresh.idempotencyKey).toContain(`:${seeded.before.statusVersion + 1}:`);
    expect(fresh.runId).toBeTruthy();
  });

  it("N1: a pending review still takes the owner disposition repair", async () => {
    const seeded = await seed({ review: "pending" });
    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result.dispositionRepairRequeued).toBe(1);
    expect(await ownerRepairActions(seeded.issueId)).toHaveLength(1);
    expect(await keyRows(seeded.executorId)).toHaveLength(0);
  });

  it("N7: a park cancel that had started keeps the failure lane", async () => {
    const seeded = await seed({ startedAt: new Date("2026-11-01T10:00:30.000Z") });
    await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(await keyRows(seeded.executorId)).toHaveLength(0);
    const runs = await successorRuns(seeded.parkedRunId);
    for (const run of runs) {
      expect(run.contextSnapshot?.source).not.toBe(REWORK_HANDBACK_CONTINUATION_SOURCE);
    }
  });
});
