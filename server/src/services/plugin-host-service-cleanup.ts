import type { PluginLifecycleEventGeneration, PluginLifecycleManager } from "./plugin-lifecycle.js";

type LifecycleLike = Pick<PluginLifecycleManager, "on" | "off"> &
  Partial<Pick<PluginLifecycleManager, "currentEpoch">>;

export interface PluginWorkerRuntimeEvent {
  type: "plugin.worker.crashed" | "plugin.worker.restarted";
  pluginId: string;
}

export interface PluginHostServiceCleanupController {
  register(pluginId: string, dispose: () => void): void;
  disposePlugin(pluginId: string): void;
  handleWorkerEvent(event: PluginWorkerRuntimeEvent): void;
  disposeAll(): void;
  teardown(): void;
}

export function createPluginHostServiceCleanup(
  lifecycle: LifecycleLike,
  disposers: Map<string, () => void>,
): PluginHostServiceCleanupController {
  const runDispose = (pluginId: string, remove = false) => {
    const dispose = disposers.get(pluginId);
    if (!dispose) return;
    dispose();
    if (remove) {
      disposers.delete(pluginId);
    }
  };

  const isStaleOrActivating = (payload: PluginLifecycleEventGeneration & { pluginId: string }) =>
    payload.kind !== undefined
    && (payload.kind !== "Q" || payload.epoch !== lifecycle.currentEpoch?.(payload.pluginId));

  const handleWorkerStopped = (payload: PluginLifecycleEventGeneration & { pluginId: string }) => {
    if (isStaleOrActivating(payload)) return;
    runDispose(payload.pluginId);
  };

  const handlePluginUnloaded = (payload: PluginLifecycleEventGeneration & { pluginId: string }) => {
    if (isStaleOrActivating(payload)) return;
    runDispose(payload.pluginId, true);
  };

  lifecycle.on("plugin.worker_stopped", handleWorkerStopped);
  lifecycle.on("plugin.unloaded", handlePluginUnloaded);

  return {
    register(pluginId, dispose) {
      runDispose(pluginId, true);
      disposers.set(pluginId, dispose);
    },

    disposePlugin(pluginId) {
      runDispose(pluginId, true);
    },

    handleWorkerEvent(event) {
      if (event.type === "plugin.worker.crashed") {
        runDispose(event.pluginId);
      }
    },

    disposeAll() {
      for (const dispose of disposers.values()) {
        dispose();
      }
      disposers.clear();
    },

    teardown() {
      lifecycle.off("plugin.worker_stopped", handleWorkerStopped);
      lifecycle.off("plugin.unloaded", handlePluginUnloaded);
    },
  };
}
