import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, connectionGrants, createDb, databaseWorkPending, issueThreadInteractions, toolApplications, toolConnections, toolProfiles, type Db } from "@paperclipai/db";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { arrangeOAuthCallback } from "./helpers/oauth-callback-delivery-fixture.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const MODES = ["direct user", "direct organization"] as const;
type Mode = (typeof MODES)[number];

describePostgres("direct OAuth callback transactions notify the connection delivery worker", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let fixture: Awaited<ReturnType<typeof arrangeOAuthCallback>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-direct-oauth-connection-delivery-");
    db = createDb(temp.connectionString);
  }, 20_000);
  afterEach(async () => { await fixture?.cleanup(); fixture = null; });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  const pause = () => new Promise(resolve => setTimeout(resolve, 200));
  const pending = () => databaseWorkPending(db, DELIVERY_QUEUES.connection);
  async function arrange(mode: Mode, options?: Parameters<NonNullable<typeof fixture>["startDelivery"]>[0]) {
    fixture = await arrangeOAuthCallback(db, mode);
    const delivery = await fixture.startDelivery(options);
    return { f: fixture, delivery, baseline: delivery.sweeps };
  }
  async function expectEffects(f: NonNullable<typeof fixture>, delivery: Awaited<ReturnType<NonNullable<typeof fixture>["startDelivery"]>>, retired: boolean) {
    const { card, deliveries } = await f.read();
    if (retired) expect(card).toMatchObject({ status: "expired", result: expect.objectContaining({ connectionId: f.connection.id }) });
    else expect(card.status).toBe("pending");
    expect(deliveries).toHaveLength(retired ? 1 : 0);
    expect(delivery.wakeup).toHaveBeenCalledTimes(retired ? 1 : 0);
    if (!retired) expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_resolved"))).toHaveLength(0);
  }
  const grantFor = (f: NonNullable<typeof fixture>, mode: Mode) => and(eq(connectionGrants.connectionId, f.connection.id),
    eq(connectionGrants.kind, mode === "direct user" ? "user" : "organization"));

  it.each(MODES)("%s callback retires the exact access request through its own transaction before any maintenance tick", async mode => {
    const { f, delivery, baseline } = await arrange(mode);
    await expectEffects(f, delivery, false);
    await f.callback();
    await delivery.settle(baseline + 1);
    await expectEffects(f, delivery, true);
    expect(f.later.refreshCatalog).toHaveBeenCalledOnce();
  });

  it.each(MODES)("an equivalent raw %s write leaves the idle worker asleep until an explicit wake", async mode => {
    const { f, delivery, baseline } = await arrange(mode);
    await db.update(toolConnections).set({ status: "active", enabled: true }).where(eq(toolConnections.id, f.connection.id));
    await db.update(toolApplications).set({ status: "active" }).where(eq(toolApplications.id, f.connection.applicationId));
    if (mode === "direct user") await db.update(connectionGrants).set({ status: "active", revokedAt: null }).where(grantFor(f, mode));
    else await db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: f.connection.id, kind: "organization", isDefault: true, status: "active" });
    await pause();
    expect(delivery.sweeps).toBe(baseline);
    await expectEffects(f, delivery, false);
    delivery.wake();
    await delivery.settle(baseline + 1);
    await expectEffects(f, delivery, true);
  });

  it.each(MODES)("%s callback notifies before its first write even when that write fails", async mode => {
    const { f, delivery, baseline } = await arrange(mode);
    const before = await f.read();
    await db.transaction(async tx => {
      await tx.execute(sql`create function reject_secret_insert() returns trigger language plpgsql as $$ begin raise exception 'secret rejected'; end $$`);
      await tx.execute(sql`create trigger reject_secret_insert before insert on company_secrets for each row execute function reject_secret_insert()`);
      expect(pending()).toBe(false);
      await expect(f.callback({ client: tx as unknown as Db })).rejects.toThrow();
      expect(pending()).toBe(true);
      expect(await tx.select().from(connectionGrants).where(eq(connectionGrants.connectionId, f.connection.id))).toEqual(before.grants);
      await tx.execute(sql`drop trigger reject_secret_insert on company_secrets`);
      await tx.execute(sql`drop function reject_secret_insert()`);
    });
    await delivery.settle(baseline + 1);
    await expectEffects(f, delivery, false);
  });

  it.each(MODES)("%s callback publishes only when the caller-owned transaction commits", async mode => {
    const { f, delivery, baseline } = await arrange(mode);
    await db.transaction(async tx => {
      await f.callback({ client: tx as unknown as Db });
      expect(pending()).toBe(true);
      await pause();
      expect(delivery.sweeps).toBe(baseline);
      await expectEffects(f, delivery, false);
    });
    await delivery.settle(baseline + 1);
    await expectEffects(f, delivery, true);
  });

  it.each(MODES)("%s callback that fails after its notification and writes keeps the card pending", async mode => {
    const { f, delivery, baseline } = await arrange(mode);
    const before = await f.read();
    await expect(f.callback({ beforeCommit: async () => {
      expect(pending()).toBe(true);
      throw new Error("fail after mutation");
    } })).rejects.toThrow("fail after mutation");
    await delivery.settle(baseline);
    const after = await f.read();
    expect(after.grants).toEqual(before.grants);
    expect(after.connection.status).toBe(before.connection.status);
    await expectEffects(f, delivery, false);
    expect(f.later.refreshCatalog).not.toHaveBeenCalled();
  });

  it.each([
    ...MODES.flatMap(mode => ["narrowed policy", "changed tool"].map(gap => [mode, gap] as const)),
    ["direct organization", "ambiguous identity"] as const,
  ])("%s callback with %s notifies without retiring the card", async (mode, gap) => {
    fixture = await arrangeOAuthCallback(db, mode);
    const f = fixture;
    if (gap === "narrowed policy") await db.update(toolProfiles).set({ defaultAction: "deny" }).where(eq(toolProfiles.companyId, f.companyId));
    if (gap === "changed tool") await db.update(issueThreadInteractions).set({ payload: { ...f.intent.payload, accessRequest: { connectionId: f.connection.id,
      tools: [{ catalogEntryId: f.tool.id, toolName: "different-tool", versionHash: "v1", permission: "allowed" }] } } }).where(eq(issueThreadInteractions.id, f.intent.id));
    if (gap === "ambiguous identity") await db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: f.connection.id, kind: "organization", status: "active" });
    const delivery = await f.startDelivery();
    const baseline = delivery.sweeps;
    await f.callback();
    await delivery.settle(baseline + 1);
    await expectEffects(f, delivery, false);
  });

  it.each(MODES)("%s callback followed by a duplicate wake retires the card once", async mode => {
    const { f, delivery, baseline } = await arrange(mode);
    await f.callback();
    delivery.wake();
    await delivery.settle(baseline + 1);
    delivery.wake();
    await delivery.settle(delivery.sweeps + 1);
    await expectEffects(f, delivery, true);
  });

  it.each(MODES)("%s callback committing while a sweep is held before its read retires once", async mode => {
    const { f, delivery, baseline } = await arrange(mode);
    const locker = createDb(temp.connectionString);
    try {
      await locker.transaction(async lock => {
        await lock.execute(sql`lock table issue_thread_interactions in access exclusive mode`);
        delivery.wake();
        while (delivery.sweeps === baseline) await new Promise(resolve => setTimeout(resolve, 10));
        await f.callback();
      });
    } finally { await locker.$client.end({ timeout: 1 }); }
    await delivery.settle(baseline + 2);
    await expectEffects(f, delivery, true);
  });

  it.each(MODES)("%s grant revoked after the callback commits and before the event sweep leaves the card pending", async mode => {
    let revoke: (() => Promise<void>) | null = null;
    const { f, delivery, baseline } = await arrange(mode, { beforeSweep: async () => { await revoke?.(); revoke = null; } });
    revoke = async () => { await db.update(connectionGrants).set({ status: "revoked", revokedAt: new Date() }).where(grantFor(f, mode)); };
    await f.callback();
    await delivery.settle(baseline + 1);
    await expectEffects(f, delivery, false);
    expect((await f.read()).grants.filter(grant => grant.status === "active")).toHaveLength(0);
  });

  it.each(MODES)("%s callback during a drain does not retire until the worker resumes", async mode => {
    let open = true;
    const { f, delivery, baseline } = await arrange(mode, { canRun: () => open });
    open = false;
    await f.callback();
    await pause();
    expect(delivery.sweeps).toBe(baseline);
    await expectEffects(f, delivery, false);
    open = true;
    delivery.wake();
    await delivery.settle(baseline + 1);
    await expectEffects(f, delivery, true);
  });
});
