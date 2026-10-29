import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, withDedicatedDbConnection } from "./client.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./test-embedded-postgres.js";
import { databaseWorkScopeKey, databaseWorkPending, installDatabaseWorkSignals, reconcileDatabaseWork, signalDatabaseWork, subscribeDatabaseWork } from "./work-signals.js";
import * as workSignals from "./work-signals.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("database work signals", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("work-signals-");
    db = createDb(temporary.connectionString);
    await db.execute(sql`create table work_signal_test (id text primary key)`);
  }, 90_000);
  afterAll(async () => { await temporary?.cleanup(); });

  it("runs a committed callback once outside the outer transaction and discards rolled-back savepoints", async () => {
    const callbacks: string[] = [];
    await db.transaction(async tx => {
      await workSignals.afterDatabaseCommit(tx, "commit-test", () => { callbacks.push("outer"); });
      await tx.transaction(async nested => {
        await workSignals.afterDatabaseCommit(nested, "commit-test", () => { callbacks.push("nested"); });
        await nested.execute(sql`insert into work_signal_test values ('commit-callback')`);
      });
      await expect(tx.transaction(async nested => {
        await workSignals.afterDatabaseCommit(nested, "commit-test", () => { callbacks.push("rolled-back"); });
        throw new Error("discard savepoint");
      })).rejects.toThrow("discard savepoint");
      expect(callbacks).toEqual([]);
      expect(await db.execute(sql`select * from work_signal_test where id = 'commit-callback'`)).toHaveLength(0);
    });
    expect(callbacks).toEqual(["outer", "nested"]);
    expect(await db.execute(sql`select * from work_signal_test where id = 'commit-callback'`)).toHaveLength(1);
    await reconcileDatabaseWork(db, "unused");
    expect(callbacks).toEqual(["outer", "nested"]);
  });

  it("defers nested savepoint notifications until the outer commit and preserves return values", async () => {
    const events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, "nested", event => events.push(event));
    try {
      const result = await db.transaction(async tx => {
        await tx.transaction(async nested => {
          await signalDatabaseWork(nested, "nested");
          await nested.execute(sql`insert into work_signal_test values ('nested')`);
        });
        expect(events).toEqual(["intent"]);
        expect(databaseWorkPending(db, "nested")).toBe(true);
        expect(await db.execute(sql`select * from work_signal_test where id = 'nested'`)).toHaveLength(0);
        return 123;
      });
      expect(result).toBe(123);
      expect(events).toEqual(["intent", "settled"]);
      expect(databaseWorkPending(db, "nested")).toBe(false);
      expect(await db.execute(sql`select * from work_signal_test where id = 'nested'`)).toHaveLength(1);
    } finally { unsubscribe(); }
  });

  it("reconciles a rollback without leaving a permanent pending flag", async () => {
    const callback = vi.fn();
    await expect(db.transaction(async tx => {
      await workSignals.afterDatabaseCommit(tx, "commit-test", callback);
      await signalDatabaseWork(tx, "rollback");
      await tx.execute(sql`insert into work_signal_test values ('rollback')`);
      throw new Error("abort");
    })).rejects.toThrow("abort");
    await reconcileDatabaseWork(db, "rollback");
    expect(databaseWorkPending(db, "rollback")).toBe(false);
    expect(await db.execute(sql`select * from work_signal_test where id = 'rollback'`)).toHaveLength(0);
    expect(callback).not.toHaveBeenCalled();
  });

  it("coalesces scoped hints and publishes them only when the outer transaction settles", async () => {
    const settled: string[][] = [];
    const unsubscribe = subscribeDatabaseWork(db, "scoped", (event, hints) => {
      if (event === "settled") settled.push([...(hints ?? [])]);
    });
    try {
      await db.transaction(async tx => {
        await signalDatabaseWork(tx, "scoped", "connection-a");
        await tx.transaction(async nested => {
          await signalDatabaseWork(nested, "scoped", "connection-b");
          await signalDatabaseWork(nested, "scoped", "connection-a");
        });
        expect(settled).toEqual([]);
      });
      expect(settled).toEqual([["connection-a", "connection-b"]]);
    } finally { unsubscribe(); }
  });

  it("keeps outer ownership after a caught savepoint rollback", async () => {
    const events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, "savepoint", event => events.push(event));
    try {
      await db.transaction(async tx => {
        await expect(tx.transaction(async nested => {
          await signalDatabaseWork(nested, "savepoint");
          await nested.execute(sql`insert into work_signal_test values ('savepoint')`);
          throw new Error("rollback savepoint");
        })).rejects.toThrow("rollback savepoint");
        expect(databaseWorkPending(db, "savepoint")).toBe(true);
        expect(events).toEqual(["intent"]);
        await signalDatabaseWork(tx, "savepoint");
        await tx.execute(sql`insert into work_signal_test values ('savepoint-retry')`);
      });
      expect(events).toEqual(["intent", "intent", "settled"]);
      expect(databaseWorkPending(db, "savepoint")).toBe(false);
    } finally { unsubscribe(); }
  });

  it.each(["commit", "abort"])("does not clear a late %s until PostgreSQL reports a settled transaction", async outcome => {
    // Inject a lost response at the client boundary while a REAL transaction
    // remains open on PostgreSQL. The status probe and row visibility are real.
    const raw = drizzle(db.$client);
    const transaction = raw.transaction.bind(raw);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let wrote!: () => void;
    const written = new Promise<void>(resolve => { wrote = resolve; });
    let serverDone!: Promise<unknown>;
    raw.transaction = ((callback: any) => {
      serverDone = transaction(async tx => {
        const result = await callback(tx);
        wrote();
        await gate;
        if (outcome === "abort") throw new Error("server abort");
        return result;
      });
      // Observe rejection immediately; tests await the same result below.
      void serverDone.catch(() => {});
      return written.then(() => { throw new Error("lost transaction response"); });
    }) as typeof raw.transaction;
    const owner = installDatabaseWorkSignals(raw);
    const topic = `late-${outcome}`;
    const settled: string[][] = [];
    const callback = vi.fn();
    const unsubscribe = subscribeDatabaseWork(owner, topic, (event, hints) => {
      if (event === "settled") settled.push([...(hints ?? [])]);
    });
    try {
      await expect(owner.transaction(async tx => {
        await workSignals.afterDatabaseCommit(tx, "commit-test", callback);
        await signalDatabaseWork(tx, topic, "connection-late");
        await tx.execute(sql`insert into work_signal_test values (${topic})`);
      })).rejects.toThrow("lost transaction response");
      await reconcileDatabaseWork(owner, topic);
      expect(databaseWorkPending(owner, topic)).toBe(true);
      expect(callback).not.toHaveBeenCalled();
      expect(await db.execute(sql`select * from work_signal_test where id = ${topic}`)).toHaveLength(0);
      settled.length = 0;
      release(); await serverDone.catch(() => {});
      await Promise.all([reconcileDatabaseWork(owner, topic), reconcileDatabaseWork(owner, topic)]);
      expect(settled).toEqual([["connection-late"]]);
      expect(databaseWorkPending(owner, topic)).toBe(false);
      expect(await db.execute(sql`select * from work_signal_test where id = ${topic}`)).toHaveLength(outcome === "commit" ? 1 : 0);
      expect(callback).toHaveBeenCalledTimes(outcome === "commit" ? 1 : 0);
    } finally { release(); await serverDone?.catch(() => {}); unsubscribe(); }
  });

  it("recovers after a real backend disconnect without replaying the queue write", async () => {
    await expect(db.transaction(async tx => {
      await signalDatabaseWork(tx, "disconnect");
      await tx.execute(sql`insert into work_signal_test values ('disconnect')`);
      const [{ pid }] = await tx.execute(sql`select pg_backend_pid() as pid`);
      await db.execute(sql`select pg_terminate_backend(${pid as number})`);
      await tx.execute(sql`select 1`);
    })).rejects.toThrow();
    await reconcileDatabaseWork(db, "disconnect");
    expect(databaseWorkPending(db, "disconnect")).toBe(false);
    expect(await db.execute(sql`select * from work_signal_test where id = 'disconnect'`)).toHaveLength(0);
  });

  it("shares notifications with dedicated child pools but isolates unrelated roots and topics", async () => {
    const listener = vi.fn();
    const other = createDb(temporary.connectionString);
    const unsubscribe = subscribeDatabaseWork(db, "dedicated", listener);
    try {
      await other.transaction(tx => signalDatabaseWork(tx, "dedicated"));
      await db.transaction(tx => signalDatabaseWork(tx, "other"));
      expect(listener).not.toHaveBeenCalled();
      await withDedicatedDbConnection(db, dedicated => dedicated.transaction(tx => signalDatabaseWork(tx, "dedicated")));
      expect(listener.mock.calls.map(([event]) => event)).toEqual(["intent", "settled"]);
    } finally { unsubscribe(); await other.$client.end(); }
  });

  it("runs dedicated-pool commit callbacks after their writes become visible", async () => {
    let readCommitted: Promise<unknown> | undefined;
    await withDedicatedDbConnection(db, dedicated => dedicated.transaction(async tx => {
      await workSignals.afterDatabaseCommit(tx, "commit-test", () => {
        readCommitted = db.execute(sql`select * from work_signal_test where id = 'dedicated-callback'`);
      });
      await tx.execute(sql`insert into work_signal_test values ('dedicated-callback')`);
      expect(readCommitted).toBeUndefined();
    }));
    expect(await readCommitted).toHaveLength(1);
  });

  it("never changes transaction success because a listener throws", async () => {
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const unsubscribe = subscribeDatabaseWork(db, "listener", () => { throw new Error("listener"); });
    try {
      await expect(db.transaction(async tx => { await signalDatabaseWork(tx, "listener"); return 7; })).resolves.toBe(7);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally { unsubscribe(); warn.mockRestore(); }
  });
});

describe("work signal query boundaries", () => {
  it("wakes the existing recovery owner only on failed callback transactions and preserves legacy NULL settlement", async () => {
    const execute = vi.fn(async () => [{ xid: "75", status: null }]);
    let fail = false;
    const connection = installDatabaseWorkSignals({ execute, transaction: async (callback: any) => {
      const result = await callback({ execute, transaction: async () => {} });
      if (fail) throw new Error("lost commit response");
      return result;
    } });
    const recovered = vi.fn();
    const events: string[] = [];
    const unsubscribe = subscribeDatabaseWork(connection, "existing-owner", event => events.push(event));
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      await connection.transaction(async (tx: object) => {
        await workSignals.afterDatabaseCommit(tx, "existing-owner", recovered);
      });
      expect(events).toEqual([]);
      expect(recovered).toHaveBeenCalledOnce();
      recovered.mockClear();
      fail = true;
      await expect(connection.transaction(async (tx: object) => {
        await workSignals.afterDatabaseCommit(tx, "existing-owner", recovered);
      })).rejects.toThrow("lost commit response");
      expect(events).toEqual(["intent", "settled"]);
      expect(databaseWorkPending(connection, "existing-owner")).toBe(true);
      await reconcileDatabaseWork(connection, "existing-owner");
      expect(events).toEqual(["intent", "settled", "settled"]);
      expect(databaseWorkPending(connection, "existing-owner")).toBe(false);
      expect(databaseWorkPending(connection)).toBe(true);
      expect(recovered).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledOnce();
    } finally { unsubscribe(); warn.mockRestore(); }
  });

  it("retains callbacks when the commit outcome is unknown and never guesses committed", async () => {
    let status: string | null = null;
    const execute = vi.fn(async () => [{ xid: "73", status }]);
    const connection = installDatabaseWorkSignals({ execute, transaction: async (callback: any) => {
      await callback({ execute, transaction: async () => {} });
      throw new Error("lost commit response");
    } });
    const committed = vi.fn();
    await expect(connection.transaction(async (tx: object) => {
      await workSignals.afterDatabaseCommit(tx, "commit-test", committed);
    })).rejects.toThrow("lost commit response");
    await expect(reconcileDatabaseWork(connection)).rejects.toThrow("commit outcome unavailable");
    expect(databaseWorkPending(connection)).toBe(true);
    expect(committed).not.toHaveBeenCalled();
    status = "aborted";
    await reconcileDatabaseWork(connection);
    expect(databaseWorkPending(connection)).toBe(false);
    expect(committed).not.toHaveBeenCalled();
  });

  it("contains synchronous and asynchronous callback failures after successful commit", async () => {
    const execute = vi.fn(async () => [{ xid: "74" }]);
    const connection = installDatabaseWorkSignals({ execute, transaction: async (callback: any) => callback({ execute, transaction: async () => {} }) });
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const last = vi.fn();
    try {
      await expect(connection.transaction(async (tx: object) => {
        await workSignals.afterDatabaseCommit(tx, "commit-test", () => { throw new Error("sync callback failed"); });
        await workSignals.afterDatabaseCommit(tx, "commit-test", async () => { throw new Error("async callback failed"); });
        await workSignals.afterDatabaseCommit(tx, "commit-test", last);
        return 23;
      })).resolves.toBe(23);
      expect(last).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(databaseWorkPending(connection)).toBe(false);
    } finally { warn.mockRestore(); }
  });

  it("adds no SQL to transactions which do not register queue work", async () => {
    const execute = vi.fn();
    const connection = installDatabaseWorkSignals({ execute, transaction: async (callback: any) => callback({ execute, transaction: async () => {} }) });
    await expect(connection.transaction(async () => 19)).resolves.toBe(19);
    expect(execute).not.toHaveBeenCalled();
  });
  it("fails before the write if XID acquisition fails, without retaining uncertainty", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("disconnected"));
    const connection = installDatabaseWorkSignals({ execute, transaction: async (callback: any) => callback({ execute, transaction: async () => {} }) });
    const write = vi.fn();
    await expect(connection.transaction(async (tx: any) => { await signalDatabaseWork(tx, "failed"); write(); })).rejects.toThrow("disconnected");
    expect(write).not.toHaveBeenCalled();
    expect(databaseWorkPending(connection, "failed")).toBe(false);
  });
  it("rejects registration on an autocommit root", async () => {
    const connection = installDatabaseWorkSignals({ execute: vi.fn(), transaction: vi.fn() });
    await expect(signalDatabaseWork(connection, "bad")).rejects.toThrow("inside a transaction");
  });
});


describe("database work scope identity", () => {
  type TestConnection = { execute: () => Promise<unknown[]>; transaction: (callback: (tx: TestConnection) => unknown) => Promise<unknown> };
  function connection(): TestConnection {
    return { execute: vi.fn(async () => []), transaction: async callback => callback(connection()) };
  }
  it("shares owner identity through child pools and nested transactions, but isolates independent owners", async () => {
    const first = installDatabaseWorkSignals(connection());
    const second = installDatabaseWorkSignals(connection());
    const child = installDatabaseWorkSignals(connection(), first);
    const key = databaseWorkScopeKey(first);
    expect(databaseWorkScopeKey(second)).not.toBe(key);
    expect(databaseWorkScopeKey(child)).toBe(key);
    await child.transaction(async tx => {
      expect(databaseWorkScopeKey(tx)).toBe(key);
      await tx.transaction(async nested => { expect(databaseWorkScopeKey(nested)).toBe(key); });
    });
  });
});
