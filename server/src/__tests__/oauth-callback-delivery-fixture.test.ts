import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, companySecrets, createDb, toolConnections, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { arrangeOAuthCallback, OAUTH_CALLBACK_MODES } from "./helpers/oauth-callback-delivery-fixture.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("OAuth callback delivery fixture", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let fixture: Awaited<ReturnType<typeof arrangeOAuthCallback>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-oauth-callback-fixture-");
    db = createDb(temp.connectionString);
  }, 20_000);
  afterEach(async () => { await fixture?.cleanup(); fixture = null; });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  it.each(OAUTH_CALLBACK_MODES)("runs the real %s entry writes and isolates later writes", async mode => {
    fixture = await arrangeOAuthCallback(db, mode);
    const delivery = await fixture.startDelivery();
    const before = await fixture.read();
    expect(before.card.status).toBe("pending");
    expect(before.states).toHaveLength(1);
    await fixture.callback();
    await delivery.settle();
    const after = await fixture.read();
    expect(after.states).toHaveLength(0);
    expect(fixture.later.refreshCatalog).toHaveBeenCalledTimes(1);
    expect(fixture.later.finishCatalog).toHaveBeenCalledTimes(mode === "cloud reauthorization" ? 0 : 1);
    expect(fixture.later.checkHealth).toHaveBeenCalledTimes(mode === "direct organization" ? 1 : 0);
    expect(fixture.claim).toHaveBeenCalledTimes(mode.startsWith("cloud") ? 1 : 0);
    expect(after.connection).toMatchObject({ status: mode === "cloud draft" ? "draft" : "active", enabled: mode !== "cloud draft" });
    expect(after.grants).toHaveLength(1);
    expect(after.grants[0]).toMatchObject(mode === "direct organization"
      ? { kind: "organization", isDefault: true, status: "active" }
      : { kind: "user", subjectUserId: "owner", status: "active" });
    const refs = mode === "direct organization" ? after.connection.credentialSecretRefs : after.grants[0]!.credentialSecretRefs;
    expect(refs.map(ref => ref.configPath).sort()).toEqual(["oauth.access_token", "oauth.refresh_token"]);
    expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, fixture.companyId))).toHaveLength(2);
    const sweeps = delivery.sweeps;
    await delivery.wake();
    await delivery.settle(sweeps + 1);
    const swept = await fixture.read();
    expect(swept.card.status).toBe(mode === "cloud draft" ? "pending" : "expired");
    expect(swept.deliveries).toHaveLength(mode === "cloud draft" ? 0 : 1);
    expect(delivery.wakeup).toHaveBeenCalledTimes(mode === "cloud draft" ? 0 : 1);
  });

  it.each(OAUTH_CALLBACK_MODES)("aborts %s writes from the pre-commit control", async mode => {
    fixture = await arrangeOAuthCallback(db, mode);
    const before = await fixture.read();
    await expect(fixture.callback({ beforeCommit: async () => { throw new Error("stop before commit"); } })).rejects.toThrow("stop before commit");
    const after = await fixture.read();
    expect(after.connection.updatedAt).toEqual(before.connection.updatedAt);
    expect(after.grants).toEqual(before.grants);
    expect(after.states).toHaveLength(mode.startsWith("cloud") ? 1 : 0);
    expect(await db.select().from(companySecrets).where(eq(companySecrets.companyId, fixture.companyId))).toHaveLength(0);
    expect(fixture.later.refreshCatalog).not.toHaveBeenCalled();
  });

  it.each(OAUTH_CALLBACK_MODES)("adapts %s to a caller-owned transaction", async mode => {
    fixture = await arrangeOAuthCallback(db, mode);
    const before = await fixture.read();
    await expect(db.transaction(async tx => {
      await fixture!.callback({ client: tx as unknown as Db });
      throw new Error("outer rollback");
    })).rejects.toThrow("outer rollback");
    const after = await fixture.read();
    expect(after.states).toHaveLength(1);
    expect(after.grants).toEqual(before.grants);
    expect(fixture.later.refreshCatalog).toHaveBeenCalledTimes(1);
  });

  it("removes the arranged rows and stops delivery during cleanup", async () => {
    fixture = await arrangeOAuthCallback(db, "direct user");
    const key = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    await fixture.startDelivery();
    await fixture.cleanup();
    fixture = null;
    expect(await db.select().from(companies)).toHaveLength(0);
    expect(await db.select().from(toolConnections)).toHaveLength(0);
    expect(process.env.PAPERCLIP_SECRETS_MASTER_KEY).not.toBe(key);
  });
});
