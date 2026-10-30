import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createPostgresWakeQueueAdapter } from "../modules/wake-queue/adapters/postgres.js";
import { createReleaseIssueExecution } from "../modules/wake-queue/application/use-cases.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/error-handler.js";
import { verifyDispatchEvidenceSource } from "./helpers/dispatch-evidence-source.js";

const support = await getEmbeddedPostgresTestSupport();

describe("isolated native release evidence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    verifyDispatchEvidenceSource();
    expect(support).toMatchObject({ supported: true });
    database = await startEmbeddedPostgresTestDatabase("dispatch-release-evidence-");
    db = createDb(database.connectionString);
    await db.insert(authUsers).values({ id: "release-operator", name: "Synthetic operator", email: "release@example.test",
      createdAt: new Date(), updatedAt: new Date() });
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterEach(async () => { await heartbeatService(db).drainActiveRunExecutions(); });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  function release(database = db) {
    return createReleaseIssueExecution({ issueLock: createPostgresWakeQueueAdapter(database, {
      resolveResponsibleUserId: async () => "release-operator",
      getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
      resolveSessionBeforeForWakeup: async () => null,
    }), recovery: {
      escalateStrandedAssignedIssue: async () => { throw new Error("Unexpected recovery escalation in isolated release"); },
      escalateStrandedRecoveryIssueInPlace: async () => { throw new Error("Unexpected recovery escalation in isolated release"); },
    } });
  }

  function boardApp(companyId: string) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", source: "session", userId: "release-operator", companyIds: [companyId],
        memberships: [{ companyId, status: "active", membershipRole: "operator" }], isInstanceAdmin: false };
      next();
    });
    app.use("/api", issueRoutes(db, {} as Parameters<typeof issueRoutes>[1]));
    app.use(errorHandler);
    return app;
  }

  async function seed(defer = true) {
    const [company] = await db.insert(companies).values({ name: "Synthetic release", issuePrefix: `R${randomUUID().slice(0, 7)}`,
      defaultResponsibleUserId: "release-operator" }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: "release-operator",
      membershipRole: "operator", status: "active" });
    const [old, target] = await db.insert(agents).values(["Old owner", "Target"].map(name => ({ companyId: company.id, name,
      role: "engineer", status: "idle", adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }))).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Synthetic locked assignment", status: "todo",
      assigneeAgentId: defer ? target.id : old.id, responsibleUserId: "release-operator" }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: old.id, status: "running",
      invocationSource: "assignment", startedAt: new Date(), responsibleUserId: "release-operator", contextSnapshot: { issueId: issue.id } }).returning();
    await db.update(issues).set({ executionRunId: source.id, executionLockedAt: new Date() }).where(eq(issues.id, issue.id));
    const service = heartbeatService(db, { runtimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    const response = defer ? await service.wakeup(target.id, { source: "assignment", triggerDetail: "system", reason: "issue_assigned",
      payload: { issueId: issue.id, mutation: "update" }, contextSnapshot: { issueId: issue.id, source: "issue.update" },
      requestedByActorType: "user", requestedByActorId: "release-operator" }) : null;
    expect(response).toBeNull();
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, target.id));
    if (defer) expect(wake).toMatchObject({ status: "deferred_issue_execution", runId: null });
    return { company, old, target, issue, source, wake, service };
  }

  async function finish(f: Awaited<ReturnType<typeof seed>>, status = "succeeded") {
    await db.update(heartbeatRuns).set({ status, finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.source.id));
    return release()({ companyId: f.company.id, runId: f.source.id, now: new Date(), suppressImmediateRecovery: true });
  }

  async function evidence(label: string, f: Awaited<ReturnType<typeof seed>>, extra: Record<string, unknown>) {
    if (!process.env.DISPATCH_EVIDENCE_FILE) return;
    await appendFile(process.env.DISPATCH_EVIDENCE_FILE, JSON.stringify({ label, cwd: process.cwd(),
      sourceSha: process.env.DISPATCH_EVIDENCE_SOURCE_SHA ?? "unspecified", database: "disposable embedded PostgreSQL",
      producerScope: "real heartbeat assignment admission after synthetic assignment; HTTP PATCH producer not exercised",
      companyId: f.company.id, issueId: f.issue.id, sourceRunId: f.source.id, before: f.wake, ...extra,
      databaseIdentity: (await db.execute(sql`select version() as version, current_database() as database, inet_server_port() as port`))[0],
      issues: await db.select().from(issues).where(eq(issues.companyId, f.company.id)),
      wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company.id)),
      runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.company.id)),
    }) + "\n");
  }

  it("promotes the accepted assignment through normal release and deduplicates a reconstructed release owner", async () => {
    const f = await seed();
    const first = await finish(f);
    expect(first.outcome.kind).toBe("promoted");
    const duplicate = await release()({ companyId: f.company.id, runId: f.source.id, now: new Date(), suppressImmediateRecovery: true });
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id));
    expect(wake.runId).toBeTruthy();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.target.id));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: wake.runId, status: "queued", startedAt: null });
    await evidence("assignment-normal-release-and-duplicate", f, { first, duplicate, providerStart: "absent" });
  });

  it("preserves a paused target's exact accepted payload on normal release", async () => {
    const f = await seed();
    await db.update(agents).set({ status: "paused", pauseReason: "manual" }).where(eq(agents.id, f.target.id));
    const result = await finish(f);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id));
    expect(wake).toMatchObject({ status: "deferred_issue_execution", runId: null, payload: f.wake.payload });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.target.id))).toHaveLength(0);
    await evidence("paused-target-release-refusal", f, { result, refusal: "defer_agent_pause" });
    await db.update(agents).set({ status: "idle", pauseReason: null }).where(eq(agents.id, f.target.id));
    const restored = await release()({ companyId: f.company.id, runId: f.source.id, now: new Date(), suppressImmediateRecovery: true });
    const [eligible] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id));
    await evidence("paused-target-eligibility-restored", f, { restored, receiptAfter: eligible,
      releaseScope: "synthetic gate restoration followed by explicit native source release; automatic eligibility notification not claimed" });
    expect(restored.outcome.kind).toBe("promoted");
    expect(eligible.runId).toBeTruthy();
  });

  it("rolls back a crash before release commit and binds one successor after response loss and duplicate release", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.source.id));
    const interrupted = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      const transaction: typeof db.transaction = (callback, options) => target.transaction(async tx => {
        await callback(tx);
        throw new Error("synthetic crash before release commit");
      }, options);
      return transaction;
    } });
    const input = { companyId: f.company.id, runId: f.source.id, now: new Date(), suppressImmediateRecovery: true };
    await expect(release(interrupted)(input)).rejects.toThrow("synthetic crash before release commit");
    const [retained] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id));
    expect(retained).toMatchObject({ status: "deferred_issue_execution", runId: null, payload: f.wake.payload });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.target.id))).toHaveLength(0);
    await expect((async () => { await release()(input); throw new Error("synthetic lost committed response"); })())
      .rejects.toThrow("synthetic lost committed response");
    await Promise.all([release()(input), release()(input)]);
    const [bound] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id));
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.target.id));
    expect(runs).toHaveLength(1);
    expect(bound.runId).toBe(runs[0].id);
    await evidence("release-commit-fault-and-response-loss", f, { retainedBeforeCommit: retained, boundAfterRestart: bound,
      restartScope: "new native adapter instances over the same isolated database; process-kill restart not exercised" });
  });

  it("drains two eligible issue queues for the same target in one native resume pass", async () => {
    const first = await seed();
    const [issue] = await db.insert(issues).values({ companyId: first.company.id, title: "Second synthetic issue", status: "todo",
      assigneeAgentId: first.target.id, responsibleUserId: "release-operator" }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId: first.company.id, agentId: first.old.id, status: "running",
      invocationSource: "assignment", startedAt: new Date(), responsibleUserId: "release-operator", contextSnapshot: { issueId: issue.id } }).returning();
    await db.update(issues).set({ executionRunId: source.id, executionLockedAt: new Date() }).where(eq(issues.id, issue.id));
    expect(await first.service.wakeup(first.target.id, { source: "assignment", reason: "issue_assigned", payload: { issueId: issue.id },
      requestedByActorType: "user", requestedByActorId: "release-operator" })).toBeNull();
    const [wake] = await db.select().from(agentWakeupRequests).where(sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`);
    const second = { ...first, issue, source, wake };
    await finish(first);
    await finish(second);
    await first.service.resumeQueuedRuns();
    await first.service.drainActiveRunExecutions();
    for (const f of [first, second]) {
      const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.wake.id));
      const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wake.runId!));
      expect(run).toMatchObject({ agentId: f.target.id, status: "succeeded", errorCode: null });
      expect(run.startedAt).toBeInstanceOf(Date);
      await evidence("two-issue-drain-control", f, { matchingRunId: run.id,
        fairnessScope: "two eligible issues of the same company and target agent under maxConcurrentRuns=1; no new scheduler" });
    }
  }, 90_000);

  it("promotes an ordinary deferred user comment and preserves its native context", async () => {
    const base = await seed(false);
    await db.update(issues).set({ assigneeAgentId: base.target.id }).where(eq(issues.id, base.issue.id));
    const [comment] = await db.insert(issueComments).values({ companyId: base.company.id, issueId: base.issue.id,
      authorType: "user", authorUserId: "release-operator", body: "Synthetic ordinary user comment" }).returning();
    expect(await base.service.wakeup(base.target.id, { source: "automation", reason: "issue_commented",
      payload: { issueId: base.issue.id, commentId: comment.id, mutation: "comment" },
      contextSnapshot: { issueId: base.issue.id, source: "issue.comment", wakeCommentId: comment.id },
      requestedByActorType: "user", requestedByActorId: "release-operator" })).toBeNull();
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, base.target.id));
    const f = { ...base, wake };
    expect((await finish(f)).outcome.kind).toBe("promoted");
    const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, after.runId!));
    expect(run).toMatchObject({ status: "queued", startedAt: null, contextSnapshot: { wakeCommentIds: [comment.id] } });
    await evidence("ordinary-comment-release-control", f, { comment, receiptAfter: after });
  });

  it("promotes the native HTTP interaction continuation after its source execution releases", async () => {
    const base = await seed(false);
    await db.update(issues).set({ assigneeAgentId: base.target.id }).where(eq(issues.id, base.issue.id));
    const app = boardApp(base.company.id);
    const created = await request(app).post(`/api/issues/${base.issue.id}/interactions`).send({ kind: "request_confirmation",
      continuationPolicy: "wake_assignee", payload: { version: 1, prompt: "Synthetic continuation approval" } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const accepted = await request(app).post(`/api/issues/${base.issue.id}/interactions/${created.body.id}/accept`).send({});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    await base.service.drainActiveRunExecutions();
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, base.target.id));
    expect(wake).toMatchObject({ status: "deferred_issue_execution", runId: null });
    const f = { ...base, wake };
    const result = await finish(f);
    expect(result.outcome.kind).toBe("promoted");
    const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wake.id));
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, after.runId!));
    expect(run).toMatchObject({ status: "queued", startedAt: null, contextSnapshot: { interactionId: created.body.id } });
    await evidence("interaction-release-control", f, { interactionCreated: created.body, interactionAccepted: accepted.body,
      receiptAfter: after, producerScope: "real HTTP interaction create and accept; real native release" });
  });

  it.each(["running", "queued"])("characterizes HTTP assignment while a synthetic old owner is %s", async status => {
    const f = await seed(false);
    await db.update(heartbeatRuns).set({ status, startedAt: status === "queued" ? null : f.source.startedAt })
      .where(eq(heartbeatRuns.id, f.source.id));
    const app = boardApp(f.company.id);
    const response = await request(app).patch(`/api/issues/${f.issue.id}`).send({ assigneeAgentId: f.target.id });
    await f.service.drainActiveRunExecutions();
    await evidence(`http-assignment-${status}`, f, { httpStatus: response.status, httpBody: response.body,
      producerScope: "real HTTP PATCH with synthetic board actor and disposable PostgreSQL; no provider launched for the old owner" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    if (status === "queued") {
      const [deferred] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId, f.target.id));
      expect(deferred).toMatchObject({ status: "deferred_issue_execution", runId: null });
      await f.service.resumeQueuedRuns();
      await f.service.drainActiveRunExecutions();
      const [after] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, deferred.id));
      const targets = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.target.id));
      await evidence("http-queued-owner-after-stale-dispatch", f, { receiptBefore: deferred, receiptAfter: after,
        producerScope: "real HTTP PATCH followed by real resumeQueuedRuns and native stale-dispatch cancellation" });
      if (process.env.DISPATCH_EVIDENCE_EXPECT_DEFERRED_OWNER === "stalled") {
        expect(after).toMatchObject({ status: "deferred_issue_execution", runId: null, payload: deferred.payload });
        expect(targets).toHaveLength(0);
      } else {
        expect(after).toMatchObject({ status: "cancelled", runId: null, payload: deferred.payload,
          error: "Admitted again after the run that held the task ended" });
        const readmitted = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey,
          `deferred-owner-release:${f.source.id}:${deferred.id}`));
        expect(readmitted).toHaveLength(1);
        expect(readmitted[0].runId).toBeTruthy();
        expect(targets.find(run => run.id === readmitted[0].runId)).toMatchObject({ status: "succeeded", startedAt: expect.any(Date) });
      }
      if (process.env.DISPATCH_EVIDENCE_ORACLE === "queued-owner") expect(targets.some(run => run.startedAt !== null)).toBe(true);
    }
    const [old] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.source.id));
    expect(old.status).toBe("cancelled");
    if (status === "queued") return;
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, f.target.id));
    const assigned = runs.filter(run => run.contextSnapshot?.wakeReason === "issue_assigned");
    expect(assigned).toHaveLength(1);
    expect(assigned[0]).toMatchObject({ status: "succeeded", errorCode: null });
    expect(assigned[0].startedAt).toBeInstanceOf(Date);
  });
});
