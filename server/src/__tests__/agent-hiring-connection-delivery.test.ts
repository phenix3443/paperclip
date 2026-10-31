import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { agents, authUsers, connectionIntentDeliveries, createDb, issueThreadInteractions,
  principalPermissionGrants, toolPolicies, type Db } from "@paperclipai/db";
import { completeAgentHireApproval } from "../services/agent-hiring.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./helpers/connection-delivery-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("hire approval notifies connection delivery", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let delivery: Awaited<ReturnType<typeof startConnectionDelivery>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-hire-connection-delivery-");
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: "owner", name: "Owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);
  beforeEach(async () => { await db.execute(sql`truncate table companies cascade`); });
  afterEach(async () => { await delivery?.stop(); delivery = null; });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  async function arrange() {
    const fixture = await seedPendingAccessRequest(db, "owner");
    await db.insert(toolPolicies).values({ companyId: fixture.companyId, name: "Allow", policyType: "allow", selectors: {} });
    const [agent] = await db.select().from(agents).where(eq(agents.id, fixture.agentId));
    return { ...fixture, agent: agent! };
  }
  const card = async () => (await db.select().from(issueThreadInteractions))[0]!;

  it("retires an exact request through its own grant transaction", async () => {
    const f = await arrange();
    delivery = await startConnectionDelivery(db);
    expect((await card()).status).toBe("pending");
    const baseline = delivery.sweeps;
    await db.transaction(tx => completeAgentHireApproval(tx as unknown as Db, f.agent, f.agent));
    await delivery.settle(baseline + 1);
    expect(await card()).toMatchObject({ status: "expired", result: expect.objectContaining({ connectionId: f.connection.id }) });
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
    expect(delivery.wakeup).toHaveBeenCalledOnce();
    expect(await db.select().from(principalPermissionGrants).where(eq(principalPermissionGrants.permissionKey, "tools:use"))).toHaveLength(1);
  });
});
