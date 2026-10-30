import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agentWakeupRequests, agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { selectDeferredOwnerWake } from "../services/heartbeat/deferred-owner-wake.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("owner wake deferred behind a reassigned run", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("deferred-owner-wake-");
    db = createDb(fixture.connectionString);
    await db.insert(authUsers).values({ id: "board", name: "Sponsor", email: "deferred@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterAll(async () => { await db?.$client.end(); await fixture?.cleanup(); });

  // The board reassigns the task. The new owner's wake waits behind the previous
  // owner's queued run, and then that run is stopped.
  async function seed() {
    const companyId = randomUUID(), previousId = randomUUID(), ownerId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Deferred fixture", issuePrefix: "D" + companyId.slice(0, 7), defaultResponsibleUserId: "board" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board", membershipRole: "operator", status: "active" });
    await db.insert(agents).values([
      { id: previousId, companyId, name: "Previous", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
      { id: ownerId, companyId, name: "Owner", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
    ]);
    const [previousRun] = await db.insert(heartbeatRuns).values({ companyId, agentId: previousId, status: "queued", runtimeMode: "legacy",
      responsibleUserId: "board", contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_reopened_via_comment" } }).returning();
    await db.insert(issues).values({ id: issueId, companyId, title: "Reassigned task", status: "todo", responsibleUserId: "board",
      assigneeAgentId: ownerId, executionRunId: previousRun.id, executionLockedAt: new Date() });
    // Keep the owner busy so admission queues its run instead of launching a provider.
    await db.insert(heartbeatRuns).values({ companyId, agentId: ownerId, status: "running" });
    const [deferred] = await db.insert(agentWakeupRequests).values({ companyId, agentId: ownerId, source: "assignment", triggerDetail: "system",
      reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedByActorType: "user", requestedByActorId: "board",
      payload: { issueId, mutation: "update", _paperclipWakeContext: { wakeReason: "issue_assigned", issueId, taskId: issueId } } }).returning();
    return { companyId, previousId, ownerId, issueId, previousRun, deferred };
  }
  type Fixture = Awaited<ReturnType<typeof seed>>;
  const ownerRuns = (f: Fixture) => db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, f.ownerId),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`));
  const deferredRow = async (f: Fixture) =>
    (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.deferred.id)))[0];
  const select = (f: Fixture, endedRunId = f.previousRun.id) =>
    selectDeferredOwnerWake(db, { companyId: f.companyId, issueId: f.issueId, endedRunId });

  it("admits the new owner's deferred wake once when the previous owner's run is stopped", async () => {
    const f = await seed();
    const service = heartbeatService(db);

    // The board Stop route's options: an operator stop never promotes queued work by itself.
    await service.cancelRun(f.previousRun.id, "Cancelled by a board operator", {
      reviewerIntentDisposition: "retire",
      resultJson: { cancelledByActorType: "user", cancelledByUserId: "board" },
    });

    expect(await ownerRuns(f)).toMatchObject([{ status: "queued", contextSnapshot: { wakeReason: "issue_assigned" } }]);
    expect(await deferredRow(f)).toMatchObject({ status: "cancelled", error: "Admitted again after the run that held the task ended" });
    // The same end recorded again does not admit a second wake.
    expect(await select(f)).toBeNull();
  }, 60_000);

  it("keeps a deferred wake that the task no longer needs", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.previousRun.id));

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
    expect(await select(f)).toBeNull();

    await db.update(issues).set({ status: "todo", assigneeAgentId: f.previousId }).where(eq(issues.id, f.issueId));
    expect(await select(f)).toBeNull();

    await db.update(issues).set({ assigneeAgentId: f.ownerId }).where(eq(issues.id, f.issueId));
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.ownerId, status: "succeeded",
      contextSnapshot: { issueId: f.issueId }, createdAt: new Date(Date.now() + 1000) });
    expect(await select(f)).toBeNull();

    expect(await deferredRow(f)).toMatchObject({ status: "deferred_issue_execution" });
  }, 60_000);

  it("leaves the stopped agent's own deferred input and a paused owner's wake deferred", async () => {
    const f = await seed();
    // The previous owner's own queued input waits for its next explicit wake after a Stop.
    await db.update(issues).set({ assigneeAgentId: f.previousId }).where(eq(issues.id, f.issueId));
    await db.update(agentWakeupRequests).set({ agentId: f.previousId }).where(eq(agentWakeupRequests.id, f.deferred.id));
    expect(await select(f)).toBeNull();

    await db.update(issues).set({ assigneeAgentId: f.ownerId }).where(eq(issues.id, f.issueId));
    await db.update(agentWakeupRequests).set({ agentId: f.ownerId }).where(eq(agentWakeupRequests.id, f.deferred.id));
    await db.update(agents).set({ status: "paused" }).where(eq(agents.id, f.ownerId));
    expect(await select(f)).toBeNull();
    expect(await deferredRow(f)).toMatchObject({ status: "deferred_issue_execution" });
  }, 60_000);

  it("waits while another live run still holds the task", async () => {
    const f = await seed();
    const [other] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.previousId, status: "running",
      contextSnapshot: { issueId: f.issueId } }).returning();
    await db.update(issues).set({ executionRunId: other.id }).where(eq(issues.id, f.issueId));

    expect(await select(f)).toBeNull();

    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, other.id));
    expect(await select(f, other.id)).toMatchObject({ agentId: f.ownerId, deferredWakeId: f.deferred.id,
      opts: { source: "assignment", reason: "issue_assigned", payload: { issueId: f.issueId } } });
  }, 60_000);
});
