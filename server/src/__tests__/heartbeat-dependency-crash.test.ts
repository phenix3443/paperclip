import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, authUsers, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedNativeDependency } from "./helpers/native-dependency-fixture.js";

const support = await getEmbeddedPostgresTestSupport();
const fixtures = path.resolve("server/src/__tests__/helpers/fixtures");
const children = new Set<ChildProcess>();
const messages = new WeakMap<ChildProcess, Array<Record<string, unknown>>>();
const proofs: Array<Record<string, unknown>> = [];

function start(script: string, env: NodeJS.ProcessEnv, typescript = false) {
  const child = fork(path.join(fixtures, script), [], { env, stdio: ["ignore", "pipe", "pipe", "ipc"],
    execArgv: typescript ? ["--import", path.resolve("server/node_modules/tsx/dist/loader.mjs")] : [] });
  children.add(child);
  const history: Array<Record<string, unknown>> = [];
  messages.set(child, history);
  child.on("message", message => history.push(message as Record<string, unknown>));
  child.stderr?.on("data", chunk => process.stderr.write(chunk));
  child.stdout?.on("data", chunk => process.stdout.write(chunk));
  return child;
}

async function message(child: ChildProcess, type: string) {
  const find = () => messages.get(child)?.find(value => value.type === type);
  if (find()) return find()!;
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Controller did not report ${type}: ${JSON.stringify(messages.get(child))}`)), 40_000);
    const receive = (value: unknown) => {
      const event = value as Record<string, unknown>;
      if (event.type === type) finish(null, event);
      if (event.type === "failed") finish(new Error(String(event.message)));
    };
    const exit = (code: number | null) => finish(new Error(`Controller exited ${code} before ${type}`));
    function finish(error: Error | null, value?: Record<string, unknown>) {
      clearTimeout(timer); child.off("message", receive); child.off("exit", exit);
      if (error) reject(error); else resolve(value!);
    }
    child.on("message", receive); child.once("exit", exit);
  });
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) { children.delete(child); return; }
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  children.delete(child);
}

async function waitFor(check: () => Promise<boolean>) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Persisted result did not reach the controlled boundary");
}

(support.supported ? describe : describe.skip)("dependency admission across controller process loss", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let directory: string;
  beforeAll(async () => {
    await fs.mkdir(path.resolve(".paperclip/test"), { recursive: true });
    directory = await fs.mkdtemp(path.resolve(".paperclip/test/dependency-crash-"));
    temporary = await startEmbeddedPostgresTestDatabase("dependency-process-crash-");
    db = createDb(temporary.connectionString);
    await db.insert(authUsers).values({ id: "responsible-user", name: "Fixture owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 30_000);
  afterAll(async () => {
    await Promise.all([...children].map(stop));
    await temporary?.cleanup();
    await fs.rm(directory, { recursive: true, force: true });
    console.info("DEPENDENCY_CRASH_PROOF", JSON.stringify(proofs));
  });

  it.each(["pre_dispatch", "post_accept", "post_result"])("preserves admission at %s", async phase => {
    const f = await seedNativeDependency(db, "idle", true);
    const ledger = path.join(directory, `${phase}.jsonl`);
    await fs.writeFile(ledger, "");
    const env = { ...process.env };
    delete env.PAPERCLIP_API_KEY;
    const endpoint = start("dependency-http-endpoint.mjs", { ...env, PAPERCLIP_TEST_ACCEPTANCE_PATH: ledger });
    const ready = await message(endpoint, "ready");
    const origin = `http://127.0.0.1:${ready.port}`;
    await db.update(agents).set({ adapterType: "http", adapterConfig: { url: origin, timeoutMs: 60_000 } }).where(eq(agents.id, f.agentId));
    const controllerEnv = { ...env, PAPERCLIP_TEST_CONTROLLER_DATABASE_URL: temporary.connectionString,
      PAPERCLIP_TEST_CONTROLLER_COMPANY_ID: f.companyId, PAPERCLIP_HTTP_ADAPTER_PRIVATE_ENDPOINT_ALLOWLIST: origin };
    let runId: string;
    let release!: () => void;
    let heldReceipt: Promise<unknown> | undefined;
    const barrierKey = Math.floor(Math.random() * 1_000_000) + 1_000;
    if (phase === "pre_dispatch") {
      let acquired!: () => void;
      const locked = new Promise<void>(resolve => { acquired = resolve; });
      const held = new Promise<void>(resolve => { release = resolve; });
      heldReceipt = db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(${barrierKey})`);
        acquired(); await held;
      });
      await locked;
      await db.execute(sql.raw(`CREATE FUNCTION dependency_dispatch_barrier() RETURNS trigger AS $$
        BEGIN IF NEW.company_id = '${f.companyId}'::uuid AND NEW.execution_stage = 'dispatching'
          AND OLD.execution_stage IS DISTINCT FROM 'dispatching' THEN PERFORM pg_advisory_xact_lock(${barrierKey}); END IF;
        RETURN NEW; END; $$ LANGUAGE plpgsql;
        CREATE TRIGGER dependency_dispatch_barrier BEFORE UPDATE ON heartbeat_runs FOR EACH ROW EXECUTE FUNCTION dependency_dispatch_barrier();`));
    }
    const first = start("dependency-controller.ts", { ...controllerEnv, PAPERCLIP_TEST_CONTROLLER_MODE: "dispatch" }, true);
    try {
      if (phase === "pre_dispatch") {
        await waitFor(async () => (await db.execute<{ waiting: boolean }>(sql`select exists (
          select 1 from pg_locks where locktype = 'advisory' and objid = ${barrierKey}::oid and not granted) as waiting`))[0]!.waiting);
        const [preparing] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, f.companyId),
          sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${f.issueId}`));
        runId = preparing!.id;
        expect((await fs.readFile(ledger, "utf8")).trim()).toBe("");
      } else {
        const accepted = await message(endpoint, "accepted");
        runId = String(accepted.runId);
      }
      const [admitted] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(admitted!.executionStage).toBe(phase === "pre_dispatch" ? "preparing" : "dispatching");
      const [intent] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.intent.id));
      expect(intent!.runId).toBe(runId);
      if (phase === "post_result") {
        let acquired!: () => void;
        const locked = new Promise<void>(resolve => { acquired = resolve; });
        const held = new Promise<void>(resolve => { release = resolve; });
        heldReceipt = db.transaction(async tx => {
          await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, admitted!.wakeupRequestId!)).for("update");
          acquired(); await held;
        });
        await locked;
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
        endpoint.send({ type: "reply", runId });
        await waitFor(async () => (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]?.status === "succeeded");
      }
      await stop(first);
      release?.(); await heldReceipt;
      await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(0) }).where(eq(heartbeatRuns.id, runId));
      const second = start("dependency-controller.ts", { ...controllerEnv, PAPERCLIP_TEST_CONTROLLER_MODE: "recover", PAPERCLIP_TEST_ELAPSE_RETRY_DELAY: String(phase === "pre_dispatch") }, true);
      if (phase === "pre_dispatch") {
        const accepted = await message(endpoint, "accepted");
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, f.issueId));
        endpoint.send({ type: "reply", runId: accepted.runId });
      }
      await message(second, "drained");
      const records = (await fs.readFile(ledger, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      expect(records).toHaveLength(1);
      const [original] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, f.intent.id));
      const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, admitted!.wakeupRequestId!));
      const [recovered] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(original!.runId).toBe(runId);
      expect(receipt!.runId).toBe(runId);
      if (phase === "post_accept") expect(recovered).toMatchObject({ status: "failed", errorCode: "process_lost" });
      if (phase === "post_result") {
        expect(recovered!.status).toBe("succeeded");
        expect(receipt!.status).toBe("completed");
      }
      if (phase === "pre_dispatch") {
        const [retry] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, records[0].runId), eq(heartbeatRuns.companyId, f.companyId)));
        expect(retry!.contextSnapshot?.retryOfRunId).toBe(runId);
      }
      proofs.push({ phase, originalIntentId: f.intent.id, receiptId: receipt!.id, admittedRunId: runId,
        dispatchStage: admitted!.executionStage, recoveredStatus: recovered!.status, persistedResult: recovered!.resultJson,
        externalAcceptanceCount: records.length, runtimeAttemptRunId: records[0].runId });
      await stop(second);
    } finally {
      release?.(); await heldReceipt;
      await stop(first); await stop(endpoint);
    }
  }, 90_000);
});
