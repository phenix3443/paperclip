import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { agents, authUsers, agentWakeupRequests, companies, companyMemberships, costEvents, createDb, databaseWorkPending, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedReviewerIntent } from "./helpers/reviewer-intent.js";
import { createReviewerAssignmentIntent } from "../services/heartbeat/reviewer-assignment-continuation.js";
import { heartbeatService } from "../services/heartbeat.js";
import { companyService } from "../services/companies.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";
import { issueService } from "../services/issues.js";
import { accessService } from "../services/access.js";
import { projectService, ensureProjectAccessMember } from "../services/projects.js";
import { environmentService } from "../services/environments.js";
import { budgetService } from "../services/budgets.js";
import { issueThreadInteractionService } from "../services/issue-thread-interactions.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerExecutionControlWork, executionControlSchedule } from "../services/execution-control-work.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("reviewer intent gate mutations before receipt commit", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("reviewer-transactions-");
    db = createDb(fixture.connectionString);
    await db.insert(authUsers).values({ id: "board", name: "Sponsor", email: "sponsor@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
  afterAll(async () => { await db?.$client.end(); await fixture?.cleanup(); });

  it.each(["company", "tree", "dependency", "interaction", "membership", "project", "workspace", "budget"] as const)(
    "retains the registered duty when %s clears inside the uncommitted receipt transaction", async kind => {
    const f = await seedReviewerIntent(db, false);
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running" });
    let clear: (owner: Db) => Promise<unknown>;
    const actor = { actorType: "system" as const, actorId: "fixture" };
    if (kind === "company") {
      await companyService(db).update(f.companyId, { status: "paused" });
      clear = owner => companyService(owner).update(f.companyId, { status: "active" });
    } else if (kind === "tree") {
      const { hold } = await issueTreeControlService(db).createHold(f.companyId, f.issueId, { mode: "pause", actor });
      clear = owner => issueTreeControlService(owner).releaseHold(f.companyId, f.issueId, hold.id, { actor });
    } else if (kind === "dependency") {
      const [blocker] = await db.insert(issues).values({ companyId: f.companyId, title: "Prerequisite", status: "todo" }).returning();
      await issueService(db).update(f.issueId, { blockedByIssueIds: [blocker.id] });
      clear = owner => issueService(owner).update(blocker.id, { status: "done" });
    } else if (kind === "interaction") {
      const task = { id: f.issueId, companyId: f.companyId };
      const card = await issueThreadInteractionService(db).create(task, { kind: "ask_user_questions", addresseeUserId: "board",
        sourceRunId: f.source.id, continuationPolicy: "wake_assignee", payload: { version: 1, questions: [{ id: "permission",
          prompt: "Continue?", selectionMode: "single", required: true, options: [{ id: "yes", label: "Continue" }] }] } }, { userId: "board" });
      clear = owner => issueThreadInteractionService(owner).withdrawInteraction(task, card.id, { reason: "No longer required" }, { userId: "board" });
    } else if (kind === "membership") {
      const [member] = await db.select().from(companyMemberships).where(eq(companyMemberships.companyId, f.companyId));
      await accessService(db).updateMember(f.companyId, member.id, { status: "suspended" });
      clear = owner => accessService(owner).updateMember(f.companyId, member.id, { status: "active" });
    } else if (kind === "project") {
      vi.stubEnv("PAPERCLIP_ISSUE_PRIVACY_MODE", "enforce");
      const project = await projectService(db).create(f.companyId, { name: "Restricted", visibility: "private" });
      await issueService(db).update(f.issueId, { projectId: project.id });
      clear = async owner => {
        for (const principal of [{ subjectType: "user" as const, subjectId: "board" },
          { subjectType: "agent" as const, subjectId: f.agentId }, { subjectType: "agent" as const, subjectId: f.source.agentId }])
          await ensureProjectAccessMember(owner, { companyId: f.companyId, projectId: project.id, ...principal });
      };
    } else if (kind === "workspace") {
      const lease = await environmentService(db).insertPendingCleanupLease({ companyId: f.companyId, environmentId: randomUUID(),
        issueId: f.issueId, heartbeatRunId: f.source.id, provider: "local", failureReason: "Pending fixture cleanup" });
      clear = owner => environmentService(owner).releaseLease(lease.id, "released", { cleanupStatus: "success" });
    } else {
      const policy = { scopeType: "company" as const, scopeId: f.companyId, windowKind: "calendar_month_utc" as const };
      await budgetService(db).upsertPolicy(f.companyId, { ...policy, amount: 100 }, null);
      await db.insert(costEvents).values({ companyId: f.companyId, agentId: f.agentId, provider: "fixture", model: "fixture",
        inputTokens: 0, outputTokens: 0, costCents: 125, occurredAt: new Date() });
      clear = owner => budgetService(owner).upsertPolicy(f.companyId, { ...policy, amount: 200 }, null);
    }
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    const errors: unknown[] = [];
    const c = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: error => errors.push(error) });
    const service = heartbeatService(db);
    let release!: () => void, written!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const inserted = new Promise<void>(resolve => { written = resolve; });
    let transaction: Promise<unknown> | undefined;
    try {
      await registerExecutionControlWork(c, [{ queue: DELIVERY_QUEUES.executionContinuation,
        run: service.reconcileReviewerAssignments, next: executionControlSchedule(db).continuation }]).ready;
      transaction = db.transaction(async outer => {
        if (kind === "company") await clear(db);
        const receipt = await createReviewerAssignmentIntent(outer, { companyId: f.companyId, issueId: f.issueId,
          sourceRunId: f.source.id, requestedByActorType: "agent", requestedByActorId: f.source.agentId });
        expect(receipt).not.toBeNull();
        if (kind !== "company") await clear(outer as unknown as Db);
        written(); await gate;
      });
      await Promise.race([inserted, transaction.then(() => { throw new Error("Receipt transaction finished before the commit barrier"); })]);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId))).toHaveLength(0);
      expect(databaseWorkPending(db, DELIVERY_QUEUES.executionContinuation)).toBe(true);
      release(); await transaction;
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(async () => {
        const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
        expect(receipts.filter(row => row.payload?._paperclipReviewerAssignmentContinuation)).toMatchObject([{ status: "coalesced" }]);
        expect(c.nextWakeAt()).toBeNull();
      }, { timeout: 5000 });
      expect(errors).toEqual([]);
      expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.agentId))).toHaveLength(2);
    } finally {
      release?.();
      try { await transaction; } finally { await c.stop(); await service.drainActiveRunExecutions(); }
    }
  });
});
