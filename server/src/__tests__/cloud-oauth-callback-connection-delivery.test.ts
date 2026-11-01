import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, connectionGrants, createDb, databaseWorkPending, issueThreadInteractions, toolOauthStates, toolPolicies, toolProfiles, type Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../services/delivery-work-notifications.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { arrangeOAuthCallback, OAUTH_CALLBACK_MODES, type OAuthCallbackMode } from "./helpers/oauth-callback-delivery-fixture.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
type Mode = Extract<OAuthCallbackMode, `cloud ${string}`>;
const MODES = OAUTH_CALLBACK_MODES.filter((mode): mode is Mode => mode.startsWith("cloud "));
const REAUTHORIZATION = "cloud reauthorization" as const;

describePostgres("cloud OAuth callback transaction notifies the connection delivery worker", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let fixture: Awaited<ReturnType<typeof arrangeOAuthCallback>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-cloud-oauth-connection-delivery-");
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
  const userGrant = (f: NonNullable<typeof fixture>) => and(eq(connectionGrants.connectionId, f.connection.id), eq(connectionGrants.kind, "user"));

  it("reauthorization retires the exact access request through its own transaction before any maintenance tick", async () => {
    const { f, delivery, baseline } = await arrange(REAUTHORIZATION);
    await expectEffects(f, delivery, false);
    await f.callback();
    await delivery.settle(baseline + 1);
    await expectEffects(f, delivery, true);
    expect(f.later.refreshCatalog).toHaveBeenCalledOnce();
    expect(f.later.finishCatalog).not.toHaveBeenCalled();
  });

  it("draft callback notifies but keeps the card pending while later catalog finalization stays isolated", async () => {
    const { f, delivery, baseline } = await arrange("cloud draft");
    await f.callback();
    await delivery.settle(baseline + 1);
    await expectEffects(f, delivery, false);
    expect((await f.read()).connection).toMatchObject({ status: "draft", enabled: false });
    expect(f.later.finishCatalog).toHaveBeenCalledOnce();
  });

  it("an equivalent raw reauthorization write leaves the idle worker asleep until an explicit wake", async () => {
    const { f, delivery, baseline } = await arrange(REAUTHORIZATION);
    await db.update(connectionGrants).set({ status: "active", revokedAt: null }).where(userGrant(f));
    await db.delete(toolOauthStates).where(eq(toolOauthStates.connectionId, f.connection.id));
    await pause();
    expect(delivery.sweeps).toBe(baseline);
    await expectEffects(f, delivery, false);
    delivery.wake();
    await delivery.settle(baseline + 1);
    await expectEffects(f, delivery, true);
  });

  it.each(MODES)("%s callback notifies before its state deletion even when that deletion fails", async mode => {
    const { f, delivery, baseline } = await arrange(mode);
    const before = await f.read();
    await db.transaction(async tx => {
      await tx.execute(sql`create function reject_state_delete() returns trigger language plpgsql as $$ begin raise exception 'state delete rejected'; end $$`);
      await tx.execute(sql`create trigger reject_state_delete before delete on tool_oauth_states for each row execute function reject_state_delete()`);
      expect(pending()).toBe(false);
      await expect(f.callback({ client: tx as unknown as Db })).rejects.toThrow();
      expect(pending()).toBe(true);
      expect(await tx.select().from(connectionGrants).where(eq(connectionGrants.connectionId, f.connection.id))).toEqual(before.grants);
      expect(await tx.select().from(toolOauthStates).where(eq(toolOauthStates.connectionId, f.connection.id))).toHaveLength(1);
      await tx.execute(sql`drop trigger reject_state_delete on tool_oauth_states`);
      await tx.execute(sql`drop function reject_state_delete()`);
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
    await expectEffects(f, delivery, mode === REAUTHORIZATION);
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
    expect(after.states).toHaveLength(1);
    expect(after.connection.status).toBe(before.connection.status);
    await expectEffects(f, delivery, false);
    expect(f.later.refreshCatalog).not.toHaveBeenCalled();
  });

  it.each(["narrowed policy", "weaker permission", "changed tool", "inactive dedicated identity"] as const)(
    "reauthorization with %s notifies without retiring the card", async gap => {
      fixture = await arrangeOAuthCallback(db, REAUTHORIZATION);
      const f = fixture;
      if (gap === "narrowed policy") await db.update(toolProfiles).set({ defaultAction: "deny" }).where(eq(toolProfiles.companyId, f.companyId));
      if (gap === "weaker permission") await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Ask first", policyType: "require_approval", selectors: { issueId: f.issueId } });
      if (gap === "changed tool") await db.update(issueThreadInteractions).set({ payload: { ...f.intent.payload, accessRequest: { connectionId: f.connection.id,
        tools: [{ catalogEntryId: f.tool.id, toolName: "different-tool", versionHash: "v1", permission: "allowed" }] } } }).where(eq(issueThreadInteractions.id, f.intent.id));
      if (gap === "inactive dedicated identity") await db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: f.connection.id, kind: "agent",
        subjectAgentId: f.agentId, status: "revoked", revokedAt: new Date() });
      const delivery = await f.startDelivery();
      const baseline = delivery.sweeps;
      await f.callback();
      await delivery.settle(baseline + 1);
      await expectEffects(f, delivery, false);
    });

  it("reauthorization followed by a duplicate notification retires the card once", async () => {
    const { f, delivery, baseline } = await arrange(REAUTHORIZATION);
    await f.callback();
    await delivery.settle(baseline + 1);
    await expectEffects(f, delivery, true);
    await db.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.connection));
    await delivery.settle(baseline + 2);
    await expectEffects(f, delivery, true);
  });

  it("reauthorization committing after a running sweep read retires on the follow-up sweep", async () => {
    let commit: (() => Promise<unknown>) | null = null;
    const { f, delivery, baseline } = await arrange(REAUTHORIZATION, { afterSweep: async () => { const run = commit; commit = null; await run?.(); } });
    commit = () => f.callback();
    delivery.wake();
    await delivery.settle(baseline + 2);
    await expectEffects(f, delivery, true);
  });

  it("grant revoked after reauthorization commits and before the event sweep leaves the card pending", async () => {
    let revoke: (() => Promise<void>) | null = null;
    const { f, delivery, baseline } = await arrange(REAUTHORIZATION, { beforeSweep: async () => { await revoke?.(); revoke = null; } });
    revoke = async () => { await db.update(connectionGrants).set({ status: "revoked", revokedAt: new Date() }).where(userGrant(f)); };
    await f.callback();
    await delivery.settle(baseline + 1);
    await expectEffects(f, delivery, false);
    expect((await f.read()).grants.filter(grant => grant.status === "active")).toHaveLength(0);
  });

  it("reauthorization during a drain does not retire until the worker resumes", async () => {
    let open = true, drainedChecks = 0;
    const { f, delivery, baseline } = await arrange(REAUTHORIZATION, { canRun: () => { if (!open) drainedChecks += 1; return open; } });
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
    expect((await f.read()).connection).toMatchObject({ status: "active", enabled: true });
  });
});
