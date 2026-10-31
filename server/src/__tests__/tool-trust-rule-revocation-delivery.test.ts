import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { activityLog, authUsers, connectionIntentDeliveries, createDb, issueThreadInteractions,
  connectionGrants, toolConnections, toolConnectionInstalls, toolAccessAuditEvents, toolCallEvents, toolPolicies } from "@paperclipai/db";
import { toolAccessPolicyService } from "../services/tool-access-policy.js";
import { connectionIntentService } from "../services/connection-intents.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./helpers/connection-delivery-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("trust rule revocation notifies connection delivery", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let delivery: Awaited<ReturnType<typeof startConnectionDelivery>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-revoke-connection-delivery-");
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: "owner", name: "Owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);
  beforeEach(async () => { await db.execute(sql`truncate table companies cascade`); });
  afterEach(async () => {
    await delivery?.stop();
    delivery = null;
    vi.restoreAllMocks();
  });
  afterAll(async () => { await db.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  const card = async () => (await db.select().from(issueThreadInteractions))[0]!;
  const revoke = (companyId: string, policyId: string) => toolAccessPolicyService(db)
    .revokeTrustRule({ companyId, policyId, body: { reason: "Scope changed" } });
  async function seedRule(widening: boolean, enabled = true) {
    const f = await seedPendingAccessRequest(db, "owner");
    const [rule] = await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Remembered access",
      policyType: "trust_rule", priority: 40, enabled, selectors: { agentIds: [f.agentId], catalogEntryIds: [f.tool.id] },
      config: { trustRule: { catalogVersionHash: widening ? "old" : "v1", argumentFilters: { allowAny: true } } } }).returning();
    if (widening) {
      await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Fallback allow",
        policyType: "allow", priority: 100, selectors: {} });
    }
    return { ...f, rule: rule! };
  }
  async function expectPending() {
    expect((await card()).status).toBe("pending");
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_resolved"))).toHaveLength(0);
    expect(delivery!.wakeup).not.toHaveBeenCalled();
  }
  async function expectRetired(connectionId: string) {
    expect(await card()).toMatchObject({ status: "expired", result: expect.objectContaining({ connectionId }) });
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
    expect(delivery!.wakeup).toHaveBeenCalledOnce();
  }

  it("retires an exact request when revocation exposes a lower-priority allow", async () => {
    const f = await seedRule(true);
    delivery = await startConnectionDelivery(db);
    await expectPending();
    const listing = await connectionIntentService(db).gatewayAccessForAgent({ companyId: f.companyId,
      agentId: f.agentId, responsibleUserId: "owner", serviceSlug: "sentry", connectionId: f.connection.id,
      heartbeatRunId: null, issueId: f.issueId, projectId: null });
    expect(listing?.tools[0]).toMatchObject({ decision: "ask_first", reasonCode: "requires_review_changed_tool" });
    const baseline = delivery.sweeps;
    await revoke(f.companyId, f.rule.id);
    await delivery.settle(baseline + 1);
    await expectRetired(f.connection.id);
    expect((await db.select().from(toolPolicies).where(eq(toolPolicies.id, f.rule.id)))[0]!.enabled).toBe(false);
    expect(await db.select().from(toolAccessAuditEvents)).toHaveLength(1);
    expect(await db.select().from(toolCallEvents)).toHaveLength(1);
  });

  it.each([false, true])("leaves a raw revocation quiet (widening=%s)", async (widening) => {
    const f = await seedRule(widening, widening);
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    if (!widening) await db.update(toolPolicies).set({ enabled: true }).where(eq(toolPolicies.id, f.rule.id));
    await db.update(toolPolicies).set({ enabled: false,
      config: { trustRule: { revokedAt: new Date().toISOString() } } }).where(eq(toolPolicies.id, f.rule.id));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(delivery.sweeps).toBe(baseline);
    await expectPending();
    delivery.wake();
    await delivery.settle(baseline + 1);
    if (widening) await expectRetired(f.connection.id);
    else await expectPending();
  });

  it.each(["exact", "weaker", "ambiguous"])("does not retire a %s request on narrowing", async (shape) => {
    const f = await seedRule(false, false);
    if (shape === "weaker") {
      const payload = { ...f.intent.payload, accessRequest: { ...f.intent.payload.accessRequest,
        tools: [{ catalogEntryId: f.tool.id, toolName: f.tool.toolName, versionHash: "v1", permission: "ask_first" }] } };
      await db.update(issueThreadInteractions).set({ payload }).where(eq(issueThreadInteractions.id, f.intent.id));
    }
    if (shape === "ambiguous") {
      const id = randomUUID();
      await db.insert(toolConnections).values({ ...f.connection, id, name: "Other Sentry", uid: "other-sentry" });
      await db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: id, kind: "user", subjectUserId: "owner", status: "active" });
      await db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: id, targetType: "agent", targetId: f.agentId });
    }
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await db.update(toolPolicies).set({ enabled: true }).where(eq(toolPolicies.id, f.rule.id));
    await revoke(f.companyId, f.rule.id);
    await delivery.settle(baseline + 1);
    await expectPending();
  });

  it.each(["tool_access_audit_events", "tool_call_events"])("rolls back when %s rejects the audit", async (table) => {
    const f = await seedRule(true);
    await db.execute(sql.raw(`CREATE FUNCTION reject_revoke_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit rejected'; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER reject_revoke BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_revoke_audit()`));
    try {
      delivery = await startConnectionDelivery(db);
      const baseline = delivery.sweeps;
      await expect(revoke(f.companyId, f.rule.id)).rejects.toMatchObject({ cause: expect.objectContaining({ message: "audit rejected" }) });
      await delivery.settle(baseline + 1);
      await expectPending();
      expect((await db.select().from(toolPolicies).where(eq(toolPolicies.id, f.rule.id)))[0]).toEqual(f.rule);
      expect(await db.select().from(toolAccessAuditEvents)).toHaveLength(0);
      expect(await db.select().from(toolCallEvents)).toHaveLength(0);
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER reject_revoke ON ${table}`));
      await db.execute(sql`DROP FUNCTION reject_revoke_audit()`);
    }
  });

  it.each([false, true])("preserves changes while a sweep holds its read barrier (widening=%s)", async (widening) => {
    const f = await seedRule(widening, widening);
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const select = db.select.bind(db);
    let held = false;
    const read = vi.spyOn(db, "select").mockImplementation((...args) => {
      const query = select(...args);
      const from = query.from.bind(query);
      query.from = ((table: Parameters<typeof from>[0]) => {
        const builder = from(table);
        if (!held && table === issueThreadInteractions) {
          held = true;
          const then = builder.then.bind(builder);
          builder.then = ((resolve, reject) => {
            entered();
            return barrier.then(() => then(resolve, reject));
          }) as typeof builder.then;
        }
        return builder;
      }) as typeof query.from;
      return query;
    });
    try {
      delivery.wake();
      await started;
      if (!widening) {
        await db.update(toolPolicies).set({ enabled: true }).where(eq(toolPolicies.id, f.rule.id));
      }
      await revoke(f.companyId, f.rule.id);
      release();
      await delivery.settle(baseline + 2);
      if (widening) await expectRetired(f.connection.id);
      else await expectPending();
    } finally {
      release();
      read.mockRestore();
    }
  });
});
