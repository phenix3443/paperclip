# Isolated reviewer lease diagnostic

Diagnostic base: `99481ae2e0f5869d85c95a8cb3961930dc23b489`.
Fixture prior art: upstream PR #16966 at `3803bcb898e1ea73f0a2358f92a1dc1cd6011dae`; adapted to existing public service methods and the exact lost-successor assertion.
No production code change. Extract the TypeScript block to
`server/src/__tests__/reviewer-lease-diagnostic.test.ts`, then run the bounded
command in the companion plan. Expect one failure and one positive control pass
on the pinned base. Delete the extracted file afterward.

```ts
import { randomUUID } from "node:crypto";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, environmentLeases, heartbeatRuns, issueComments, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { getExecutionBlocker } from "../services/execution-blocker.js";
import { heartbeatService } from "../services/heartbeat.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("wakes parked behind an execution ownership hold", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("execution-ownership-wait-");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  type Fixture = Awaited<ReturnType<typeof seed>>;

  /**
   * The production shape of a stage handoff: the outgoing run was cancelled
   * for the reassignment, its provider stop was acknowledged, and its
   * environment lease is still held while executor cleanup runs.
   */
  async function seed(input: { stage?: boolean } = {}) {
    const stage = input.stage ?? true;
    const companyId = randomUUID(), previousAgentId = randomUUID(), nextAgentId = randomUUID();
    const issueId = randomUUID(), runId = randomUUID(), stageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Handoff", defaultResponsibleUserId: "board", issuePrefix: "H" + companyId.replaceAll("-", "") });
    await db.insert(agents).values([
      { id: previousAgentId, companyId, name: "Author", role: "engineer", adapterType: "opencode_local", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
      { id: nextAgentId, companyId, name: "Reviewer", role: "engineer", adapterType: "opencode_local", status: "idle", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
    ]);
    const participant = { type: "agent", agentId: nextAgentId, userId: null };
    const returnAssignee = { type: "agent", agentId: previousAgentId, userId: null };
    const reviewRequest = { instructions: "Review the change; do not implement it. Report a verdict." };
    const executionState = {
      status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
      currentParticipant: participant, returnAssignee, reviewRequest, completedStageIds: [],
      lastDecisionId: null, lastDecisionOutcome: null, changesRequestedCount: 2,
    };
    await db.insert(issues).values({
      id: issueId, companyId, title: "Review the change", assigneeAgentId: nextAgentId, responsibleUserId: "board",
      executionPolicy: {mode:"normal", stages:[{id:stageId,type:"review",participants:[{id:randomUUID(),...participant}],approvalsNeeded:1}],commentRequired:true},
      ...(stage ? { status: "in_review", executionState } : { status: "in_progress" }),
    });
    const finishedAt = new Date(Date.now() - 500);
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId: previousAgentId, runtimeMode: "legacy", status: "cancelled",
      errorCode: "issue_reassigned", error: "Cancelled before issue reassignment",
      createdAt: new Date(Date.now() - 60_000), startedAt: new Date(Date.now() - 59_000), finishedAt,
      contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" },
      resultJson: {
        conversationContinuation: "continue_conversation_v1", reassignmentStopConfirmed: true,
        executionCancellation: { state: "acknowledged", acknowledgedAt: finishedAt.toISOString() },
        cancellation: { reason: "Cancelled before issue reassignment", source: "control_plane", expected: true },
      },
    });
    const [lease] = await db.insert(environmentLeases).values({
      companyId, issueId, heartbeatRunId: runId, status: "active", provider: "local",
    }).returning();
    // Occupy the next agent so admission queues its run without launching a provider.
    const [busy] = await db.insert(heartbeatRuns).values({ companyId, agentId: nextAgentId, status: "running" }).returning();
    const executionStage = {
      stageId, wakeRole: "reviewer", stageType: "review", reviewRequest,
      allowedActions: ["approve", "request_changes"], returnAssignee, currentParticipant: participant, lastDecisionOutcome: null,
    };
    const wake = stage
      ? {
          source: "assignment" as const, triggerDetail: "system" as const, reason: "execution_review_requested",
          payload: { issueId, mutation: "update", executionStage, interruptedRunId: runId },
          requestedByActorType: "agent" as const, requestedByActorId: previousAgentId,
          contextSnapshot: { issueId, taskId: issueId, wakeReason: "execution_review_requested", source: "issue.execution_stage", executionStage, interruptedRunId: runId },
        }
      : {
          source: "assignment" as const, triggerDetail: "system" as const, reason: "issue_assigned",
          payload: { issueId, mutation: "update", interruptedRunId: runId },
          requestedByActorType: "user" as const, requestedByActorId: "board",
          contextSnapshot: { issueId, source: "issue.update", interruptedRunId: runId },
        };
    return { companyId, previousAgentId, nextAgentId, issueId, runId, stageId, lease: lease!, busy: busy!, wake };
  }

  const nextAgentWakes = (f: Fixture) => db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, f.companyId), eq(agentWakeupRequests.agentId, f.nextAgentId),
  )).orderBy(asc(agentWakeupRequests.requestedAt));
  const nextAgentIssueRuns = (f: Fixture) => db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, f.companyId), eq(heartbeatRuns.agentId, f.nextAgentId), ne(heartbeatRuns.id, f.busy.id),
  )).orderBy(asc(heartbeatRuns.createdAt));
  const releaseLease = (f: Fixture) => db.update(environmentLeases)
    .set({ status: "expired", releasedAt: new Date() }).where(eq(environmentLeases.id, f.lease.id));


  it("retains the original reviewer assignment after cleanup", async () => {
    const f = await seed();
    const before = (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0];
    const heartbeat = heartbeatService(db);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toMatchObject({cause: "execution_owner_active", runId: f.runId});
    expect(await heartbeat.wakeup(f.nextAgentId, f.wake)).toBeNull();
    const [receipt] = await nextAgentWakes(f);
    console.log("DIAG admission", JSON.stringify({status: receipt.status, reason: receipt.reason, runId:receipt.runId}));
    await releaseLease(f);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    await Promise.all([heartbeatService(db).resumeQueuedRuns(), heartbeatService(db).resumeQueuedRuns()]);
    const runs = await nextAgentIssueRuns(f);
    const after = (await db.select().from(issues).where(eq(issues.id, f.issueId)))[0];
    expect(after.executionState).toEqual(before.executionState);
    expect(after.executionPolicy).toEqual(before.executionPolicy);
    expect(after.responsibleUserId).toEqual(before.responsibleUserId);
    console.log("DIAG after cleanup", JSON.stringify({successors:runs.length, stateUnchanged: true}));
    expect(runs).toHaveLength(1);
  });
  it("admits the same synthetic assignment when the lease is already released", async () => {
    const f = await seed();
    await releaseLease(f);
    expect(await getExecutionBlocker(db, f.companyId, f.issueId)).toBeNull();
    await heartbeatService(db).wakeup(f.nextAgentId, f.wake);
    const runs = await nextAgentIssueRuns(f);
    console.log("DIAG positive control", JSON.stringify({successors:runs.length,status:runs[0]?.status}));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("queued");
  });

});
```
