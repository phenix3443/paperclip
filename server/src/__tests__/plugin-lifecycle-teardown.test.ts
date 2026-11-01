import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  updateStatus: vi.fn(),
  uninstall: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { PluginTeardownError } from "../services/plugin-teardown-error.js";
import { pluginLoader, type PluginLoader, type PluginRuntimeServices } from "../services/plugin-loader.js";
import { createPluginHostServiceCleanup } from "../services/plugin-host-service-cleanup.js";

function plugin(status: string) {
  return { id: "plugin-1", pluginKey: "example.plugin", status, manifestJson: { id: "example.plugin" } };
}

function createLifecycle(unloadSingle: () => Promise<void>) {
  const loader = {
    hasRuntimeServices: () => true,
    unloadSingle: vi.fn(unloadSingle),
    cleanupInstallArtifacts: vi.fn().mockResolvedValue(undefined),
  };
  const lifecycle = pluginLifecycleManager({} as never, { loader: loader as unknown as PluginLoader });
  return { lifecycle, loader };
}

describe("plugin lifecycle teardown failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("disable saves the new status and reports the teardown failure as PluginTeardownError", async () => {
    const teardownFailure = new Error("scheduler unavailable");
    mockRegistry.getById.mockResolvedValue(plugin("ready"));
    mockRegistry.updateStatus.mockResolvedValue(plugin("disabled"));
    const { lifecycle } = createLifecycle(() => Promise.reject(teardownFailure));

    const failure = await lifecycle.disable("plugin-1").then(() => null, (err: unknown) => err);

    expect(failure).toBeInstanceOf(PluginTeardownError);
    expect((failure as PluginTeardownError).teardownError).toBe(teardownFailure);
    expect(mockRegistry.updateStatus).toHaveBeenCalledWith("plugin-1", { status: "disabled", lastError: null });
  });

  it("purging an already-uninstalled plugin retries teardown and keeps the row when it fails", async () => {
    const teardownFailure = new Error("worker still alive");
    mockRegistry.getById.mockResolvedValue(plugin("uninstalled"));
    const { lifecycle, loader } = createLifecycle(() => Promise.reject(teardownFailure));

    await expect(lifecycle.unload("plugin-1", true)).rejects.toBe(teardownFailure);

    expect(loader.unloadSingle).toHaveBeenCalledWith("plugin-1", "example.plugin");
    expect(loader.cleanupInstallArtifacts).not.toHaveBeenCalled();
    expect(mockRegistry.uninstall).not.toHaveBeenCalled();
  });

  it("purging an already-uninstalled plugin deletes the row after teardown succeeds", async () => {
    mockRegistry.getById.mockResolvedValue(plugin("uninstalled"));
    mockRegistry.uninstall.mockResolvedValue(plugin("uninstalled"));
    const { lifecycle, loader } = createLifecycle(() => Promise.resolve());

    await lifecycle.unload("plugin-1", true);

    expect(loader.unloadSingle).toHaveBeenCalledWith("plugin-1", "example.plugin");
    expect(mockRegistry.uninstall).toHaveBeenCalledWith("plugin-1", true);
  });

  it("a failed soft uninstall leaves a purge that keeps the row and registration until the worker stops", async () => {
    let row = plugin("ready");
    mockRegistry.getById.mockImplementation(async () => row);
    mockRegistry.uninstall.mockImplementation(async (_id: string, removeData: boolean) => {
      row = removeData ? row : plugin("uninstalled");
      return row;
    });
    const handle = { status: "stopping" };
    let registered = true;
    let stopSucceeds = false;
    const stopWorker = vi.fn(async () => {
      if (!stopSucceeds) throw new Error("worker still alive after SIGKILL");
      registered = false;
    });
    const runtime = {
      workerManager: { getWorker: () => (registered ? handle : undefined), stopWorker },
      jobScheduler: { unregisterPlugin: vi.fn().mockResolvedValue(undefined) },
      eventBus: { clearPlugin: vi.fn() },
      toolDispatcher: { unregisterPluginTools: vi.fn() },
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
    } as unknown as PluginRuntimeServices;
    const loader = pluginLoader({} as never, {}, runtime);
    const cleanupInstallArtifacts = vi.spyOn(loader, "cleanupInstallArtifacts").mockResolvedValue(undefined);
    const lifecycle = pluginLifecycleManager({} as never, { loader });

    await expect(lifecycle.unload("plugin-1", false)).rejects.toBeInstanceOf(PluginTeardownError);
    expect(row.status).toBe("uninstalled");
    expect(cleanupInstallArtifacts).not.toHaveBeenCalled();

    await expect(lifecycle.unload("plugin-1", true)).rejects.toBeInstanceOf(AggregateError);
    expect(mockRegistry.uninstall).not.toHaveBeenCalledWith("plugin-1", true);
    expect(cleanupInstallArtifacts).not.toHaveBeenCalled();
    expect(registered).toBe(true);

    stopSucceeds = true;
    await lifecycle.unload("plugin-1", true);
    expect(stopWorker).toHaveBeenCalledTimes(3);
    expect(registered).toBe(false);
    expect(mockRegistry.uninstall).toHaveBeenCalledWith("plugin-1", true);
    expect(cleanupInstallArtifacts).toHaveBeenCalledTimes(1);
  });

  it("disposes host services inside teardown for disable, a repeated disable, restart and upgrade, keeping the new generation", async () => {
    let row: Record<string, unknown> = plugin("ready");
    mockRegistry.getById.mockImplementation(async () => row);
    mockRegistry.updateStatus.mockImplementation(async (_id: string, patch: Record<string, unknown>) => {
      row = { ...row, ...patch };
      return row;
    });
    let running = false;
    const workerManager = {
      getWorker: () => (running ? { restart: vi.fn() } : undefined),
      stopWorker: vi.fn(async () => {
        running = false;
      }),
      revokeStarts: vi.fn(),
      allowStarts: vi.fn(),
    };
    const disposers = new Map<string, () => void>();
    let cleanup: ReturnType<typeof createPluginHostServiceCleanup> | undefined;
    const runtime = {
      workerManager,
      jobScheduler: { unregisterPlugin: vi.fn().mockResolvedValue(undefined) },
      eventBus: { clearPlugin: vi.fn() },
      toolDispatcher: { unregisterPluginTools: vi.fn() },
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      disposeHostServices: (pluginId: string) => cleanup!.disposePlugin(pluginId),
    } as unknown as PluginRuntimeServices;
    const generations: Array<ReturnType<typeof vi.fn>> = [];
    const activate = () => {
      const dispose = vi.fn(() => {
        expect(running).toBe(false);
      });
      generations.push(dispose);
      cleanup!.register("plugin-1", dispose);
      running = true;
    };
    const loader = pluginLoader({} as never, {}, runtime);
    vi.spyOn(loader, "loadSingle").mockImplementation(async () => {
      activate();
      return { success: true, plugin: row, registered: {} } as never;
    });
    vi.spyOn(loader, "upgradePlugin").mockResolvedValue({
      oldManifest: { capabilities: [], version: "1.0.0" },
      newManifest: { capabilities: [], version: "1.1.0" },
      discovered: { version: "1.1.0" },
    } as never);
    const lifecycle = pluginLifecycleManager({} as never, { loader, workerManager: workerManager as never });
    cleanup = createPluginHostServiceCleanup(lifecycle, disposers);
    activate();

    await lifecycle.disable("plugin-1");
    expect(generations[0]).toHaveBeenCalledTimes(1);
    expect(disposers.size).toBe(0);

    await lifecycle.disable("plugin-1");
    expect(generations[0]).toHaveBeenCalledTimes(1);

    await lifecycle.enable("plugin-1");
    expect(generations).toHaveLength(2);
    expect(generations[1]).not.toHaveBeenCalled();

    await lifecycle.restartWorker("plugin-1");
    expect(generations[1]).toHaveBeenCalledTimes(1);
    expect(generations[2]).not.toHaveBeenCalled();

    await lifecycle.upgrade("plugin-1");
    expect(generations[2]).toHaveBeenCalledTimes(1);
    expect(generations).toHaveLength(4);
    expect(generations[3]).not.toHaveBeenCalled();
    expect(disposers.get("plugin-1")).toBe(generations[3]);
    expect(row.status).toBe("ready");
  });

  it("registering host services over a stale generation disposes the stale one", () => {
    const disposers = new Map<string, () => void>();
    const cleanup = createPluginHostServiceCleanup({ on: vi.fn(), off: vi.fn() }, disposers);
    const stale = vi.fn();
    const fresh = vi.fn();

    cleanup.register("plugin-1", stale);
    cleanup.register("plugin-1", fresh);

    expect(stale).toHaveBeenCalledTimes(1);
    expect(fresh).not.toHaveBeenCalled();
    expect(disposers.get("plugin-1")).toBe(fresh);
  });
});
