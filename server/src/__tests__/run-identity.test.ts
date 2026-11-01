import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, agentWakeupRequests, agents, companies, createDb, heartbeatRuns, heartbeatRunEvents, issueComments, issueThreadInteractions, issues, runIdentityContexts, secretAccessEvents } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { acceptSteeredIdentity, captureRunIdentity, initializeRunIdentity, listRunIdentityContexts, rejectSteeredIdentity, reserveSteeredIdentity, settleNewReviewRunIdentity, settleReviewRunClaimIdentity, runIdentityInitializationInput } from "../services/run-identity.js";

import { issueExecutionGeneration } from "../services/issue-execution-policy.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("durable execution identity", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-run-identity-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Identity tests", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Shared agent", role: "engineer", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Shared task", responsibleUserId: "owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
    const messageIds: string[] = [];
    for (const author of ["A", "B", "A"]) {
      const id = randomUUID();
      await db.insert(issueComments).values({ id, companyId, issueId, authorUserId: author, body: "Instruction" });
      messageIds.push(id);
    }
    return { companyId, agentId, issueId, runId, messageIds };
  }
  it("retains mixed-author delivery order without rewriting task ownership", async () => {
    const input = await seed();
    await initializeRunIdentity(db, { ...input, responsibleUserId: "owner", cause: "queued" });
    const history = await listRunIdentityContexts(db, input.companyId, input.runId);
    expect(history.map((row) => row.responsibleUserId)).toEqual(["owner", "A", "B", "A"]);
    expect(history.map((row) => row.revision)).toEqual([1, 2, 3, 4]);
    expect((await captureRunIdentity(db, input)).context?.responsibleUserId).toBe("A");
    const [issue] = await db.select().from(issues).where(eq(issues.id, input.issueId));
    expect(issue.responsibleUserId).toBe("owner");
    await initializeRunIdentity(db, { ...input, responsibleUserId: "B", cause: "restart" });
    expect(await listRunIdentityContexts(db, input.companyId, input.runId)).toHaveLength(4);
  });
  it("settles absent task responsibility before stamping and returns the claimed identity", async () => {
    const input = await seed();
    await db.update(issues).set({ responsibleUserId: null }).where(eq(issues.id, input.issueId));
    const [queued] = await db.update(heartbeatRuns).set({ status: "queued", responsibleUserId: "owner",
      contextSnapshot: { issueId: input.issueId, wakeCommentIds: input.messageIds } }).where(eq(heartbeatRuns.id, input.runId)).returning();
    const task = await db.transaction(tx => settleNewReviewRunIdentity(tx as unknown as Db, queued));
    expect(task.responsibleUserId).toBe("A");
    const [stamped] = await db.update(heartbeatRuns).set({ status: "running",
      contextSnapshot: { ...queued.contextSnapshot, reviewerAssignmentGeneration: issueExecutionGeneration(task) } })
      .where(eq(heartbeatRuns.id, input.runId)).returning();
    const claimed = await db.transaction(tx => settleReviewRunClaimIdentity(tx as unknown as Db, stamped, null));
    expect(claimed.responsibleUserId).toBe("A");
    expect(claimed.activeIdentityContextId).toBeTruthy();
    const history = await listRunIdentityContexts(db, input.companyId, input.runId);
    expect(history.map(row => row.responsibleUserId)).toEqual(["owner", "A", "B", "A"]);
    expect(await db.transaction(tx => settleReviewRunClaimIdentity(tx as unknown as Db, claimed, new Date()))).toEqual(claimed);
    expect(await listRunIdentityContexts(db, input.companyId, input.runId)).toHaveLength(4);
    await db.update(issues).set({ responsibleUserId: "B" }).where(eq(issues.id, input.issueId));
    await expect(db.transaction(tx => settleReviewRunClaimIdentity(tx as unknown as Db, claimed, null))).rejects.toThrow("submission changed");
  });

  it.each(["origin", "active-run", "active-status"])("refuses a claimed review with invalid %s identity evidence", async fault => {
    const input = await seed();
    await db.update(issues).set({ responsibleUserId: null }).where(eq(issues.id, input.issueId));
    const [queued] = await db.update(heartbeatRuns).set({ status: "queued", responsibleUserId: "owner" })
      .where(eq(heartbeatRuns.id, input.runId)).returning();
    const task = await db.transaction(tx => settleNewReviewRunIdentity(tx as unknown as Db, queued));
    const [stamped] = await db.update(heartbeatRuns).set({ status: "running",
      contextSnapshot: { ...queued.contextSnapshot, reviewerAssignmentGeneration: issueExecutionGeneration(task) } })
      .where(eq(heartbeatRuns.id, input.runId)).returning();
    if (fault === "origin") await db.update(runIdentityContexts).set({ correlationId: "not-dispatch" }).where(eq(runIdentityContexts.id, stamped.activeIdentityContextId!));
    if (fault === "active-status") await db.update(runIdentityContexts).set({ status: "pending" }).where(eq(runIdentityContexts.id, stamped.activeIdentityContextId!));
    if (fault === "active-run") {
      const other = await seed();
      const identity = await initializeRunIdentity(db, { ...other, responsibleUserId: "owner", cause: "dispatch" });
      stamped.activeIdentityContextId = identity.id;
    }
    await expect(db.transaction(tx => settleReviewRunClaimIdentity(tx as unknown as Db, stamped, null)))
      .rejects.toThrow(fault === "origin" ? "origin identity is unavailable" : "review identity is unavailable");
  });

  it("uses validated failed-chat retry facts to retain messages only on that retry", async () => {
    const input = await seed();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
    const retry = { ...run, retryOfRunId: randomUUID() };
    const context = { issueId: input.issueId, wakeCommentIds: input.messageIds };
    expect(runIdentityInitializationInput(retry, context, null, "owner").messageIds).toEqual([]);
    expect(runIdentityInitializationInput(retry, context, null, "owner", true).messageIds).toEqual(input.messageIds);
  });

  async function seedInterrupt() {
    const input = await seed();
    const queueId = randomUUID(), wakeupRequestId = randomUUID();
    const contextSnapshot = { issueId: input.issueId, wakeCommentIds: input.messageIds };
    await db.insert(agentWakeupRequests).values([
      { id: queueId, companyId: input.companyId, agentId: input.agentId, source: "automation",
        status: "coalesced", runId: input.runId, requestedByActorType: "system",
        payload: { issueId: input.issueId, _paperclipWakeContext: { wakeCommentIds: input.messageIds },
          queuedCommentInterrupt: { actorId: "operator", requestedAt: new Date().toISOString() } } },
      { id: wakeupRequestId, companyId: input.companyId, agentId: input.agentId, source: "on_demand",
        status: "queued", runId: input.runId, requestedByActorType: "user", requestedByActorId: "operator",
        idempotencyKey: `queued-comment-interrupt:${queueId}` },
    ]);
    await db.update(heartbeatRuns).set({ wakeupRequestId, contextSnapshot }).where(eq(heartbeatRuns.id, input.runId));
    return { ...input, queueId, wakeupRequestId, contextSnapshot };
  }

  it("uses the clicking operator through startup and restart without changing message authors", async () => {
    const input = await seedInterrupt();
    // A stale originating context cannot replace the explicit click's identity.
    const identity = await initializeRunIdentity(db, {
      ...input, responsibleUserId: "A", parentContextId: randomUUID(), cause: "dispatch",
    });
    expect(identity).toMatchObject({ responsibleUserId: "operator", cause: "queued_comment_interrupt" });
    const history = await listRunIdentityContexts(db, input.companyId, input.runId);
    expect(history.map(row => row.responsibleUserId)).toEqual(["operator", "operator", "operator", "operator"]);
    expect(await initializeRunIdentity(db, { ...input, responsibleUserId: "B", cause: "restart" })).toEqual(identity);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, input.issueId));
    expect(input.messageIds.map(id => comments.find(c => c.id === id)?.authorUserId)).toEqual(["A", "B", "A"]);
    expect((await captureRunIdentity(db, input)).context?.responsibleUserId).toBe("operator");
    const retryRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: retryRunId, companyId: input.companyId,
      agentId: input.agentId, contextSnapshot: input.contextSnapshot, status: "queued", retryOfRunId: input.runId });
    const retried = await initializeRunIdentity(db, { companyId: input.companyId, runId: retryRunId,
      issueId: input.issueId, parentRunId: input.runId, responsibleUserId: "A", cause: "retry" });
    expect(retried.responsibleUserId).toBe("operator");
  });

  it.each(["malformed", "missing", "unconsumed", "other-run", "other-task", "other-agent", "other-actor", "other-message"])(
    "rejects %s interrupt authority before creating any execution identity", async (fault) => {
      const input = await seedInterrupt();
      if (fault === "malformed" || fault === "missing") {
        await db.update(agentWakeupRequests).set({
          idempotencyKey: `queued-comment-interrupt:${fault === "malformed" ? "not-an-id" : randomUUID()}`,
        }).where(eq(agentWakeupRequests.id, input.wakeupRequestId));
      } else if (fault === "other-actor") {
        await db.update(agentWakeupRequests).set({ requestedByActorId: "someone-else" }).where(eq(agentWakeupRequests.id, input.wakeupRequestId));
      } else {
        const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, input.queueId));
        if (fault === "other-agent") {
          const agentId = randomUUID();
          await db.insert(agents).values({ id: agentId, companyId: input.companyId, name: "Other", role: "engineer" });
          await db.update(agentWakeupRequests).set({ agentId }).where(eq(agentWakeupRequests.id, input.queueId));
        } else await db.update(agentWakeupRequests).set(
          fault === "unconsumed" ? { status: "deferred_issue_execution" } :
          fault === "other-run" ? { runId: null } :
          { payload: { ...receipt.payload, ...(fault === "other-task" ? { issueId: randomUUID() } :
            { _paperclipWakeContext: { wakeCommentIds: [randomUUID()] } }) } },
        ).where(eq(agentWakeupRequests.id, input.queueId));
      }
      await expect(initializeRunIdentity(db, { ...input, responsibleUserId: "A", cause: "dispatch" })).rejects.toThrow("interrupt authority");
      expect(await listRunIdentityContexts(db, input.companyId, input.runId)).toHaveLength(0);
    },
  );

  it("holds acquisition during uncertain steering, preserves snapshots, and never rewinds on replay", async () => {
    const input = await seed();
    await initializeRunIdentity(db, { ...input, messageIds: [input.messageIds[0]], responsibleUserId: "A", cause: "instruction" });
    const startedUnderA = await captureRunIdentity(db, input);
    const b = await reserveSteeredIdentity(db, { ...input, messageId: input.messageIds[1] });
    expect(b).not.toBeNull();
    await expect(captureRunIdentity(db, input)).rejects.toThrow(/reconciled/);
    await expect(reserveSteeredIdentity(db, { ...input, messageId: input.messageIds[2] })).rejects.toThrow(/reconciled/);
    await db.transaction(async tx => {
      await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId)).for("update");
      await acceptSteeredIdentity(tx, b!);
    });
    expect((await captureRunIdentity(db, input)).context?.responsibleUserId).toBe("B");
    expect(startedUnderA.context?.responsibleUserId).toBe("A");
    const a = await reserveSteeredIdentity(db, { ...input, messageId: input.messageIds[2] });
    await acceptSteeredIdentity(db, a!);
    await acceptSteeredIdentity(db, b!);
    expect((await captureRunIdentity(db, input)).context?.responsibleUserId).toBe("A");
  });
  it("keeps rejected steering unchanged and preserves the originating identity on retry", async () => {
    const input = await seed();
    await initializeRunIdentity(db, { ...input, messageIds: [], responsibleUserId: "A", cause: "instruction" });
    const b = await reserveSteeredIdentity(db, { ...input, messageId: input.messageIds[1] });
    await rejectSteeredIdentity(db, b!);
    expect((await captureRunIdentity(db, input)).context?.responsibleUserId).toBe("A");
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: input.companyId, agentId: input.agentId, status: "running" });
    const retry = await initializeRunIdentity(db, { companyId: input.companyId, runId, parentRunId: input.runId, responsibleUserId: "B", cause: "retry" });
    expect(retry.responsibleUserId).toBe("A");
    expect(retry.parentContextId).toBe((await captureRunIdentity(db, input)).context?.id);
    await expect(captureRunIdentity(db, { ...input, companyId: randomUUID() })).rejects.toThrow();
    await expect(captureRunIdentity(db, { ...input, agentId: randomUUID() })).rejects.toThrow();
  });
  it("preserves an explicitly absent identity through a continuation initiated by another person", async () => {
    const input = await seed();
    const origin = await initializeRunIdentity(db, {
      ...input, messageIds: [], responsibleUserId: null, cause: "routine",
    });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId, companyId: input.companyId, agentId: input.agentId,
      status: "running", responsibleUserId: "B",
    });
    const continued = await initializeRunIdentity(db, {
      companyId: input.companyId, runId, parentContextId: origin.id,
      responsibleUserId: "B", cause: "retry",
    });
    expect(continued.responsibleUserId).toBeNull();
    const captured = await captureRunIdentity(db, { ...input, runId });
    expect(captured.run.responsibleUserId).toBeNull();
    expect(captured.context?.parentContextId).toBe(origin.id);
  });
  it("recovers an uncertain acknowledgement from the authenticated native event journal", async () => {
    const input = await seed();
    await initializeRunIdentity(db, { ...input, messageIds: [], responsibleUserId: "A", cause: "instruction" });
    const pending = await reserveSteeredIdentity(db, { ...input, messageId: input.messageIds[1] });
    await expect(captureRunIdentity(db, input)).rejects.toThrow(/reconciled/);
    await db.insert(heartbeatRunEvents).values({ companyId: input.companyId, runId: input.runId,
      agentId: input.agentId, seq: 1, eventType: "item.completed", sourceEventId: randomUUID(),
      payload: { prpEvent: { turnId: "turn-1", itemId: `turn-1:steer:${pending!.messageId}`, payload: {kind: "steering_acknowledgement"} } },
    });
    expect((await captureRunIdentity(db, input)).context?.responsibleUserId).toBe("B");
    await db.update(heartbeatRuns).set({status: "succeeded"}).where(eq(heartbeatRuns.id, input.runId));
    expect((await reserveSteeredIdentity(db, { ...input, messageId: input.messageIds[1] }))?.status).toBe("accepted");
  });
  it("preserves an operation's origin through approval and delegation after another person steers", async () => {
    const input = await seed();
    const origin = await initializeRunIdentity(db, { ...input, messageIds: [], responsibleUserId: "A", cause: "instruction" });
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId: input.companyId,
      issueId: input.issueId, kind: "request_confirmation", sourceRunId: input.runId,
      sourceIdentityContextId: origin.id, payload: { prompt: "Continue?" } as never,
    });
    const b = await reserveSteeredIdentity(db, { ...input, messageId: input.messageIds[1] });
    await acceptSteeredIdentity(db, b!);
    for (const approval of [true, false]) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId: input.companyId, agentId: input.agentId, status: "running" });
      const continued = await initializeRunIdentity(db, { companyId: input.companyId, runId, issueId: input.issueId,
        ...(approval ? { interactionId } : { parentContextId: origin.id }),
        responsibleUserId: "B", cause: approval ? "approval" : "delegation",
      });
      expect(continued.responsibleUserId).toBe("A");
      expect(continued.parentContextId).toBe(origin.id);
    }
  });
  it("retains continuation and approval attribution after deleting the originating agent and runs", async () => {
    const input = await seed();
    const origin = await initializeRunIdentity(db, { ...input, messageIds: [], responsibleUserId: "A", cause: "instruction" });
    const interactionId = randomUUID();
    await db.insert(issueThreadInteractions).values({ id: interactionId, companyId: input.companyId,
      issueId: input.issueId, kind: "request_confirmation", sourceRunId: input.runId,
      sourceIdentityContextId: origin.id, payload: { prompt: "Continue?" } as never,
    });
    await db.update(issues).set({ originIdentityContextId: origin.id }).where(eq(issues.id, input.issueId));
    await db.delete(heartbeatRuns).where(eq(heartbeatRuns.agentId, input.agentId));
    await db.delete(agents).where(eq(agents.id, input.agentId));
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId: input.companyId, name: "Replacement", role: "engineer", adapterType: "codex_local" });
    const [task] = await db.select().from(issues).where(eq(issues.id, input.issueId));
    expect(task.continuationIdentityContextId).toBe(origin.id);
    for (const source of [{ parentContextId: task.originIdentityContextId }, { parentContextId: task.continuationIdentityContextId }, { interactionId }]) {
      const runId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: runId, companyId: input.companyId, agentId, status: "running" });
      const continued = await initializeRunIdentity(db, { companyId: input.companyId, runId,
        issueId: input.issueId, ...source, responsibleUserId: "B", cause: "continuation" });
      expect(continued.responsibleUserId).toBe("A");
      expect(continued.parentContextId).toBe(origin.id);
    }
  });

  it.each(["update", "no key update"] as const)("serializes identity initialization behind a task's %s lock", async (lockMode) => {
    const input = await seed();
    let initialization!: ReturnType<typeof initializeRunIdentity>;
    await db.transaction(async (tx) => {
      await tx.select().from(issues).where(eq(issues.id, input.issueId)).for(lockMode);
      const [backend] = await tx.execute(sql`select pg_backend_pid() as pid`) as unknown as Array<{ pid: number }>;
      initialization = initializeRunIdentity(db, { ...input, messageIds: [], responsibleUserId: "A", cause: "instruction" });
      // Wait until initialization is blocked by this task mutation, rather than
      // relying on timing to decide whether it has acquired its first lock.
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const [state] = await db.execute(sql`select exists (
          select 1 from pg_stat_activity where ${backend.pid} = any(pg_blocking_pids(pid))
        ) as waiting`) as unknown as Array<{ waiting: boolean }>;
        if (state.waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await tx.execute(sql`set local lock_timeout = '1s'`);
      await tx.update(heartbeatRuns).set({ updatedAt: new Date() }).where(eq(heartbeatRuns.id, input.runId));
    });
    await expect(initialization).resolves.toMatchObject({ responsibleUserId: "A" });
  });

  it.each(["initialize", "capture"] as const)(
    "can %s identity while an audit append holds foreign-key locks",
    async (operation) => {
      const input = await seed();
      if (operation === "capture") {
        await initializeRunIdentity(db, { ...input, messageIds: [], responsibleUserId: "A", cause: "instruction" });
      }
      // A real append holds KEY SHARE on both parent rows until it commits.
      // Bound the other connection's wait so a conflicting lock fails this
      // regression instead of leaving both transactions waiting for each other.
      const identityDb = createDb(`${database.connectionString}?options=-c%20lock_timeout%3D1000`, {
        maxConnections: 1,
      });
      const [settings] = await identityDb.execute(sql`show lock_timeout`);
      expect(settings?.lock_timeout).toBe("1s");
      await db.transaction(async (audit) => {
        await audit.insert(secretAccessEvents).values({
          companyId: input.companyId,
          heartbeatRunId: input.runId,
          issueId: input.issueId,
          provider: "local_encrypted",
          actorType: "agent",
          actorId: input.agentId,
          consumerType: "agent",
          consumerId: input.agentId,
          outcome: "granted",
        });
        if (operation === "initialize") {
          await expect(initializeRunIdentity(identityDb, {
            ...input, messageIds: [], responsibleUserId: "A", cause: "instruction",
          })).resolves.toMatchObject({ responsibleUserId: "A" });
        } else {
          await expect(captureRunIdentity(identityDb, input)).resolves.toMatchObject({
            run: { responsibleUserId: "A" },
            context: { responsibleUserId: "A" },
          });
        }
      });
    },
  );

  it("does not turn a company-default fallback into personal consent on continuation", async () => {
    const input = await seed();
    await initializeRunIdentity(db, { ...input, messageIds: [], responsibleUserId: "A", cause: "company_default" });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: input.companyId, agentId: input.agentId, status: "running" });
    const retry = await initializeRunIdentity(db, { companyId: input.companyId, runId, parentRunId: input.runId, responsibleUserId: "A", cause: "retry" });
    expect(retry.cause).toBe("company_default");
  });

});
