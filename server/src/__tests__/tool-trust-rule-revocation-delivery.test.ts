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

});
