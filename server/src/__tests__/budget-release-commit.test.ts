import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, projects, costEvents, agents, createDb, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { budgetService, subscribeBudgetScopeRelease } from "../services/budgets.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("budget release outer commit", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("budget-release-commit-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => { await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL client_min_messages = warning`);
    await tx.execute(sql`TRUNCATE companies CASCADE`);
  }); });
  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID(), projectId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Committed release", issuePrefix: `R${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Held project", status: "in_progress" });
    await db.insert(costEvents).values({ companyId, agentId, projectId, provider: "test", model: "test", costCents: 100, occurredAt: new Date() });
    const input = { scopeType: "project" as const, scopeId: projectId, amount: 50,
      windowKind: "lifetime" as const, hardStopEnabled: true, notifyEnabled: false };
    await budgetService(db).upsertPolicy(companyId, input, null);
    const listener = vi.fn(async () => {});
    const unsubscribe = subscribeBudgetScopeRelease(db, listener);
    const raise = (connection: Db) => budgetService(connection).upsertPolicy(companyId, { ...input, amount: 200 }, null);
    return { companyId, projectId, input, listener, unsubscribe, raise };
  }

  it.each(["root", "dedicated", "nested"])("publishes only after a confirmed %s outer commit", async mode => {
    const f = await fixture();
    const work = async (connection: Db) => {
      await connection.transaction(async tx => {
        if (mode === "nested") await tx.transaction(async nested => { await f.raise(nested as unknown as Db); });
        else await f.raise(tx as unknown as Db);
        expect(f.listener).not.toHaveBeenCalled();
      });
      expect(f.listener).toHaveBeenCalledExactlyOnceWith({ companyId: f.companyId, scopeType: "project", scopeId: f.projectId });
    };
    try {
      if (mode === "dedicated") await withDedicatedDbConnection(db, work);
      else await work(db);
      await f.raise(db);
      expect(f.listener).toHaveBeenCalledTimes(1);
    } finally { f.unsubscribe(); }
  });

  it.each(["outer", "nested"])("discards a release on %s rollback", async mode => {
    const f = await fixture();
    try {
      if (mode === "outer") await expect(db.transaction(async tx => {
        await f.raise(tx as unknown as Db);
        throw new Error("abort outer");
      })).rejects.toThrow("abort outer");
      else await db.transaction(async tx => {
        await expect(tx.transaction(async nested => {
          await f.raise(nested as unknown as Db);
          throw new Error("abort savepoint");
        })).rejects.toThrow("abort savepoint");
      });
      expect(f.listener).not.toHaveBeenCalled();
      const [project] = await db.select().from(projects).where(eq(projects.id, f.projectId));
      expect(project!.pauseReason).toBe("budget");
      await f.raise(db);
      expect(f.listener).toHaveBeenCalledTimes(1);
    } finally { f.unsubscribe(); }
  });
});
