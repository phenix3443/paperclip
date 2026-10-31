import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, authUsers, companies, companyMemberships, connectionGrants, connectionIntentDeliveries,
  createDb, databaseWorkPending, issueThreadInteractions, principalPermissionGrants } from "@paperclipai/db";
import { accessService } from "../services/access.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./helpers/connection-delivery-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("membership writes notify connection delivery", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let delivery: Awaited<ReturnType<typeof startConnectionDelivery>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-member-delivery-");
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: "owner", name: "Owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);
  beforeEach(async () => { await db.execute(sql`truncate table companies cascade`); });
  afterEach(async () => { await delivery?.stop(); delivery = null; });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const card = async () => (await db.select().from(issueThreadInteractions))[0]!;
  async function fixture() {
    const f = await seedPendingAccessRequest(db, "owner");
    await db.update(connectionGrants).set({ kind: "organization", subjectUserId: null });
    await db.insert(principalPermissionGrants).values({ companyId: f.companyId, principalType: "agent", principalId: f.agentId, permissionKey: "tools:use" });
    const [member] = await db.update(companyMemberships).set({ membershipRole: "viewer" }).returning();
    return { ...f, member: member! };
  }
  async function pending() {
    expect((await card()).status).toBe("pending");
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_resolved"))).toHaveLength(0);
    expect(delivery!.wakeup).not.toHaveBeenCalled();
  }
  async function retired(connectionId: string) {
    expect(await card()).toMatchObject({ status: "expired", result: expect.objectContaining({ connectionId }) });
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_resolved"))).toHaveLength(1);
    expect(delivery!.wakeup).toHaveBeenCalledOnce();
  }
  it("retires after ensureMembership without a later grant call", async () => {
    const f = await fixture();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await accessService(db).ensureMembership(f.companyId, "user", "owner", "operator", "active");
    await delivery.settle(baseline + 1);
    await retired(f.connection.id);
  });

  it.each([
    ["updateMember", (f: Fixture) => accessService(db).updateMember(f.companyId, f.member.id, { membershipRole: "operator" })],
    ["updateMemberAndPermissions", (f: Fixture) => accessService(db).updateMemberAndPermissions(f.companyId, f.member.id, { membershipRole: "operator", grants: [] }, "owner")],
    ["setUserCompanyAccess", (f: Fixture) => accessService(db).setUserCompanyAccess("owner", [f.companyId])],
    ["copyActiveUserMemberships", async (f: Fixture) => {
      const [source] = await db.insert(companies).values({ name: "Source", issuePrefix: "SRC" }).returning();
      await db.insert(companyMemberships).values({ companyId: source!.id, principalType: "user", principalId: "owner", status: "active", membershipRole: "operator" });
      return accessService(db).copyActiveUserMemberships(source!.id, f.companyId);
    }],
  ] as const)("retires through %s's own membership transaction", async (name, produce) => {
    const f = await fixture();
    if (name === "setUserCompanyAccess") await db.update(companyMemberships).set({ status: "suspended", membershipRole: "operator" });
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await produce(f);
    await delivery.settle(baseline + 1);
    await retired(f.connection.id);
  });

  it.each(["suspended", "missing"] as const)("restores a %s membership without a later grant write", async mode => {
    const f = await fixture();
    if (mode === "missing") await db.delete(companyMemberships);
    else await db.update(companyMemberships).set({ status: "suspended", membershipRole: "operator" });
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await accessService(db).ensureMembership(f.companyId, "user", "owner", "operator", "active");
    await delivery.settle(baseline + 1);
    await retired(f.connection.id);
  });

  it("inserts company access in its own notifying transaction", async () => {
    const f = await fixture();
    await db.delete(companyMemberships);
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await accessService(db).setUserCompanyAccess("owner", [f.companyId]);
    await delivery.settle(baseline + 1);
    await retired(f.connection.id);
  });

  it("leaves a raw restoration pending until an explicit wake", async () => {
    const f = await fixture();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await db.update(companyMemberships).set({ membershipRole: "operator" });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(delivery.sweeps).toBe(baseline);
    await pending();
    delivery.wake();
    await delivery.settle(baseline + 1);
    await retired(f.connection.id);
  });

  it.each([false, true])("unchanged membership does not notify (company access=%s)", async companyAccess => {
    const f = await fixture();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    if (companyAccess) await accessService(db).setUserCompanyAccess("owner", [f.companyId]);
    else await accessService(db).ensureMembership(f.companyId, "user", "owner", "viewer", "active");
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(delivery.sweeps).toBe(baseline);
    await pending();
  });

  it.each([[false, false], [true, false], [false, true], [true, true]])("savepoint waits for outer commit (rollback=%s, insert=%s)", async (rollback, insert) => {
    const f = await fixture();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    if (insert) await db.delete(companyMemberships);
    const operation = db.transaction(async tx => {
      await accessService(tx as unknown as typeof db).ensureMembership(f.companyId, "user", "owner", "operator", "active");
      expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(delivery!.sweeps).toBe(baseline);
      await pending();
      if (rollback) throw new Error("rollback");
    });
    if (rollback) await expect(operation).rejects.toThrow("rollback");
    else await operation;
    await delivery.settle(baseline + 1);
    if (!rollback) return retired(f.connection.id);
    await pending();
    const members = await db.select().from(companyMemberships);
    if (insert) expect(members).toHaveLength(0);
    else expect(members[0]!.membershipRole).toBe("viewer");
  });

  it.each(["archive", "remove", "combined", "suspend"])("notifies on narrowing %s without retiring", async method => {
    const f = await fixture();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    const access = accessService(db);
    if (method === "archive") await access.archiveMember(f.companyId, f.member.id);
    if (method === "remove") await access.setUserCompanyAccess("owner", []);
    if (method === "combined") await access.updateMemberAndPermissions(f.companyId, f.member.id, { status: "suspended", grants: [] }, null);
    if (method === "suspend") await access.updateMember(f.companyId, f.member.id, { status: "suspended" });
    await delivery.settle(baseline + 1);
    await pending();
  });

  it("coalesces duplicate producer commits into one delivery", async () => {
    const f = await fixture();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await accessService(db).ensureMembership(f.companyId, "user", "owner", "operator");
    await accessService(db).updateMember(f.companyId, f.member.id, { membershipRole: "operator" });
    await delivery.settle(baseline + 1);
    await retired(f.connection.id);
  });

  it.each([false, true])("retains a write during a sweep (then revoke=%s)", async revoke => {
    const f = await fixture();
    let beforeRead: (() => Promise<void>) | undefined;
    delivery = await startConnectionDelivery(db, { beforeRead: () => beforeRead?.() });
    const baseline = delivery.sweeps;
    let entered!: () => void, release!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    beforeRead = () => { beforeRead = undefined; entered(); return blocked; };
    delivery.wake();
    try {
      await reading;
      await accessService(db).ensureMembership(f.companyId, "user", "owner", "operator");
      if (revoke) await accessService(db).updateMember(f.companyId, f.member.id, { membershipRole: "viewer" });
    } finally { release(); }
    await delivery.settle(baseline + 2);
    if (revoke) await pending();
    else await retired(f.connection.id);
  });

  it("retains a producer commit through drain", async () => {
    const f = await fixture();
    let canRun = true;
    delivery = await startConnectionDelivery(db, { canRun: () => canRun });
    const baseline = delivery.sweeps;
    canRun = false;
    await accessService(db).ensureMembership(f.companyId, "user", "owner", "operator");
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(delivery.sweeps).toBe(baseline);
    await pending();
    canRun = true;
    delivery.wake();
    await delivery.settle(baseline + 1);
    await retired(f.connection.id);
  });
  it.each(["update", "combined", "company", "archive"])("rolls back %s without durable delivery", async method => {
    const f = await fixture();
    if (method === "company") await db.update(companyMemberships).set({ status: "suspended" });
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await expect(db.transaction(async tx => {
      const access = accessService(tx as unknown as typeof db);
      if (method === "update") await access.updateMember(f.companyId, f.member.id, { membershipRole: "operator" });
      if (method === "combined") await access.updateMemberAndPermissions(f.companyId, f.member.id, { membershipRole: "operator", grants: [] }, null);
      if (method === "company") await access.setUserCompanyAccess("owner", [f.companyId]);
      if (method === "archive") await access.archiveMember(f.companyId, f.member.id);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    await delivery.settle(baseline + 1);
    await pending();
    expect((await db.select().from(companyMemberships))[0]!.membershipRole).toBe("viewer");
  });

  it.each([false, true])("combined agent grant replacement owns its notification (rollback=%s)", async rollback => {
    const f = await fixture();
    await db.update(companyMemberships).set({ membershipRole: "operator" });
    const [member] = await db.insert(companyMemberships).values({
      companyId: f.companyId, principalType: "agent", principalId: f.agentId, status: "active", membershipRole: "member",
    }).returning();
    await db.delete(principalPermissionGrants);
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    const operation = db.transaction(async tx => {
      await accessService(tx as unknown as typeof db).updateMemberAndPermissions(f.companyId, member!.id, {
        grants: [{ permissionKey: "tools:use" }],
      }, null);
      if (rollback) throw new Error("rollback");
    });
    if (rollback) await expect(operation).rejects.toThrow("rollback");
    else await operation;
    await delivery.settle(baseline + 1);
    if (!rollback) return retired(f.connection.id);
    await pending();
    expect(await db.select().from(principalPermissionGrants)).toHaveLength(0);
  });
});
