import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { createNativeStatusDrain, type NativeWakeDispatchInput } from "./native-status-drain.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("native status queue drain generations", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const result = { scanned: 1, dispatched: 0, recovered: 0, deferred: 1, promoted: 0 };
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("native-drain-"); db = createDb(database.connectionString); }, 60_000);
  afterAll(async () => { await database?.cleanup(); });

  it("rechecks a release in the observation-to-settlement microtask gap", async () => {
    const scope = { companyId: randomUUID(), agentId: randomUUID() }, id = randomUUID();
    let calls = 0;
    const scan = vi.fn(async (_input: NativeWakeDispatchInput, ids?: string[]) => {
      calls++;
      const clear = drain.observe([{ ...scope, id }]);
      clear();
      if (calls === 1) queueMicrotask(() => { void drain.dispatch(scope); });
      else expect(ids).toEqual([id]);
      return result;
    });
    const drain = createNativeStatusDrain(db, scan, async () => true);
    await drain.dispatch(scope);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it("retains a second release during the bounded follow-up until resume", async () => {
    const scope = { companyId: randomUUID(), agentId: randomUUID() }, id = randomUUID();
    let calls = 0;
    const scan = vi.fn(async () => {
      const clear = drain.observe([{ ...scope, id }]);
      if (++calls <= 2) void drain.dispatch(scope);
      clear();
      return result;
    });
    const drain = createNativeStatusDrain(db, scan, async () => true);
    await drain.dispatch(scope);
    expect(scan).toHaveBeenCalledTimes(2);
    await drain.resume();
    expect(scan).toHaveBeenCalledTimes(3);
    await drain.resume();
    expect(scan).toHaveBeenCalledTimes(3);
  });

  it("lets an unrelated company drain while another scope is blocked", async () => {
    const first = { companyId: randomUUID() }, second = { companyId: randomUUID() };
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const drain = createNativeStatusDrain(db, async input => {
      if (input.companyId === first.companyId) { entered(); await gate; }
      return result;
    }, async () => true);
    const blocked = drain.dispatch(first);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await started;
      const responsive = await Promise.race([drain.dispatch(second).then(() => true),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1000); })]);
      expect(responsive).toBe(true);
    } finally { if (timer) clearTimeout(timer); release(); await blocked; }
  });

  it("stop awaits active work and resume retains a release received during stop", async () => {
    const scope = { companyId: randomUUID() };
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    let calls = 0, stopped = false;
    const scan = vi.fn(async () => { if (++calls === 1) { entered(); await gate; } return result; });
    const drain = createNativeStatusDrain(db, scan, async () => true);
    const active = drain.dispatch(scope);
    await started;
    const stop = drain.stop().then(() => { stopped = true; });
    void drain.dispatch(scope);
    await Promise.resolve();
    expect(stopped).toBe(false);
    release(); await active; await stop;
    expect(scan).toHaveBeenCalledTimes(1);
    await drain.resume();
    expect(scan).toHaveBeenCalledTimes(2);
  });
});
