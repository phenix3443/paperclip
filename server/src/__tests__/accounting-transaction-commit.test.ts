import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, databaseWorkPending, type Db } from "@paperclipai/db";
import { installDatabaseWorkSignals } from "@paperclipai/db/work-signals";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { withAccountingTransaction } from "../services/accounting-transaction.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerCostAccountingWork } from "../services/budget-enforcement-worker.js";

const publication = vi.hoisted(() => vi.fn());
vi.mock("../services/activity-log.js", () => ({ publishActivity: publication }));

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("accounting commit ownership", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let fixtureNumber = 0;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("accounting-commit-");
    db = createDb(database.connectionString);
  }, 90_000);
  beforeEach(() => publication.mockReset());
  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Before", issuePrefix: `ACOM${++fixtureNumber}` });
    return companyId;
  }

  it.each([true, false])("publishes only after an outer commit (commit=%s)", async commit => {
    const companyId = await fixture();
    const work = db.transaction(async outer => {
      const result = await withAccountingTransaction(outer as unknown as Db, companyId, async (tx, publications) => {
        await tx.update(companies).set({ name: "After" }).where(eq(companies.id, companyId));
        publications.push({ companyId, payload: { action: "changed" }, pluginEvent: null });
        return 42;
      });
      expect(result).toBe(42);
      expect(publication).not.toHaveBeenCalled();
      const [outside] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(outside.name).toBe("Before");
      if (!commit) throw new Error("rollback outer");
    });
    if (commit) await work;
    else await expect(work).rejects.toThrow("rollback outer");
    expect(publication).toHaveBeenCalledTimes(commit ? 1 : 0);
    const [persisted] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(persisted.name).toBe(commit ? "After" : "Before");
  });

  it("discards a rolled-back accounting savepoint and publishes a later successful mutation", async () => {
    const companyId = await fixture();
    await db.transaction(async outer => {
      await expect(withAccountingTransaction(outer as unknown as Db, companyId, async (_tx, publications) => {
        publications.push({ companyId, payload: { action: "discarded" }, pluginEvent: null });
        throw new Error("rollback accounting");
      })).rejects.toThrow("rollback accounting");
      await withAccountingTransaction(outer as unknown as Db, companyId, async (_tx, publications) => {
        publications.push({ companyId, payload: { action: "kept" }, pluginEvent: null });
      });
      expect(publication).not.toHaveBeenCalled();
    });
    expect(publication.mock.calls.map(([value]) => value.payload.action)).toEqual(["kept"]);
  });

  it("reconciles failed callback-only work through the existing accounting coordinator", async () => {
    const companyId = await fixture();
    const errors = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, onError: errors });
    const reconcile = vi.fn(async () => {});
    const worker = registerCostAccountingWork(db, coordinator, reconcile);
    try {
      await worker.ready;
      reconcile.mockClear();
      await expect(withAccountingTransaction(db, companyId, async (_tx, publications) => {
        publications.push({ companyId, payload: { action: "discarded" }, pluginEvent: null });
        throw new Error("rollback callback-only work");
      })).rejects.toThrow("rollback callback-only work");
      await vi.waitFor(() => {
        expect(databaseWorkPending(db)).toBe(false);
        expect(reconcile).toHaveBeenCalled();
      });
      expect(publication).not.toHaveBeenCalled();
      expect(errors).not.toHaveBeenCalled();
      expect(coordinator.nextWakeAt()).toBeNull();
    } finally { worker.stop(); await coordinator.stop(); }
  });

  it.each(["commit", "abort"])("recovers a late accounting %s through the existing coordinator", async outcome => {
    const companyId = await fixture();
    const raw = drizzle(db.$client);
    const transaction = raw.transaction.bind(raw);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let wrote!: () => void;
    const written = new Promise<void>(resolve => { wrote = resolve; });
    let serverDone: Promise<unknown> | undefined;
    raw.transaction = ((callback: Parameters<typeof raw.transaction>[0]) => {
      serverDone = transaction(async tx => {
        const result = await callback(tx);
        wrote();
        await gate;
        if (outcome === "abort") throw new Error("late accounting abort");
        return result;
      });
      void serverDone.catch(() => {});
      return written.then(() => { throw new Error("lost accounting commit response"); });
    }) as typeof raw.transaction;
    const owner = installDatabaseWorkSignals(raw) as unknown as Db;
    const errors = vi.fn();
    const coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError: errors });
    const recovered = vi.fn(async () => {});
    const worker = registerCostAccountingWork(owner, coordinator, recovered);
    try {
      await worker.ready;
      recovered.mockClear();
      await expect(withAccountingTransaction(owner, companyId, async (tx, publications) => {
        await tx.update(companies).set({ name: "Late" }).where(eq(companies.id, companyId));
        publications.push({ companyId, payload: { action: "late" }, pluginEvent: null });
      })).rejects.toThrow("lost accounting commit response");
      await vi.waitFor(() => expect(recovered).toHaveBeenCalled());
      expect(databaseWorkPending(owner)).toBe(true);
      expect(publication).not.toHaveBeenCalled();
      const [before] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(before.name).toBe("Before");
      release();
      await serverDone?.catch(() => {});
      await vi.waitFor(() => expect(databaseWorkPending(owner)).toBe(false), { timeout: 8_000 });
      expect(publication).toHaveBeenCalledTimes(outcome === "commit" ? 1 : 0);
      const [after] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(after.name).toBe(outcome === "commit" ? "Late" : "Before");
      expect(errors).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(coordinator.nextWakeAt()).toBeNull());
    } finally {
      release();
      await serverDone?.catch(() => {});
      worker.stop();
      await coordinator.stop();
    }
  });
});
