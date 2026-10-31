import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activityLog, authUsers, connectionIntentDeliveries, createDb, databaseWorkPending, issueThreadInteractions, toolCatalogEntries,
  toolConnectionInstalls, toolConnections, toolPolicies, toolProfileEntries, toolProfiles } from "@paperclipai/db";
import { toolAccessService } from "../services/tool-access.js";
import { createCatalogDefaultAccess } from "../services/tool-access/catalog/default-access.js";
import { createOAuthCatalogCompletion } from "../services/tool-access/oauth/catalog-completion.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "./helpers/connection-delivery-harness.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const pause = () => new Promise(resolve => setTimeout(resolve, 200));

describePostgres("tool catalog writes notify the connection delivery worker", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let delivery: Awaited<ReturnType<typeof startConnectionDelivery>> | null = null;
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase("paperclip-catalog-connection-delivery-");
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({ id: "owner", name: "Owner", email: "owner@example.test", createdAt: new Date(), updatedAt: new Date() });
  }, 20_000);
  beforeEach(async () => { await db.execute(sql`truncate table companies cascade`); });
  afterEach(async () => { await delivery?.stop(); delivery = null; });
  afterAll(async () => { await db.$client.end({ timeout: 1 }); await temp?.cleanup(); });

  const card = async () => (await db.select().from(issueThreadInteractions))[0]!;
  const tools = [{ name: "sentry-read", description: "Read issues", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }];
  const catalog = () => toolAccessService(db, {
    remoteHttpEndpointLookup: async () => [{ address: "8.8.8.8", family: 4 }],
    remoteHttpRequest: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "initialize" ? { protocolVersion: "2025-06-18" } : { tools } }),
        { headers: { "content-type": "application/json" } });
    },
  });
  async function seedRefreshable(skipDefaultProfileSync: boolean) {
    const f = await seedPendingAccessRequest(db, "owner");
    await db.update(toolConnections).set({ authKind: "none", credentialPolicy: "shared", config: { url: "https://mcp.example.test/mcp" } })
      .where(eq(toolConnections.id, f.connection.id));
    await catalog().refreshCatalog(f.connection.id, undefined, { skipDefaultProfileSync });
    const [entry] = await db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.id, f.tool.id));
    const intent = await card();
    const payload = intent.payload as { accessRequest: { tools: Array<{ versionHash: string }> } };
    payload.accessRequest.tools[0]!.versionHash = entry!.versionHash;
    await db.update(issueThreadInteractions).set({ payload: payload as never }).where(eq(issueThreadInteractions.id, intent.id));
    return f;
  }
  async function permit(f: Awaited<ReturnType<typeof seedPendingAccessRequest>>) {
    const [profile] = await db.select().from(toolProfiles).where(eq(toolProfiles.companyId, f.companyId));
    await db.insert(toolProfileEntries).values({ companyId: f.companyId, profileId: profile!.id, selectorType: "catalog_entry", effect: "include",
      connectionId: f.connection.id, catalogEntryId: f.tool.id });
  }
  async function seedAskFirst() {
    const f = await seedPendingAccessRequest(db, "owner");
    await permit(f);
    await db.insert(toolPolicies).values({ companyId: f.companyId, name: "Ask first", policyType: "require_approval", priority: 50,
      selectors: { catalogEntryId: f.tool.id }, config: { source: "app_gallery_finish", connectionId: f.connection.id, catalogEntryId: f.tool.id } });
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id));
    return { ...f, input: { companyId: f.companyId, connection: connection!, askFirstEntries: [] } };
  }
  async function start(options?: Parameters<typeof startConnectionDelivery>[1]) {
    delivery = await startConnectionDelivery(db, options);
    expect((await card()).status).toBe("pending");
    return delivery.sweeps;
  }
  async function expectRetired(connectionId: string) {
    expect(await card()).toMatchObject({ status: "expired", result: expect.objectContaining({ connectionId }) });
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(1);
    expect(delivery!.wakeup).toHaveBeenCalledOnce();
  }

  it.each([
    ["the default profile publish", true, async () => {}],
    ["the catalog entry upsert", false, async (entryId: string) => {
      await db.update(toolCatalogEntries).set({ status: "disabled", quarantineReason: "mcp_tool_removed" }).where(eq(toolCatalogEntries.id, entryId));
    }],
  ] as const)("retires an exact access request once through %s of two back-to-back refreshes", async (_name, seedSkip, disable) => {
    const f = await seedRefreshable(seedSkip);
    await disable(f.tool.id);
    const baseline = await start();
    await catalog().refreshCatalog(f.connection.id, undefined, { skipDefaultProfileSync: !seedSkip });
    await catalog().refreshCatalog(f.connection.id, undefined, { skipDefaultProfileSync: !seedSkip });
    await delivery!.settle(baseline + 1);
    await expectRetired(f.connection.id);
  });

  async function holdTable(table: string, writes: () => Promise<unknown>) {
    const holder = createDb(temp.connectionString);
    let release!: () => void, locked!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }), lock = new Promise<void>(resolve => { locked = resolve; });
    const holding = holder.transaction(async (tx) => { await tx.execute(sql.raw(`lock table ${table} in share mode`)); locked(); await held; });
    let pending: Promise<unknown> | undefined;
    try {
      await lock;
      pending = writes();
      const waiting = async () => (await holder.execute(sql`select 1 from pg_locks where not granted`)).length > 0;
      for (let attempt = 0; attempt < 25 && !await waiting(); attempt += 1) await pause();
      expect(await waiting()).toBe(true);
      const before = delivery!.sweeps;
      for (let attempt = 0; attempt < 25 && (delivery!.sweeps === before || delivery!.running > 0); attempt += 1) await pause();
      expect(delivery!.running).toBe(0);
      return delivery!.sweeps;
    } finally { release(); await holding; await holder.$client.end({ timeout: 1 }); await pending; }
  }

  it("retires an exact access request through the connection update after the entry upsert sweep found it unhealthy", async () => {
    const f = await seedRefreshable(true);
    await permit(f);
    await db.update(toolConnections).set({ healthStatus: "error" }).where(eq(toolConnections.id, f.connection.id));
    const baseline = await start();
    const beforeHealth = await holdTable("tool_connections", async () => {
      await catalog().refreshCatalog(f.connection.id, undefined, { skipDefaultProfileSync: true });
    });
    expect(beforeHealth).toBeGreaterThan(baseline);
    await delivery!.settle(beforeHealth + 1);
    await expectRetired(f.connection.id);
  });

  it("notifies from the runtime slot update after the earlier refresh sweeps finish", async () => {
    const f = await seedPendingAccessRequest(db, "owner");
    const service = catalog();
    await service.createStdioCommandTemplate(f.companyId, { templateId: "admin.local-echo", name: "Admin local echo", command: "node",
      args: ["./echo-mcp.js"], tools: [{ name: "echo", description: "Echo a message.", annotations: { readOnlyHint: true } }] },
    { actorType: "user", actorId: "owner" } as never);
    const stdio = await service.createConnection(f.companyId, { name: "Local echo", transport: "local_stdio", config: { templateId: "admin.local-echo" },
      enabled: true, status: "active" });
    const baseline = await start();
    const beforeSlot = await holdTable("tool_runtime_slots", () => service.refreshCatalog(stdio.id, undefined, { skipDefaultProfileSync: true }));
    expect(beforeSlot).toBeGreaterThan(baseline);
    await delivery!.settle(beforeSlot + 1);
    expect((await card()).status).toBe("pending");
    expect(delivery!.wakeup).not.toHaveBeenCalled();
  });

  it("retires an exact access request when stale ask-first policies are disabled", async () => {
    const f = await seedAskFirst();
    const baseline = await start();
    await createCatalogDefaultAccess(db).upsertAskFirstPolicies(f.input);
    await delivery!.settle(baseline + 1);
    await expectRetired(f.connection.id);
    expect(await db.select().from(toolPolicies).where(eq(toolPolicies.policyType, "require_approval"))).toMatchObject([{ enabled: false }]);
  });

  it("notifies when OAuth completion installs the agent, which an exact request does not need", async () => {
    const f = await seedPendingAccessRequest(db, "owner");
    await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, f.connection.id));
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id));
    const baseline = await start();
    await createOAuthCatalogCompletion(db, async () => ({}) as never)({ connection: connection!, catalog: [],
      suggestedDefaults: { access: { agentIds: [f.agentId] } } as never });
    await delivery!.settle(baseline + 1);
    expect(await db.select().from(toolConnectionInstalls)).toMatchObject([{ targetType: "agent", targetId: f.agentId }]);
    expect((await card()).status).toBe("pending");
  });

  it("notifies on a narrowing ask-first write without retiring the card", async () => {
    const f = await seedPendingAccessRequest(db, "owner");
    const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id));
    const baseline = await start();
    await createCatalogDefaultAccess(db).upsertAskFirstPolicies({ companyId: f.companyId, connection: connection!, askFirstEntries: [f.tool] });
    await delivery!.settle(baseline + 1);
    expect((await card()).status).toBe("pending");
    expect(delivery!.wakeup).not.toHaveBeenCalled();
  });

  it("leaves a raw catalog write without a notification to the worker until something wakes it", async () => {
    const f = await seedRefreshable(false);
    await db.update(toolCatalogEntries).set({ status: "disabled" }).where(eq(toolCatalogEntries.id, f.tool.id));
    const baseline = await start();
    await db.update(toolCatalogEntries).set({ status: "active" }).where(eq(toolCatalogEntries.id, f.tool.id));
    await pause();
    expect(delivery!.sweeps).toBe(baseline);
    expect((await card()).status).toBe("pending");
    delivery!.wake();
    await delivery!.settle(baseline + 1);
    await expectRetired(f.connection.id);
  });

  it("publishes a savepoint write only when the caller's transaction commits", async () => {
    const f = await seedAskFirst();
    const baseline = await start();
    await db.transaction(async (tx) => {
      await createCatalogDefaultAccess(db).upsertAskFirstPolicies(f.input, tx);
      expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
      await pause();
      expect(delivery!.sweeps).toBe(baseline);
    });
    await delivery!.settle(baseline + 1);
    await expectRetired(f.connection.id);
  });

  it("keeps the card pending with no durable effect when the caller's transaction rolls back", async () => {
    const f = await seedAskFirst();
    const baseline = await start();
    await expect(db.transaction(async (tx) => {
      await createCatalogDefaultAccess(db).upsertAskFirstPolicies(f.input, tx);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");

    await delivery!.settle(baseline + 1);
    expect((await card()).status).toBe("pending");
    expect(await db.select().from(toolPolicies).where(and(eq(toolPolicies.policyType, "require_approval"), eq(toolPolicies.enabled, true)))).toHaveLength(1);
    expect(await db.select().from(connectionIntentDeliveries)).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.thread_interaction_resolved"))).toHaveLength(0);
    expect(delivery!.wakeup).not.toHaveBeenCalled();
  });

  it.each([
    ["retires once when a widening write", false],
    ["stays pending when a widening and a narrowing write", true],
  ] as const)("%s commits during an in-flight sweep", async (_name, narrow) => {
    const f = await seedAskFirst();
    const baseline = await start();
    const holder = createDb(temp.connectionString);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let locked!: () => void;
    const lock = new Promise<void>(resolve => { locked = resolve; });
    const holding = holder.transaction(async (tx) => { await tx.execute(sql`lock table tool_profiles in access exclusive mode`); locked(); await held; });
    try {
      await lock;
      delivery!.wake();
      const waiting = async () => (await holder.execute(sql`select 1 from pg_locks where not granted`)).length > 0;
      for (let attempt = 0; attempt < 25 && !await waiting(); attempt += 1) await pause();
      expect(await waiting()).toBe(true);
      await createCatalogDefaultAccess(db).upsertAskFirstPolicies(f.input);
      if (narrow) await createCatalogDefaultAccess(db).upsertAskFirstPolicies({ ...f.input, askFirstEntries: [f.tool] });
    } finally { release(); await holding; await holder.$client.end({ timeout: 1 }); }
    await delivery!.settle(baseline + 2);
    if (!narrow) return expectRetired(f.connection.id);
    expect((await card()).status).toBe("pending");
    expect(delivery!.wakeup).not.toHaveBeenCalled();
  });

  it("retires after admission reopens, not while it is drained", async () => {
    const f = await seedAskFirst();
    let open = true;
    const baseline = await start({ canRun: () => open });
    open = false;
    await createCatalogDefaultAccess(db).upsertAskFirstPolicies(f.input);
    await pause();
    expect(delivery!.sweeps).toBe(baseline);
    expect((await card()).status).toBe("pending");
    open = true;
    delivery!.wake();
    await delivery!.settle(baseline + 1);
    await expectRetired(f.connection.id);
  });
});
