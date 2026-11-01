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
import type { PluginLoader } from "../services/plugin-loader.js";

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

  it("soft uninstall keeps install artifacts until a later purge stops the worker", async () => {
    const teardownFailure = new Error("worker still alive");
    let stopped = false;
    mockRegistry.getById.mockResolvedValue(plugin("ready"));
    mockRegistry.uninstall.mockResolvedValue(plugin("uninstalled"));
    const { lifecycle, loader } = createLifecycle(() => (stopped ? Promise.resolve() : Promise.reject(teardownFailure)));

    const softFailure = await lifecycle.unload("plugin-1").then(() => null, (err: unknown) => err);
    expect(softFailure).toBeInstanceOf(PluginTeardownError);
    expect((softFailure as PluginTeardownError).teardownError).toBe(teardownFailure);
    expect(mockRegistry.uninstall).toHaveBeenCalledWith("plugin-1", false);
    expect(loader.cleanupInstallArtifacts).not.toHaveBeenCalled();

    mockRegistry.getById.mockResolvedValue(plugin("uninstalled"));
    await expect(lifecycle.unload("plugin-1", true)).rejects.toBe(teardownFailure);
    expect(loader.cleanupInstallArtifacts).not.toHaveBeenCalled();
    expect(mockRegistry.uninstall).toHaveBeenCalledTimes(1);

    stopped = true;
    await lifecycle.unload("plugin-1", true);
    expect(loader.cleanupInstallArtifacts).toHaveBeenCalledTimes(1);
    expect(mockRegistry.uninstall).toHaveBeenLastCalledWith("plugin-1", true);
  });

  it("soft uninstall reports the teardown failure even when artifact cleanup would fail", async () => {
    const teardownFailure = new Error("worker still alive");
    mockRegistry.getById.mockResolvedValue(plugin("ready"));
    mockRegistry.uninstall.mockResolvedValue(plugin("uninstalled"));
    const { lifecycle, loader } = createLifecycle(() => Promise.reject(teardownFailure));
    loader.cleanupInstallArtifacts.mockRejectedValue(new Error("cleanup failed"));

    const failure = await lifecycle.unload("plugin-1").then(() => null, (err: unknown) => err);

    expect(failure).toBeInstanceOf(PluginTeardownError);
    expect((failure as PluginTeardownError).teardownError).toBe(teardownFailure);
    expect(loader.cleanupInstallArtifacts).not.toHaveBeenCalled();
    expect(mockRegistry.uninstall).toHaveBeenCalledWith("plugin-1", false);
  });
});
