import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LeaseReleasedError,
  PluginLifecycleBusyError,
  createPluginLifecycleSerializer,
  createPluginLifecycleShared,
  pluginLifecycleSharedFor,
  type PluginLifecycleLease,
} from "../services/plugin-lifecycle-shared.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("plugin lifecycle serializer", () => {
  it("runs operations for one key strictly in FIFO order", async () => {
    const serializer = createPluginLifecycleSerializer();
    const order: string[] = [];
    const gate = deferred();
    const first = serializer.run("p", "A", async () => {
      order.push("first:start");
      await gate.promise;
      order.push("first:end");
    });
    const second = serializer.run("p", "Q", async () => {
      order.push("second");
    });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("does not make different keys wait on each other", async () => {
    const serializer = createPluginLifecycleSerializer();
    const gate = deferred();
    const held = serializer.run("x", "A", () => gate.promise);
    await expect(serializer.run("y", "Q", async () => "y-done")).resolves.toBe("y-done");
    gate.resolve();
    await held;
  });

  it("releases the key after a failing operation", async () => {
    const serializer = createPluginLifecycleSerializer();
    await expect(
      serializer.run("p", "A", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(serializer.run("p", "Q", async () => "next")).resolves.toBe("next");
  });

  it("rejects with plugin_lifecycle_busy after queueWaitMs and never runs the body", async () => {
    vi.useFakeTimers();
    const serializer = createPluginLifecycleSerializer({ queueWaitMs: 50 });
    const gate = deferred();
    const held = serializer.run("p", "A", () => gate.promise);
    const body = vi.fn(async () => "late");
    const waiting = serializer.run("p", "Q", body);
    const assertion = expect(waiting).rejects.toBeInstanceOf(PluginLifecycleBusyError);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    gate.resolve();
    await held;
    await vi.runAllTimersAsync();
    expect(body).not.toHaveBeenCalled();
    await expect(serializer.run("p", "Q", async () => "after")).resolves.toBe("after");
  });

  it("makes a lease unusable after its operation settles", async () => {
    const serializer = createPluginLifecycleSerializer();
    let captured: PluginLifecycleLease | undefined;
    await serializer.run("p", "A", async (lease) => {
      lease.assertActive();
      lease.assertCleanup();
      captured = lease;
    });
    expect(captured?.released).toBe(true);
    expect(() => captured?.assertActive()).toThrow(LeaseReleasedError);
    expect(() => captured?.assertCleanup()).toThrow(LeaseReleasedError);
  });
});

describe("plugin lifecycle shared context", () => {
  it("is shared by every lifecycle built on the same worker manager", () => {
    const manager = {} as PluginWorkerManager;
    expect(pluginLifecycleSharedFor(manager)).toBe(pluginLifecycleSharedFor(manager));
    expect(pluginLifecycleSharedFor({} as PluginWorkerManager)).not.toBe(
      pluginLifecycleSharedFor(manager),
    );
    expect(pluginLifecycleSharedFor(undefined)).not.toBe(pluginLifecycleSharedFor(undefined));
  });

  it("tracks the current generation per plugin", () => {
    const shared = createPluginLifecycleShared();
    const epoch = shared.bumpEpoch("p");
    expect(shared.isCurrentGeneration("p", epoch)).toBe(true);
    shared.quiesced.add("p");
    expect(shared.isCurrentGeneration("p", epoch)).toBe(false);
    shared.quiesced.delete("p");
    shared.bumpEpoch("p");
    expect(shared.isCurrentGeneration("p", epoch)).toBe(false);
  });
});
