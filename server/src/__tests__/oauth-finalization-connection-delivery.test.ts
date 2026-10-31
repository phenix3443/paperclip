import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authUsers, connectionGrants, createDb, issueThreadInteractions, toolConnections, toolProfiles } from "@paperclipai/db";
import { createOAuthAccessFinalization } from "../services/tool-access/oauth/access-finalization.js";
import { secretService } from "../services/secrets.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./helpers/connection-delivery-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("OAuth finalization wakes connection delivery from its own writes", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let delivery: Awaited<ReturnType<typeof startConnectionDelivery>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-finalization-delivery-");
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: "owner", name: "Owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);
  beforeEach(async () => { await db.execute(sql`truncate table companies cascade`); });
  afterEach(async () => { await delivery?.stop(); delivery = null; });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  async function arrange() {
    const f = await seedPendingAccessRequest(db, "owner");
    await db.update(toolProfiles).set({ defaultAction: "allow" });
    await db.update(toolConnections).set({ authKind: "oauth", status: "draft", enabled: false });
    await db.update(connectionGrants).set({ credentialSecretRefs: [{ secretId: randomUUID(), configPath: "oauth.access_token", versionSelector: "latest" }] });
    return f;
  }
  function producer(client = db) {
    return createOAuthAccessFinalization(client, {
      getConnectionRow: id => client.select().from(toolConnections).where(eq(toolConnections.id, id)).then(rows => rows[0]!),
      secrets: secretService(client),
      store: { createOrRotateOAuthSecret: vi.fn(), syncCredentialBindings: vi.fn().mockResolvedValue(undefined) },
      assertAgentsInCompany: vi.fn().mockResolvedValue(undefined),
      finishGalleryAppConnection: async () => { throw new Error("stop before later setup writes"); },
    });
  }

  it("retires from the personal connection transaction even when later setup fails", async () => {
    const f = await arrange();
    delivery = await startConnectionDelivery(db);
    const baseline = delivery.sweeps;
    await expect(producer()(f.companyId, f.connection.id, { grantKind: "user" }, { actorType: "user", actorId: "owner" }))
      .rejects.toThrow("stop before later setup writes");
    await delivery.settle(baseline + 1);
    expect((await db.select().from(issueThreadInteractions))[0]).toMatchObject({ status: "expired", result: expect.objectContaining({ connectionId: f.connection.id }) });
    expect(delivery.wakeup).toHaveBeenCalledOnce();
  });
});
