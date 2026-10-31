import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, authUsers, companyMemberships, connectionGrants, connectionIntentDeliveries,
  createDb, databaseWorkPending, issueThreadInteractions, toolPolicies } from "@paperclipai/db";
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

  const card = async () => (await db.select().from(issueThreadInteractions))[0]!;
  async function fixture() {
    const f = await seedPendingAccessRequest(db, "owner");
    await db.update(connectionGrants).set({ kind: "organization", subjectUserId: null });
    await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Allow", policyType: "allow", selectors: {} });
    const [member] = await db.update(companyMemberships).set({ membershipRole: "viewer" }).returning();
    return { ...f, member: member! };
  }
  async function retired(connectionId: string) {
    expect(await card()).toMatchObject({ status: "expired", result: expect.objectContaining({ connectionId: connectionId }) });
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
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
});
