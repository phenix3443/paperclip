import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, authUsers, companyMemberships, connectionGrantDelegations, connectionGrants, connectionIntentDeliveries, createDb,
  databaseWorkPending, issueThreadInteractions, toolConnectionInstalls, toolConnections, toolPolicies, toolProfileEntries, toolProfiles } from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./helpers/connection-delivery-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(done: () => boolean) {
  const limit = Date.now() + 5_000;
  while (!done()) {
    if (Date.now() > limit) throw new Error("Condition was not reached");
    await pause(10);
  }
}
type Seeded = Awaited<ReturnType<typeof seedPendingAccessRequest>> & { grants: (typeof connectionGrants.$inferSelect)[] };
type Db = ReturnType<typeof createDb>;

describe.skipIf(!support.supported)("connection grant and install writes notify the connection delivery worker", () => {
  let db!: Db;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let delivery: Awaited<ReturnType<typeof startConnectionDelivery>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-grant-connection-delivery-");
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values(["owner", "other"].map(id => ({ id, name: id, email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date() })));
  }, 20_000);
  beforeEach(async () => { await db.execute(sql`truncate table companies cascade`); });
  afterEach(async () => { await delivery?.stop(); delivery = null; });
  afterAll(async () => { await db.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  const card = async () => (await db.select().from(issueThreadInteractions))[0]!;
  const svc = (client: Db = db) => toolAccessService(client);
  const orgGrant = (f: { companyId: string; connection: { id: string } }) => ({ companyId: f.companyId, connectionId: f.connection.id, kind: "organization" as const, status: "active" as const });
  async function seed(organizationGrants: number): Promise<Seeded> {
    const f = await seedPendingAccessRequest(db, "owner");
    await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Allow", policyType: "allow", selectors: {} });
    await db.delete(connectionGrants).where(eq(connectionGrants.connectionId, f.connection.id));
    const grants = organizationGrants ? await db.insert(connectionGrants).values(Array.from({ length: organizationGrants }, () => orgGrant(f))).returning() : [];
    return { ...f, grants };
  }
  async function seedAppInstall(): Promise<Seeded> {
    const f = await seedPendingAccessRequest(db, "owner");
    const [profile] = await db.insert(toolProfiles).values({ companyId: f.companyId, profileKey: `app:${f.connection.id}`, name: "App", defaultAction: "deny", status: "active" }).returning();
    await db.insert(toolProfileEntries).values({ companyId: f.companyId, profileId: profile!.id, selectorType: "catalog_entry", effect: "include", catalogEntryId: f.tool.id, connectionId: f.connection.id });
    await db.delete(toolConnectionInstalls);
    await db.update(toolConnections).set({ config: { sourceTemplateKey: "sentry", mcpAgentAccessConfigured: true } });
    return { ...f, grants: await db.select().from(connectionGrants) };
  }
  async function seedLegacyInclude(): Promise<Seeded> {
    const f = await seed(0);
    const [profile] = await db.insert(toolProfiles).values({ companyId: f.companyId, profileKey: `app:${f.connection.id}`, name: "App", defaultAction: "deny", status: "active" }).returning();
    await db.insert(toolProfileEntries).values({ companyId: f.companyId, profileId: profile!.id, selectorType: "connection", effect: "include", connectionId: f.connection.id });
    await db.update(toolConnections).set({ config: { sourceTemplateKey: "sentry", mcpAgentAccessConfigured: true } });
    return f;
  }
  const putSameInstall = (f: Seeded, client?: Db) => svc(client).putConnectionInstalls(f.connection.id, { installs: [{ targetType: "agent", targetId: f.agentId }] });
  const count = async (table: string) => (await db.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)}`))[0]!.n;
  async function expectRetiredOnce(connectionId: string) {
    expect(await card()).toMatchObject({ status: "expired", result: expect.objectContaining({ connectionId }) });
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
    expect(delivery!.wakeup).toHaveBeenCalledOnce();
  }
  async function expectNoDurableEffect() {
    expect((await card()).status).toBe("pending");
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_resolved"))).toHaveLength(0);
    expect(delivery!.wakeup).not.toHaveBeenCalled();
  }
  const widening = [
    ["addConnectionInstallation adds the only organization identity", () => seed(0), "connection_grants",
      (f: Seeded, client?: Db) => svc(client).addConnectionInstallation(f.connection.id, {})],
    ["revokeConnectionGrant removes an ambiguous organization identity", () => seed(2), "connection_grant_delegations",
      (f: Seeded, client?: Db) => svc(client).revokeConnectionGrant(f.connection.id, f.grants[0]!.id)],
    ["putConnectionInstalls installs the agent and binds the app profile", seedAppInstall, "tool_connection_installs",
      (f: Seeded, client?: Db) => svc(client).putConnectionInstalls(f.connection.id, { installs: [{ targetType: "agent", targetId: f.agentId }] })],
  ] as const;

  it.each(widening)("retires an exact access request when %s, before any maintenance tick", async (_name, setup, _table, produce) => {
    const f = await setup();
    delivery = await startConnectionDelivery(db);
    expect((await card()).status).toBe("pending");
    const baseline = delivery.sweeps;
    await produce(f);
    await delivery.settle(baseline + 1);
    await expectRetiredOnce(f.connection.id);
  });

  it.each(widening)("registers the notification before the write when %s", async (_name, setup, table, produce) => {
    const f = await setup();
    const before = await count(table);
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    const locker = createDb(temp.connectionString);
    let produced!: Promise<unknown>;
    try {
      await locker.transaction(async (ltx) => {
        await ltx.execute(sql`lock table ${sql.identifier(table)} in exclusive mode`);
        produced = produce(f);
        await until(() => databaseWorkPending(db, DELIVERY_QUEUES.connection));
        expect(await db.select().from(connectionGrants)).toEqual(f.grants);
        expect(await count(table)).toBe(before);
      });
    } finally { await locker.$client.end({ timeout: 1 }); }
    await produced;
    await delivery.settle(baseline + 1);
    await expectRetiredOnce(f.connection.id);
  });

  it("notifies on every write that cannot satisfy the request and keeps the card pending", async () => {
    const f = await seed(2);
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: "other", status: "active", membershipRole: "member" });
    const [personal] = await db.insert(connectionGrants).values({ ...orgGrant(f), kind: "user", subjectUserId: "other" }).returning();
    delivery = await startConnectionDelivery(db);
    const delegationId = async () => (await db.select().from(connectionGrantDelegations))[0]!.id;
    const producers = [
      () => svc().addConnectionInstallation(f.connection.id, { isDefault: true }),
      () => svc().replaceConnectionGrantMembers(f.connection.id, f.grants[0]!.id, ["owner"]),
      () => svc().createConnectionGrantDelegation(f.connection.id, personal!.id, f.agentId, "other"),
      async () => svc().revokeConnectionGrantDelegation(f.connection.id, personal!.id, await delegationId()),
      () => svc().putConnectionInstalls(f.connection.id, { installs: [] }),
      () => svc().putConnectionInstalls(f.connection.id, { installs: [{ targetType: "agent", targetId: f.agentId }] }),
      () => svc().revokeConnectionGrant(f.connection.id, personal!.id),
    ];
    for (const produce of producers) {
      const baseline = delivery.sweeps;
      await produce();
      await delivery.settle(baseline + 1);
      expect((await card()).status).toBe("pending");
    }
    expect(delivery.wakeup).not.toHaveBeenCalled();
  });

  it("notifies before putConnectionInstalls drops a legacy include and publishes only when the caller commits", async () => {
    const f = await seedLegacyInclude();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    const locker = createDb(temp.connectionString);
    let produced!: Promise<unknown>;
    try {
      await locker.transaction(async (ltx) => {
        await ltx.execute(sql`lock table tool_profile_entries in exclusive mode`);
        produced = db.transaction(tx => putSameInstall(f, tx as unknown as Db));
        await until(() => databaseWorkPending(db, DELIVERY_QUEUES.connection));
        expect(await count("tool_profile_entries")).toBe(1);
        await pause(200);
        expect(delivery!.sweeps).toBe(baseline);
      });
    } finally { await locker.$client.end({ timeout: 1 }); }
    await produced;
    await delivery.settle(baseline + 1);
    expect([await count("tool_profile_entries"), await count("tool_connection_installs")]).toEqual([0, 1]);
    await expectNoDurableEffect();
  });

  it("does not notify when a replacement, delegation or install change writes nothing", async () => {
    const f = await seedPendingAccessRequest(db, "owner");
    const [personal] = await db.select().from(connectionGrants);
    await db.insert(connectionGrantDelegations).values({ companyId: f.companyId, grantId: personal!.id, agentId: f.agentId, createdByUserId: "owner" });
    const [organization] = await db.insert(connectionGrants).values(orgGrant(f)).returning();
    await db.delete(toolConnectionInstalls);
    await db.update(toolConnections).set({ config: { mcpAgentAccessConfigured: true } });
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await svc().replaceConnectionGrantMembers(f.connection.id, organization!.id, []);
    await svc().createConnectionGrantDelegation(f.connection.id, personal!.id, f.agentId, "owner");
    await expect(svc().revokeConnectionGrantDelegation(f.connection.id, personal!.id, randomUUID())).rejects.toThrow("not found");
    await svc().putConnectionInstalls(f.connection.id, { installs: [] });
    await pause(200);
    expect(delivery.sweeps).toBe(baseline);
    expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(false);
  });

  it("leaves a raw grant write without a notification to the worker until something wakes it", async () => {
    const f = await seed(0);
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await db.insert(connectionGrants).values(orgGrant(f));
    await pause(200);
    expect(delivery.sweeps).toBe(baseline);
    expect((await card()).status).toBe("pending");
    delivery.wake();
    await delivery.settle(baseline + 1);
    await expectRetiredOnce(f.connection.id);
  });

  it.each(widening)("publishes the savepoint only when the caller's transaction commits when %s", async (_name, setup, _table, produce) => {
    const f = await setup();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await db.transaction(async (tx) => {
      await produce(f, tx as unknown as Db);
      expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
      await pause(200);
      expect(delivery!.sweeps).toBe(baseline);
    });
    await delivery.settle(baseline + 1);
    await expectRetiredOnce(f.connection.id);
  });

  it.each([...widening, ["putConnectionInstalls drops a legacy include with an unchanged install set", seedLegacyInclude, "tool_profile_entries", putSameInstall] as const])("keeps the card pending with no durable effect when the caller rolls back after %s", async (_name, setup, table, produce) => {
    const f = await setup();
    const before = await count(table);
    delivery = await startConnectionDelivery(db);
    await expect(db.transaction(async (tx) => {
      await produce(f, tx as unknown as Db);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await delivery.settle();
    expect(await db.select().from(connectionGrants)).toEqual(f.grants);
    expect(await count(table)).toBe(before);
    await expectNoDurableEffect();
  });

  it("retires once when the same widening revoke commits twice back to back", async () => {
    const f = await seed(2);
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await Promise.all([0, 1].map(() => svc().revokeConnectionGrant(f.connection.id, f.grants[0]!.id)));
    await delivery.settle(baseline + 1);
    await expectRetiredOnce(f.connection.id);
  });

  it.each([
    ["retires once through the dirty rerun", false],
    ["stays pending after a grant and its revoke", true],
  ] as const)("holds a sweep before its read while writes commit: %s", async (_name, revoke) => {
    const f = await seed(0);
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    const locker = createDb(temp.connectionString);
    try {
      await locker.transaction(async (ltx) => {
        await ltx.execute(sql`lock table issue_thread_interactions in access exclusive mode`);
        delivery!.wake();
        await until(() => delivery!.sweeps > baseline);
        const grant = await svc().addConnectionInstallation(f.connection.id, {});
        if (revoke) await svc().revokeConnectionGrant(f.connection.id, grant.id);
      });
    } finally { await locker.$client.end({ timeout: 1 }); }
    await delivery.settle(baseline + 2);
    if (revoke) await expectNoDurableEffect();
    else await expectRetiredOnce(f.connection.id);
  });

  it("does not retire during admission drain and retires after reopening", async () => {
    const f = await seed(0);
    let open = true;
    delivery = await startConnectionDelivery(db, { canRun: () => open });
    const baseline = delivery.sweeps;
    open = false;
    await svc().addConnectionInstallation(f.connection.id, {});
    await pause(200);
    expect(delivery.sweeps).toBe(baseline);
    expect((await card()).status).toBe("pending");
    open = true;
    delivery.wake();
    await delivery.settle(baseline + 1);
    await expectRetiredOnce(f.connection.id);
  });
});
