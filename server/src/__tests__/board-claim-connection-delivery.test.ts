import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, authUsers, companyMemberships, connectionIntentDeliveries, createDb,
  instanceUserRoles, issueThreadInteractions, toolPolicies } from "@paperclipai/db";
import { claimBoardOwnership, getBoardClaimWarningUrl, initializeBoardClaimChallenge } from "../board-claim.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./helpers/connection-delivery-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("board claim wakes connection delivery", () => {
  let db: ReturnType<typeof createDb>;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let delivery: Awaited<ReturnType<typeof startConnectionDelivery>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-claim-delivery-");
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: "claim-owner", name: "Owner", email: "claim@example.test",
      createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);
  beforeEach(async () => {
    await db.execute(sql`truncate table companies cascade`);
    await db.delete(instanceUserRoles);
    await initializeBoardClaimChallenge(db, { deploymentMode: "local_trusted" });
  });
  afterEach(async () => { await delivery?.stop(); delivery = null; });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  async function arrange(prior: "new" | "suspended" = "suspended") {
    const fixture = await seedPendingAccessRequest(db, "claim-owner");
    await db.insert(toolPolicies).values({ companyId: fixture.companyId, name: "Allow", policyType: "allow", selectors: {} });
    if (prior === "new") await db.delete(companyMemberships);
    else await db.update(companyMemberships).set({ status: "suspended" });
    await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" });
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const url = new URL(getBoardClaimWarningUrl("127.0.0.1", 3197)!);
    const claim = { token: url.pathname.split("/").pop()!, code: url.searchParams.get("code")!, userId: "claim-owner" };
    return { ...fixture, claim };
  }
  const card = async () => (await db.select().from(issueThreadInteractions))[0]!;
  async function retired(connectionId: string) {
    expect(await card()).toMatchObject({ status: "expired", result: expect.objectContaining({ connectionId }) });
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
    expect(delivery!.wakeup).toHaveBeenCalledOnce();
  }

  it.each(["new", "suspended"] as const)("retires through the real claim with %s membership", async prior => {
    const f = await arrange(prior);
    delivery = await startConnectionDelivery(db);
    expect((await card()).status).toBe("pending");
    const baseline = delivery.sweeps;
    await claimBoardOwnership(db, f.claim);
    await delivery.settle(baseline + 1);
    await retired(f.connection.id);
  });
});
