import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { activityLog, connectionGrants, createDb, databaseWorkPending, issueThreadInteractions, toolApplications, toolConnections, toolProfiles, type Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../services/delivery-work-notifications.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { arrangeOAuthCallback, OAUTH_CALLBACK_MODES, type OAuthCallbackMode } from "./helpers/oauth-callback-delivery-fixture.js";

const isolated = vi.hoisted(() => ({ grantNotifications: 0 }));
vi.mock("../services/delivery-work-notifications.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/delivery-work-notifications.js")>();
  return { ...actual, notifyDeliveryWork: async (...args: Parameters<typeof actual.notifyDeliveryWork>) => {
    if (new Error().stack?.includes("organization-grant")) { isolated.grantNotifications += 1; return; }
    return actual.notifyDeliveryWork(...args);
  } };
});

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
type Mode = Extract<OAuthCallbackMode, `direct ${string}`>;
const MODES = OAUTH_CALLBACK_MODES.filter((mode): mode is Mode => mode.startsWith("direct "));

describePostgres("direct OAuth callback transactions notify the connection delivery worker", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let fixture: Awaited<ReturnType<typeof arrangeOAuthCallback>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-direct-oauth-connection-delivery-");
    db = createDb(temp.connectionString);
  }, 20_000);
  afterEach(async () => { await fixture?.cleanup(); fixture = null; isolated.grantNotifications = 0; });
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
    expect(isolated.grantNotifications).toBe(mode === "direct organization" ? 1 : 0);
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

  it.each(MODES)("%s callback followed by a duplicate notification retires the card once", async mode => {
    const { f, delivery, baseline } = await arrange(mode);
    await f.callback();
    await delivery.settle(baseline + 1);
    await expectEffects(f, delivery, true);
    await db.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.connection));
    await delivery.settle(baseline + 2);
    await expectEffects(f, delivery, true);
  });

  it.each(MODES)("%s callback committing after a running sweep read retires on the follow-up sweep", async mode => {
    let commit: (() => Promise<unknown>) | null = null;
    const { f, delivery, baseline } = await arrange(mode, { afterSweep: async () => { const run = commit; commit = null; await run?.(); } });
    commit = () => f.callback();
    delivery.wake();
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
    let open = true, drainedChecks = 0;
    const { f, delivery, baseline } = await arrange(mode, { canRun: () => { if (!open) drainedChecks += 1; return open; } });
    open = false;
    await f.callback();
    await pause();
    expect(delivery.sweeps).toBe(baseline);
    expect(drainedChecks).toBeGreaterThan(0);
    await expectEffects(f, delivery, false);
    open = true;
    delivery.wake();
    await delivery.settle(baseline + 1);
    await expectEffects(f, delivery, true);
  });
});
