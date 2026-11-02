import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, authUsers, connectionGrants, connectionIntentDeliveries, createDb, databaseWorkPending,
  issueThreadInteractions, toolCatalogEntries, toolConnectionInstalls, toolConnections } from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./helpers/connection-delivery-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const branches = ["catalog", "connection credentials", "grant credentials"] as const;

describePostgres("connection cleanup delivery notifications", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let delivery: Awaited<ReturnType<typeof startConnectionDelivery>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-cleanup-delivery-");
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: "owner", name: "Owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);
  beforeEach(async () => { await db.execute(sql`truncate table companies cascade`); });
  afterEach(async () => { vi.restoreAllMocks(); await delivery?.stop(); delivery = null; });
  afterAll(async () => { await db.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  const card = async () => (await db.select().from(issueThreadInteractions))[0]!;
  async function noEffect() {
    expect((await card()).status).toBe("pending");
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_resolved"))).toHaveLength(0);
    expect(delivery!.wakeup).not.toHaveBeenCalled();
  }

  describe.each(branches)("%s", branch => {
    it.each(["commit", "rollback", "outer commit", "outer rollback", "drain", "duplicate", "race", "negative"])("isolates its own notification: %s", async mode => {
      const f = await seedPendingAccessRequest(db, "owner");
      const refs = [{ secretId: f.agentId, configPath: "oauth.access_token" }];
      await db.update(toolConnections).set({ credentialSecretRefs: refs }).where(eq(toolConnections.id, f.connection.id));
      await db.update(connectionGrants).set({ credentialSecretRefs: refs }).where(eq(connectionGrants.connectionId, f.connection.id));
      let open = true, holdSweep = false;
      const sampled = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      delivery = await startConnectionDelivery(db, {
        canRun: () => open,
        beforeSweep: async () => { if (holdSweep) { sampled.resolve(); await release.promise; } },
      });
      await noEffect();
      let reached = 0, targetBaseline = 0;
      const matches = (table: unknown, values: Record<string, unknown>) => branch === "catalog"
        ? table === toolCatalogEntries && values.status === "removed"
        : table === (branch === "connection credentials" ? toolConnections : connectionGrants) && "credentialSecretRefs" in values;
      const update = db.update.bind(db);
      const rawSpy = vi.spyOn(db, "update").mockImplementation(table => {
        const query = update(table), set = query.set.bind(query);
        vi.spyOn(query, "set").mockImplementation(values => {
          if (matches(table, values)) throw new Error("target must own a transaction");
          return set(values);
        });
        return query;
      });
      const transact = db.transaction.bind(db);
      const transactionSpy = vi.spyOn(db, "transaction").mockImplementation(async (callback, config) => {
        let target = false, owned = false;
        const result = await transact(async tx => {
          const write = tx.update.bind(tx), remove = tx.delete.bind(tx);
          const updateSpy = vi.spyOn(tx, "update").mockImplementation(table => {
            if ([toolConnections, connectionGrants, toolCatalogEntries].some(candidate => candidate === table)) owned = true;
            const query = write(table), set = query.set.bind(query);
            vi.spyOn(query, "set").mockImplementation(values => {
              if (matches(table, values)) {
                target = true;
                reached += 1;
                targetBaseline = delivery!.sweeps;
                expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
              }
              return set(values);
            });
            return query;
          });
          const deleteSpy = vi.spyOn(tx, "delete").mockImplementation(table => {
            if (table === toolConnectionInstalls) owned = true;
            return remove(table);
          });
          try {
            const value = await callback(tx);
            if (target) {
              if (mode === "rollback") throw new Error("rollback");
              if (mode === "race") {
                holdSweep = true;
                delivery!.wake();
                await sampled.promise;
              } else if (mode !== "drain") {
                await new Promise(resolve => setTimeout(resolve, 100));
                expect(delivery!.sweeps).toBe(targetBaseline);
                await noEffect();
              }
            }
            return value;
          } finally { updateSpy.mockRestore(); deleteSpy.mockRestore(); }
        }, config);
        if (target) {
          release.resolve();
          if (mode !== "drain") await delivery!.settle(targetBaseline + (mode === "race" ? 2 : 1));
          throw new Error("stop after target commit");
        }
        if (owned) await delivery!.settle();
        return result;
      });
      const produce = () => toolAccessService(db).archiveConnection(f.connection.id, f.companyId);
      try {
        if (mode.startsWith("outer ")) {
          const outerBaseline = delivery.sweeps;
          const outer = transact(async tx => {
            rawSpy.mockRestore();
            transactionSpy.mockRestore();
            const nested = tx.transaction.bind(tx);
            vi.spyOn(tx, "transaction").mockImplementation(async callback => {
              const baseline = delivery!.sweeps;
              const value = await nested(async savepoint => {
                const write = savepoint.update.bind(savepoint);
                const spy = vi.spyOn(savepoint, "update").mockImplementation(table => {
                  const query = write(table), set = query.set.bind(query);
                  vi.spyOn(query, "set").mockImplementation(values => {
                    if (matches(table, values)) reached += 1;
                    return set(values);
                  });
                  return query;
                });
                try { return await callback(savepoint); } finally { spy.mockRestore(); }
              });
              expect(delivery!.sweeps).toBe(baseline);
              return value;
            });
            await toolAccessService(tx as unknown as typeof db).archiveConnection(f.connection.id, f.companyId);
            expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
            expect(reached).toBe(1);
            if (mode === "outer rollback") throw new Error("outer rollback");
          });
          if (mode === "outer rollback") await expect(outer).rejects.toThrow("outer rollback");
          else await outer;
          await delivery.settle(outerBaseline + 1);
          await noEffect();
          expect((await db.select().from(toolConnections))[0]!.credentialSecretRefs)
            .toEqual(mode === "outer rollback" ? refs : []);
          return;
        }
        if (mode === "negative") {
          rawSpy.mockRestore();
          transactionSpy.mockRestore();
          const baseline = delivery.sweeps;
          if (branch === "catalog") await db.update(toolCatalogEntries).set({ status: "removed" });
          else if (branch === "connection credentials") await db.update(toolConnections).set({ credentialSecretRefs: [] });
          else await db.update(connectionGrants).set({ credentialSecretRefs: [] });
          await new Promise(resolve => setTimeout(resolve, 100));
          expect(delivery.sweeps).toBe(baseline);
          await noEffect();
          delivery.wake();
          await delivery.settle(baseline + 1);
          return noEffect();
        }
        if (mode === "drain") open = false;
        for (let attempt = 0; attempt < (mode === "duplicate" ? 2 : 1); attempt += 1) {
          if (attempt === 1 && branch === "grant credentials") await expect(produce()).resolves.toBeDefined();
          else await expect(produce()).rejects.toThrow(mode === "rollback" ? "rollback" : "stop after target commit");
        }
        expect(reached).toBe(mode === "duplicate" && branch !== "grant credentials" ? 2 : 1);
        if (mode === "drain") {
          expect(delivery.sweeps).toBe(targetBaseline);
          await noEffect();
          open = true;
          delivery.wake();
        }
        await delivery.settle(targetBaseline + 1);
        await noEffect();
        if (mode === "rollback") {
          if (branch === "catalog") expect((await db.select().from(toolCatalogEntries))[0]!.status).toBe("active");
          else if (branch === "connection credentials") expect((await db.select().from(toolConnections))[0]!.credentialSecretRefs).toEqual(refs);
          else expect((await db.select().from(connectionGrants))[0]!.credentialSecretRefs).toEqual(refs);
        }
      } finally { release.resolve(); }
    });
  });
});
