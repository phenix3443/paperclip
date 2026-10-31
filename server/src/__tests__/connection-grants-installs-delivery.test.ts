import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, authUsers, companyMemberships, connectionGrantDelegations, connectionGrants, connectionIntentDeliveries, createDb,
  databaseWorkPending, issueThreadInteractions, toolPolicies } from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./helpers/connection-delivery-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describePostgres("connection grant and install writes notify the connection delivery worker", () => {
  let db!: ReturnType<typeof createDb>;
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
  const svc = (client = db) => toolAccessService(client);
  const orgGrant = (f: { companyId: string; connection: { id: string } }) => ({ companyId: f.companyId, connectionId: f.connection.id, kind: "organization" as const, status: "active" as const });
  /** Tools are allowed; the owner's personal identity is removed so only organization identities decide the request. */
  async function seed(organizationGrants: number) {
    const f = await seedPendingAccessRequest(db, "owner");
    await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Allow", policyType: "allow", selectors: {} });
    await db.delete(connectionGrants).where(eq(connectionGrants.connectionId, f.connection.id));
    const grants = organizationGrants ? await db.insert(connectionGrants).values(Array.from({ length: organizationGrants }, () => orgGrant(f))).returning() : [];
    return { ...f, grants };
  }
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

  it.each([
    ["addConnectionInstallation adds the only organization identity", 0, (f: Awaited<ReturnType<typeof seed>>) => svc().addConnectionInstallation(f.connection.id, {})],
    ["revokeConnectionGrant removes an ambiguous organization identity", 2, (f: Awaited<ReturnType<typeof seed>>) => svc().revokeConnectionGrant(f.connection.id, f.grants[0]!.id)],
  ] as const)("retires an exact access request when %s, before any maintenance tick", async (_name, grants, produce) => {
    const f = await seed(grants);
    delivery = await startConnectionDelivery(db);
    expect((await card()).status).toBe("pending");
    const baseline = delivery.sweeps;
    await produce(f);
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

  it("does not notify when a replacement or delegation writes nothing", async () => {
    const f = await seedPendingAccessRequest(db, "owner");
    const [personal] = await db.select().from(connectionGrants);
    await db.insert(connectionGrantDelegations).values({ companyId: f.companyId, grantId: personal!.id, agentId: f.agentId, createdByUserId: "owner" });
    const [organization] = await db.insert(connectionGrants).values(orgGrant(f)).returning();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await svc().replaceConnectionGrantMembers(f.connection.id, organization!.id, []);
    await svc().createConnectionGrantDelegation(f.connection.id, personal!.id, f.agentId, "owner");
    await pause(200);
    expect(delivery.sweeps).toBe(baseline);
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

  it("publishes a savepoint write only when the caller's transaction commits", async () => {
    const f = await seed(0);
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await db.transaction(async (tx) => {
      await svc(tx as unknown as typeof db).addConnectionInstallation(f.connection.id, {});
      expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
      await pause(200);
      expect(delivery!.sweeps).toBe(baseline);
    });
    await delivery.settle(baseline + 1);
    await expectRetiredOnce(f.connection.id);
  });

  it.each([
    ["addConnectionInstallation", 0, (client: typeof db, f: Awaited<ReturnType<typeof seed>>) => svc(client).addConnectionInstallation(f.connection.id, {})],
    ["revokeConnectionGrant", 2, (client: typeof db, f: Awaited<ReturnType<typeof seed>>) => svc(client).revokeConnectionGrant(f.connection.id, f.grants[0]!.id)],
  ] as const)("keeps the card pending with no durable effect when %s rolls back", async (_name, grants, produce) => {
    const f = await seed(grants);
    delivery = await startConnectionDelivery(db);
    const before = await db.select().from(connectionGrants);
    await expect(db.transaction(async (tx) => {
      await produce(tx as unknown as typeof db, f);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await delivery.settle();
    expect(await db.select().from(connectionGrants)).toEqual(before);
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
        while (delivery!.sweeps === baseline) await pause(10);
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
