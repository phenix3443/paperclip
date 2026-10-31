import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog, authUsers, companyMemberships, connectionGrants, connectionIntentDeliveries, createDb,
  databaseWorkPending, issueThreadInteractions, toolProfiles, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { seedPendingAccessRequest, startConnectionDelivery } from "../__tests__/helpers/connection-delivery-harness.js";
import { cloudTenantPrimaryCompanyId } from "../services/cloud-instance.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { cloudActorHeaderSourceFromHeaders, resolveCloudTenantActor } from "./auth.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("cloud sign-in connection delivery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let stop: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("cloud-connection-delivery-");
    db = createDb(database.connectionString);
    vi.stubEnv("PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN", "synthetic-cloud-token");
  }, 90_000);
  beforeEach(async () => { await db.execute(sql`truncate table companies cascade`); });
  afterEach(async () => { await stop?.(); stop = undefined; vi.restoreAllMocks(); });
  afterAll(async () => { vi.unstubAllEnvs(); await db?.$client.end({ timeout: 0 }); await database?.cleanup(); });

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }

  async function fixture(status = "active", membershipRole = "viewer") {
    const owner = randomUUID();
    const headers = {
      "x-paperclip-cloud-tenant-token": "synthetic-cloud-token",
      "x-paperclip-cloud-user-id": owner,
      "x-paperclip-cloud-user-email": `${owner}@example.test`,
      "x-paperclip-cloud-stack-id": randomUUID(),
    };
    await db.insert(authUsers).values({ id: owner, name: "Owner", email: `${owner}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    const f = await seedPendingAccessRequest(db, owner, cloudTenantPrimaryCompanyId(headers["x-paperclip-cloud-stack-id"]));
    await db.update(toolProfiles).set({ defaultAction: "allow" }).where(eq(toolProfiles.companyId, f.companyId));
    await db.update(connectionGrants).set({ kind: "organization", subjectUserId: null }).where(eq(connectionGrants.companyId, f.companyId));
    const member = and(eq(companyMemberships.companyId, f.companyId), eq(companyMemberships.principalId, owner));
    await db.update(companyMemberships).set({ status, membershipRole }).where(member);
    const signIn = (role = "member", client = db, name = "Owner") => resolveCloudTenantActor(client,
      cloudActorHeaderSourceFromHeaders({ ...headers, "x-paperclip-cloud-stack-role": role, "x-paperclip-cloud-user-name": name }));
    const card = () => db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.id, f.intent.id)).then(rows => rows[0]!);
    return { signIn, member, card, companyId: f.companyId, connectionId: f.connection.id };
  }

  async function start(options: Parameters<typeof startConnectionDelivery>[1] = {}) {
    const worker = await startConnectionDelivery(db, options);
    stop = worker.stop;
    return worker;
  }

  async function effects(companyId: string, count: number, wakeup: ReturnType<typeof vi.fn>) {
    expect(await db.select().from(connectionIntentDeliveries).where(eq(connectionIntentDeliveries.companyId, companyId))).toHaveLength(count);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.thread_interaction_resolved")))).toHaveLength(count);
    expect(wakeup).toHaveBeenCalledTimes(count);
  }

  it.each([["active", "viewer"], ["suspended", "member"], ["pending", "member"]])("retires the exact request after sign-in restores %s/%s", async (status, role) => {
    const f = await fixture(status, role);
    const worker = await start();
    expect((await f.card()).status).toBe("pending");
    const baseline = worker.sweeps;
    await f.signIn();
    await worker.settle(baseline + 1);
    expect(await f.card()).toMatchObject({ status: "expired", result: expect.objectContaining({ connectionId: f.connectionId }) });
    await effects(f.companyId, 1, worker.wakeup);
  });

  it("does not wake for a raw membership write until explicitly woken", async () => {
    const f = await fixture();
    const worker = await start();
    const baseline = worker.sweeps;
    await db.update(companyMemberships).set({ membershipRole: "member" }).where(f.member);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(worker.sweeps).toBe(baseline);
    expect((await f.card()).status).toBe("pending");
    await effects(f.companyId, 0, worker.wakeup);
    worker.wake();
    await worker.settle(baseline + 1);
    expect((await f.card()).status).toBe("expired");
    await effects(f.companyId, 1, worker.wakeup);
  });

  it("retries after a forced transaction rollback without durable delivery effects", async () => {
    const f = await fixture();
    const worker = await start();
    const transaction = db.transaction.bind(db);
    const fault = vi.spyOn(db, "transaction").mockImplementation(((work) => transaction(async tx => {
      await work(tx);
      expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
      expect((await tx.select().from(companyMemberships).where(f.member))[0]?.membershipRole).toBe("member");
      throw new Error("forced cloud rollback");
    })) as typeof db.transaction);
    const baseline = worker.sweeps;
    await expect(f.signIn()).rejects.toThrow("forced cloud rollback");
    fault.mockRestore();
    await worker.settle(baseline + 1);
    expect((await db.select().from(companyMemberships).where(f.member))[0]?.membershipRole).toBe("viewer");
    expect((await f.card()).status).toBe("pending");
    await effects(f.companyId, 0, worker.wakeup);
    const retryBaseline = worker.sweeps;
    await f.signIn();
    await worker.settle(retryBaseline + 1);
    expect((await f.card()).status).toBe("expired");
    await effects(f.companyId, 1, worker.wakeup);
  });

  it("awaits intent registration before a narrowing membership write", async () => {
    const f = await fixture("active", "member");
    await db.update(toolProfiles).set({ defaultAction: "deny" }).where(eq(toolProfiles.companyId, f.companyId));
    const worker = await start();
    const baseline = worker.sweeps;
    const entered = deferred(), release = deferred();
    const transaction = db.transaction.bind(db);
    const inserted = vi.fn();
    vi.spyOn(db, "transaction").mockImplementation(((work) => transaction(async tx => {
      const execute = tx.execute.bind(tx), insert = tx.insert.bind(tx);
      tx.execute = (async (...args) => {
        entered.resolve();
        await release.promise;
        return execute(...args);
      }) as typeof tx.execute;
      tx.insert = ((table) => { inserted(table); return insert(table); }) as typeof tx.insert;
      return work(tx);
    })) as typeof db.transaction);
    const pending = f.signIn("support");
    try {
      await entered.promise;
      expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
      expect(inserted).not.toHaveBeenCalled();
    } finally { release.resolve(); await pending; }
    expect(inserted).toHaveBeenCalledWith(companyMemberships);
    await worker.settle(baseline + 1);
    expect((await f.card()).status).toBe("pending");
    await effects(f.companyId, 0, worker.wakeup);
  });

  it("retains the membership notification until the caller's outer transaction commits", async () => {
    const f = await fixture();
    const worker = await start();
    const baseline = worker.sweeps;
    const entered = deferred(), release = deferred();
    const pending = db.transaction(async tx => {
      await f.signIn("member", tx as unknown as Db);
      entered.resolve();
      await release.promise;
    });
    try {
      await entered.promise;
      expect(databaseWorkPending(db, DELIVERY_QUEUES.connection)).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(worker.sweeps).toBe(baseline);
      expect((await f.card()).status).toBe("pending");
      await effects(f.companyId, 0, worker.wakeup);
    } finally { release.resolve(); await pending; }
    await worker.settle(baseline + 1);
    expect((await f.card()).status).toBe("expired");
    await effects(f.companyId, 1, worker.wakeup);
  });

  it("skips notifications for unchanged upserts and debounces only successful syncs for five seconds", async () => {
    const f = await fixture();
    const worker = await start();
    await f.signIn();
    await worker.settle(2);
    const baseline = worker.sweeps;
    const transaction = vi.spyOn(db, "transaction");
    const [before] = await db.select().from(companyMemberships).where(f.member);
    await f.signIn("member", db, "Changed name");
    expect(transaction).toHaveBeenCalledTimes(1);
    await Promise.all([f.signIn("member", db, "Changed name"), f.signIn("member", db, "Changed name")]);
    expect(transaction).toHaveBeenCalledTimes(1);
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 5_001);
    try { await f.signIn("member", db, "Changed name"); } finally { clock.mockRestore(); }
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(await db.select().from(companyMemberships).where(f.member)).toEqual([before]);
    await new Promise(resolve => setTimeout(resolve, 200));
    await worker.settle();
    expect(worker.sweeps).toBe(baseline);
    await effects(f.companyId, 1, worker.wakeup);
  });

  it("notifies for legal role changes in both directions without duplicate delivery", async () => {
    const f = await fixture();
    const worker = await start();
    for (const role of ["member", "owner", "member", "support"]) {
      const baseline = worker.sweeps;
      await f.signIn(role);
      await worker.settle(baseline + 1);
      expect((await db.select().from(companyMemberships).where(f.member))[0]?.membershipRole).toBe(role);
    }
    expect((await f.card()).status).toBe("expired");
    await effects(f.companyId, 1, worker.wakeup);
  });

  it("serializes concurrent sign-ins and retains their dirty rerun across a held read", async () => {
    const f = await fixture();
    const worker = await start();
    const baseline = worker.sweeps;
    const held = worker.hold();
    worker.wake();
    await held.entered;
    await Promise.all([f.signIn("member"), f.signIn("owner"), f.signIn("member")]);
    expect((await db.select().from(companyMemberships).where(f.member))[0]?.membershipRole).toBe("member");
    expect((await f.card()).status).toBe("pending");
    held.release();
    await worker.settle(baseline + 2);
    expect((await f.card()).status).toBe("expired");
    await effects(f.companyId, 1, worker.wakeup);
  });

  it("does not retire after a grant is withdrawn by a raw write while the read is held", async () => {
    const f = await fixture();
    const worker = await start();
    const baseline = worker.sweeps;
    const held = worker.hold();
    await f.signIn();
    await held.entered;
    await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(f.member);
    held.release();
    await worker.settle(baseline + 1);
    expect(worker.sweeps).toBe(baseline + 1);
    expect((await f.card()).status).toBe("pending");
    await effects(f.companyId, 0, worker.wakeup);
  });

  it("retains a committed membership change through admission drain", async () => {
    const f = await fixture();
    let admission = true;
    const worker = await start({ canRun: () => admission });
    const baseline = worker.sweeps;
    admission = false;
    await f.signIn();
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(worker.sweeps).toBe(baseline);
    expect((await f.card()).status).toBe("pending");
    await effects(f.companyId, 0, worker.wakeup);
    admission = true;
    worker.wake();
    await worker.settle(baseline + 1);
    expect((await f.card()).status).toBe("expired");
    await effects(f.companyId, 1, worker.wakeup);
  });
});
