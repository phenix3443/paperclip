import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { truncateTablesWithDeadlockRetry } from "./helpers/truncate-with-deadlock-retry.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Addressee review dispatch test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres addressee review dispatch tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

/**
 * Route-level proof that a question card addressed to an agent other than the
 * current review participant reaches that agent: the real interaction route
 * enqueues the wake, the real heartbeat queue claims it, and the run-dispatch
 * gates let it reach an inert adapter while the task stays in review.
 */
describeEmbeddedPostgres("pending interaction addressee dispatch during review (routes + postgres)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const executeCallsForAgent = (agentId: string) =>
    mockAdapterExecute.mock.calls.filter(([context]) => (context as { agent?: { id?: string } })?.agent?.id === agentId);

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-addressee-review-dispatch-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
  }, 30_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await truncateTablesWithDeadlockRetry(
      db,
      `
        TRUNCATE TABLE
          "issue_thread_interactions",
          "issue_comments",
          "issues",
          "heartbeat_run_events",
          "cost_events",
          "activity_log",
          "heartbeat_runs",
          "agent_wakeup_requests",
          "agent_runtime_state",
          "company_memberships",
          "agents",
          "companies"
        RESTART IDENTITY CASCADE
      `,
      { attempts: 10, delayMs: () => 100 },
    );
  });

  afterAll(async () => {
    await db.$client.end();
    await tempDb?.cleanup();
  });

  function app(actor: Record<string, unknown>) {
    const testApp = express();
    testApp.use(express.json());
    testApp.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    testApp.use("/api", issueRoutes(db, {} as any, {}));
    testApp.use(errorHandler);
    return testApp;
  }

  async function seedReviewFixture() {
    const companyId = randomUUID();
    const userId = "addressee-review-user";
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `A${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: userId,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(authUsers).values({
      id: userId,
      name: "Fixture user",
      email: "addressee-review-user@example.test",
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "operator",
    });
    const agentValues = (name: string, role: string) => ({
      companyId,
      name,
      role,
      status: "idle" as const,
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    const [assignee, reviewer, addressee] = await db.insert(agents).values([
      agentValues("AssigneeCoder", "engineer"),
      agentValues("ReviewerCoder", "qa"),
      agentValues("AddresseeCto", "cto"),
    ]).returning();
    const executionState = {
      status: "pending",
      currentStageId: randomUUID(),
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewer!.id, userId: null },
      returnAssignee: { type: "agent", agentId: assignee!.id, userId: null },
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    };
    const [issue] = await db.insert(issues).values({
      companyId,
      title: "Question for another agent during review",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: assignee!.id,
      executionState,
    }).returning();
    const board = {
      type: "board",
      source: "session",
      userId,
      companyIds: [companyId],
      memberships: [{ companyId, status: "active", membershipRole: "operator" }],
      isInstanceAdmin: false,
    };
    return { companyId, issue: issue!, assignee: assignee!, reviewer: reviewer!, addressee: addressee!, board, executionState };
  }

  it("runs the addressee of a question card created over HTTP while another agent reviews the task", async () => {
    const f = await seedReviewFixture();

    const res = await request(app(f.board))
      .post(`/api/issues/${f.issue.id}/interactions`)
      .send({
        kind: "ask_user_questions",
        addresseeAgentId: f.addressee.id,
        payload: {
          version: 1,
          questions: [{ id: "scope", prompt: "Which scope?", selectionMode: "single", required: true, options: [{ id: "a", label: "A" }] }],
        },
      });
    expect(res.status).toBe(201);
    const interactionId = res.body.id as string;
    expect(res.body).toMatchObject({ status: "pending", addresseeAgentId: f.addressee.id });

    expect(await waitForCondition(async () => {
      const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.addressee.id));
      return runs.length > 0;
    })).toBe(true);
    await heartbeat.resumeQueuedRuns();
    expect(await waitForCondition(async () => executeCallsForAgent(f.addressee.id).length === 1)).toBe(true);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);

    const runs = await db.select({
      agentId: heartbeatRuns.agentId,
      status: heartbeatRuns.status,
      errorCode: heartbeatRuns.errorCode,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId));
    expect(runs).toEqual([
      expect.objectContaining({
        agentId: f.addressee.id,
        status: "succeeded",
        errorCode: null,
        contextSnapshot: expect.objectContaining({ wakeReason: "interaction_pending", interactionId }),
      }),
    ]);
    expect(executeCallsForAgent(f.addressee.id)).toHaveLength(1);
    expect(executeCallsForAgent(f.reviewer.id)).toHaveLength(0);
    expect(executeCallsForAgent(f.assignee.id)).toHaveLength(0);

    const [issue] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    expect(issue).toMatchObject({
      status: "in_review",
      assigneeAgentId: f.assignee.id,
      executionState: { currentParticipant: { agentId: f.reviewer.id } },
    });
    const [interaction] = await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, interactionId));
    expect(interaction).toMatchObject({ status: "pending", addresseeAgentId: f.addressee.id });
  });
});
