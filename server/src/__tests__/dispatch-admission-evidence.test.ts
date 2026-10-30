import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issueRecoveryActions, issueRelations, issues } from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import { heartbeatService } from "../services/heartbeat.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { verifyDispatchEvidenceSource } from "./helpers/dispatch-evidence-source.js";
import { issueTreeControlService } from "../services/issue-tree-control.js";

const support = await getEmbeddedPostgresTestSupport();

describe("isolated plugin wake admission evidence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const hosts: ReturnType<typeof buildHostServices>[] = [];

  beforeAll(async () => {
    verifyDispatchEvidenceSource();
    expect(support, "Persistence is required; unsupported hosts must fail rather than claim coverage").toMatchObject({ supported: true });
    database = await startEmbeddedPostgresTestDatabase("dispatch-admission-evidence-");
    db = createDb(database.connectionString);
    await db.insert(authUsers).values({ id: "synthetic-operator", name: "Synthetic operator", email: "operator@example.test",
      createdAt: new Date(), updatedAt: new Date() });
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterEach(async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    for (const host of hosts.splice(0)) host.dispose();
  });
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  function host(database = db) {
    const result = buildHostServices(database, "synthetic-plugin", "synthetic.dispatch-evidence", createPluginEventBus(), undefined,
      { heartbeatRuntimeEnv: { ...process.env, PAPERCLIP_IN_WORKTREE: "false" } });
    hosts.push(result);
    return result;
  }

  async function seed() {
    const [company] = await db.insert(companies).values({ name: "Synthetic admission", issuePrefix: `S${randomUUID().slice(0, 7)}`,
      defaultResponsibleUserId: "synthetic-operator" }).returning();
    await db.insert(companyMemberships).values({ companyId: company.id, principalType: "user", principalId: "synthetic-operator",
      membershipRole: "operator", status: "active" });
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Synthetic target", role: "engineer",
      status: "idle", adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } }).returning();
    const [issue] = await db.insert(issues).values({ companyId: company.id, title: "Synthetic dispatch", status: "todo",
      assigneeAgentId: agent.id, responsibleUserId: "synthetic-operator" }).returning();
    const [busy] = await db.insert(heartbeatRuns).values({ companyId: company.id, agentId: agent.id, status: "running",
      invocationSource: "on_demand", startedAt: new Date(), contextSnapshot: {} }).returning();
    return { company, agent, issue, busy };
  }

  async function evidence(label: string, companyId: string, extra: Record<string, unknown>) {
    const value = { label, cwd: process.cwd(), sourceSha: process.env.DISPATCH_EVIDENCE_SOURCE_SHA ?? "unspecified",
      database: "disposable embedded PostgreSQL", companyId, ...extra,
      databaseIdentity: (await db.execute(sql`select version() as version, current_database() as database, inet_server_port() as port`))[0],
      issues: await db.select().from(issues).where(eq(issues.companyId, companyId)),
      wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
      runs: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)) };
    if (process.env.DISPATCH_EVIDENCE_FILE) await appendFile(process.env.DISPATCH_EVIDENCE_FILE, JSON.stringify(value) + "\n");
  }

  it("coalesces a repeated ordinary plugin key while the matching run remains queued", async () => {
    const f = await seed(), service = host();
    const request = { companyId: f.company.id, issueId: f.issue.id, idempotencyKey: "synthetic:ordinary-key" };
    const first = await service.issues.requestWakeup(request);
    const repeated = await service.issues.requestWakeup(request);
    expect(first.queued).toBe(true);
    expect(repeated.runId).toBe(first.runId);
    const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.company.id), eq(heartbeatRuns.status, "queued")));
    expect(runs).toHaveLength(1);
    expect(runs[0].startedAt).toBeNull();
    await evidence("queued-key-positive-control", f.company.id, { request, first, repeated, providerStart: "absent" });
  });

  it("admits another queued run after terminal receipt redelivery with the same ordinary key", async () => {
    const f = await seed();
    const request = { companyId: f.company.id, issueId: f.issue.id, idempotencyKey: "synthetic:terminal-key" };
    const first = await host().issues.requestWakeup(request);
    expect(first.runId).toBeTruthy();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, first.runId!));
    await db.update(agentWakeupRequests).set({ status: "completed", finishedAt: new Date() }).where(eq(agentWakeupRequests.runId, first.runId!));
    const repeated = await host().issues.requestWakeup(request);
    expect(repeated.queued).toBe(true);
    expect(repeated.runId).not.toBe(first.runId);
    const receipts = await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, f.company.id),
      eq(agentWakeupRequests.idempotencyKey, request.idempotencyKey)));
    expect(receipts).toHaveLength(2);
    await evidence("terminal-key-characterization", f.company.id, { request, first, repeated,
      terminalTransition: "synthetic database fixture; no provider completion claimed", providerStart: "absent" });
    if (process.env.DISPATCH_EVIDENCE_ORACLE === "unique-key") expect(repeated.runId, "Ordinary plugin keys must not be assumed to fence terminal replay").toBe(first.runId);
  });

  it("reconciles a lost caller response to the same queued run after host reconstruction", async () => {
    const f = await seed();
    const request = { companyId: f.company.id, issueId: f.issue.id, idempotencyKey: "synthetic:lost-response" };
    let accepted: Awaited<ReturnType<ReturnType<typeof buildHostServices>["issues"]["requestWakeup"]>> | undefined;
    await expect((async () => {
      accepted = await host().issues.requestWakeup(request);
      throw new Error("synthetic caller loses the response after native admission");
    })()).rejects.toThrow("synthetic caller loses");
    const repeated = await host().issues.requestWakeup(request);
    expect(repeated.runId).toBe(accepted!.runId);
    await evidence("lost-response-queued-control", f.company.id, { request, accepted, repeated,
      restartScope: "host service reconstruction only; not an OS process restart", providerStart: "absent" });
  });

  it("coalesces simultaneous host requests while the same task remains queued", async () => {
    const f = await seed();
    const request = { companyId: f.company.id, issueId: f.issue.id, idempotencyKey: "synthetic:concurrent" };
    const [first, second] = await Promise.all([host().issues.requestWakeup(request), host().issues.requestWakeup(request)]);
    expect(first.queued).toBe(true);
    expect(second.runId).toBe(first.runId);
    await evidence("simultaneous-queued-control", f.company.id, { request, first, second, providerStart: "absent" });
  });

  it.each(["scheduled_retry"])("characterizes matching SDK requests when the accepted task run is %s", async status => {
    const f = await seed(), service = host();
    const request = { companyId: f.company.id, issueId: f.issue.id, idempotencyKey: `synthetic:matching-${status}` };
    const first = await service.issues.requestWakeup(request);
    expect(first.runId).toBeTruthy();
    await db.update(heartbeatRuns).set({ status, startedAt: null })
      .where(eq(heartbeatRuns.id, first.runId!));
    const repeated = await host().issues.requestWakeup(request);
    await evidence(`matching-${status}`, f.company.id, { request, first, repeated,
      statusTransition: "synthetic persisted status; not proof of provider start or scheduled retry delivery" });
    expect(repeated.runId).toBe(first.runId);
  });

  it("retains durable deferred requests separately from a false SDK queued response", async () => {
    const f = await seed();
    const [holder] = await db.insert(agents).values({ companyId: f.company.id, name: "Synthetic lock holder", role: "engineer", adapterType: "process" }).returning();
    await db.update(heartbeatRuns).set({ agentId: holder.id, contextSnapshot: { issueId: f.issue.id } }).where(eq(heartbeatRuns.id, f.busy.id));
    await db.update(issues).set({ executionRunId: f.busy.id, executionLockedAt: new Date() }).where(eq(issues.id, f.issue.id));
    const request = { companyId: f.company.id, issueId: f.issue.id, idempotencyKey: "synthetic:deferred-key" };
    const first = await host().issues.requestWakeup(request);
    const repeated = await host().issues.requestWakeup(request);
    await evidence("sdk-deferred-response", f.company.id, { request, first, repeated, providerStart: "absent" });
    expect(first).toEqual({ queued: false, runId: null });
    expect(repeated).toEqual(first);
    const wakes = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.company.id));
    expect(wakes.some(wake => wake.status === "deferred_issue_execution" && wake.runId === null)).toBe(true);
  });

  it("characterizes a repeated ordinary key while the matching process is actually running", async () => {
    const f = await seed(), scratch = await mkdtemp(join(tmpdir(), "sdk-running-evidence-"));
    const started = join(scratch, "started"), released = join(scratch, "released");
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.busy.id));
    await db.update(agents).set({ adapterConfig: { command: process.execPath,
      args: ["-e", `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)},'started');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(released)})){clearInterval(timer);process.exit(0)}},25)`] } })
      .where(eq(agents.id, f.agent.id));
    const request = { companyId: f.company.id, issueId: f.issue.id, idempotencyKey: "synthetic:actual-running" };
    try {
      const first = await host().issues.requestWakeup(request);
      await vi.waitFor(async () => { expect(await readFile(started, "utf8")).toBe("started"); }, { timeout: 10_000, interval: 25 });
      const repeated = await host().issues.requestWakeup(request);
      await evidence("matching-real-running", f.company.id, { request, first, repeated, processMarker: "started" });
      expect(repeated.runId).toBe(first.runId);
    } finally {
      await writeFile(released, "release");
      await heartbeatService(db).drainActiveRunExecutions();
      await rm(scratch, { recursive: true, force: true });
    }
  });

  it("records actual start separately from host queue acceptance for an eligible process target", async () => {
    const f = await seed();
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, f.busy.id));
    const response = await host().issues.requestWakeup({ companyId: f.company.id, issueId: f.issue.id, idempotencyKey: "synthetic:start-control" });
    await heartbeatService(db).drainActiveRunExecutions();
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, response.runId!));
    await evidence("actual-process-start-control", f.company.id, { response });
    expect(response.queued).toBe(true);
    expect(run).toMatchObject({ agentId: f.agent.id, status: "succeeded", errorCode: null });
    expect(run.startedAt).toBeInstanceOf(Date);
    expect(run.finishedAt).toBeInstanceOf(Date);
  });

  it("characterizes owner replacement between SDK preflight and native transaction admission", async () => {
    const f = await seed();
    const [next] = await db.insert(agents).values({ companyId: f.company.id, name: "Replacement owner", role: "engineer",
      status: "idle", adapterType: "process" }).returning();
    let barrierEntered = false;
    const observed = new Proxy(db, { get(target, key) {
      if (key !== "transaction") return Reflect.get(target, key);
      const transaction: typeof db.transaction = async (callback, options) => {
        if (!barrierEntered) {
          barrierEntered = true;
          await db.update(issues).set({ assigneeAgentId: next.id, description: "Synthetic submission 2222222222222222222222222222222222222222" })
            .where(eq(issues.id, f.issue.id));
        }
        return target.transaction(callback, options);
      };
      return transaction;
    } });
    const request = { companyId: f.company.id, issueId: f.issue.id, idempotencyKey: "synthetic:owner-and-submission-v1" };
    const response = await host(observed).issues.requestWakeup(request);
    expect(barrierEntered).toBe(true);
    const [current] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    expect(current.assigneeAgentId).toBe(next.id);
    await evidence("owner-submission-race", f.company.id, { request, response, originalOwnerId: f.agent.id,
      currentOwnerId: next.id, barrier: "real issue update before the first native transaction; no database calls mocked",
      providerStart: "absent; original agent remains busy" });
    expect(response.queued).toBe(true);
    const [admitted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, response.runId!));
    expect(admitted).toMatchObject({ agentId: f.agent.id, status: "queued", startedAt: null });
  });

  it.each(["cancelled", "paused", "blocker", "tree-hold", "recovery-hold"])("does not admit a task run through the %s gate", async gate => {
    const f = await seed(), service = host();
    if (gate === "cancelled") await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, f.issue.id));
    if (gate === "paused") await db.update(agents).set({ status: "paused", pauseReason: "manual" }).where(eq(agents.id, f.agent.id));
    if (gate === "blocker") {
      const [blocker] = await db.insert(issues).values({ companyId: f.company.id, title: "Synthetic unresolved blocker", status: "todo" }).returning();
      await db.insert(issueRelations).values({ companyId: f.company.id, issueId: blocker.id, relatedIssueId: f.issue.id, type: "blocks" });
    }
    if (gate === "tree-hold") await issueTreeControlService(db).createHold(f.company.id, f.issue.id, {
      mode: "pause", reason: "Synthetic subtree pause", actor: { actorType: "user", actorId: "synthetic-operator", userId: "synthetic-operator" },
    });
    if (gate === "recovery-hold") {
      await db.insert(issueRecoveryActions).values({ companyId: f.company.id, sourceIssueId: f.issue.id,
        kind: "active_run_watchdog", ownerType: "board", cause: "legacy_execution_requires_reconciliation",
        status: "active", fingerprint: f.busy.id, evidence: { runId: f.busy.id }, nextAction: "Synthetic hold; no replay authorization" });
    }
    const request = { companyId: f.company.id, issueId: f.issue.id, idempotencyKey: `synthetic:gate-${gate}` };
    let response: unknown, refusal: unknown;
    try { response = await service.issues.requestWakeup(request); }
    catch (error) { refusal = error instanceof Error ? error.message : String(error); }
    await evidence(`admission-gate-${gate}`, f.company.id, { request, response, refusal, providerStart: "absent" });
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.company.id));
    expect(runs).toHaveLength(1);
    if (["cancelled", "paused", "blocker"].includes(gate)) expect(refusal).toEqual(expect.any(String));
    else expect(response).toEqual({ queued: false, runId: null });
  });
});
