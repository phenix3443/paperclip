import type { PluginRecord } from "@paperclipai/shared";
import type { logger } from "../middleware/logger.js";
import {
  PluginLifecycleFencedError,
  type PluginLifecycleLease,
  type PluginLifecycleOpKind,
  type PluginLifecycleRunOptions,
  type PluginLifecycleShared,
} from "./plugin-lifecycle-shared.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

export interface PluginLifecycleIsolationDeps {
  shared: PluginLifecycleShared;
  workerManager?: PluginWorkerManager;
  log: Pick<typeof logger, "warn" | "error">;
  getPlugin(pluginId: string): Promise<PluginRecord | null>;
  deactivate(pluginId: string, pluginKey: string, lease: PluginLifecycleLease): Promise<void>;
  markExpired(pluginId: string, plugin: PluginRecord, lease: PluginLifecycleLease): Promise<void>;
}

export type PluginQuiesceTarget = (plugin: PluginRecord, lease: PluginLifecycleLease) => Promise<unknown>;

export function createPluginLifecycleIsolation(deps: PluginLifecycleIsolationDeps) {
  const { shared, workerManager, log } = deps;

  function fence(pluginId: string, reason: string): void {
    const token = `${reason} (fenced at ${new Date().toISOString()})`;
    shared.fenced.set(pluginId, token);
    shared.quiesced.add(pluginId);
    workerManager?.revokeStarts?.(pluginId);
    const handle = workerManager?.getWorker(pluginId);
    if (handle) {
      const onExit = () => {
        handle.off("exit", onExit);
        if (shared.fenced.get(pluginId) === token) shared.fenced.delete(pluginId);
      };
      handle.on("exit", onExit);
    }
    log.warn({ pluginId, reason }, "plugin lifecycle: plugin fenced");
  }

  function assertNotFenced(pluginId: string, pluginKey: string): void {
    const reason = shared.fenced.get(pluginId);
    if (reason !== undefined) throw new PluginLifecycleFencedError(pluginKey, reason);
  }

  async function tryDeactivate(
    pluginId: string,
    pluginKey: string,
    lease: PluginLifecycleLease,
  ): Promise<unknown> {
    try {
      await deps.deactivate(pluginId, pluginKey, lease);
    } catch (err) {
      return err ?? new Error(`Failed to deactivate plugin ${pluginKey}`);
    }
    if (workerManager?.getWorker(pluginId)) {
      return new Error(`Worker for plugin ${pluginKey} is still registered after teardown`);
    }
    return null;
  }

  async function quiesceRuntime(
    pluginId: string,
    pluginKey: string,
    lease: PluginLifecycleLease,
  ): Promise<unknown> {
    const teardownError = await tryDeactivate(pluginId, pluginKey, lease);
    if (teardownError) {
      fence(pluginId, teardownError instanceof Error ? teardownError.message : String(teardownError));
    }
    return teardownError;
  }

  function expiryHooks(
    getPluginId: () => string | undefined,
    kind: PluginLifecycleOpKind,
    quiesceTarget?: PluginQuiesceTarget,
  ): Pick<PluginLifecycleRunOptions, "onExpire" | "expiryCleanup"> {
    let expiryStop: Promise<unknown> = Promise.resolve(null);
    return {
      onExpire() {
        const pluginId = getPluginId();
        if (!pluginId) return;
        workerManager?.revokeStarts?.(pluginId);
        shared.quiesced.add(pluginId);
        shared.bumpEpoch(pluginId);
        shared.withdraw(pluginId);
        if (workerManager?.getWorker(pluginId)) {
          expiryStop = workerManager.stopWorker(pluginId).then(() => null, (err: unknown) => err);
        }
      },
      async expiryCleanup(lease) {
        const pluginId = getPluginId();
        if (!pluginId) return;
        const failures: unknown[] = [];
        const record = (err: unknown) => void failures.push(err);
        const stopError = await expiryStop;
        if (stopError) failures.push(stopError);
        const plugin = await deps.getPlugin(pluginId).catch((err: unknown) => {
          record(err);
          return null;
        });
        if (plugin) {
          const teardownError = await tryDeactivate(pluginId, plugin.pluginKey, lease);
          if (teardownError) failures.push(teardownError);
          if (kind === "Q") {
            await quiesceTarget?.(plugin, lease).catch(record);
          } else if (["ready", "installed", "upgrade_pending"].includes(plugin.status)) {
            await deps.markExpired(pluginId, plugin, lease).catch(record);
          }
        }
        if (failures.length > 0) {
          fence(pluginId, "lifecycle deadline expired and cleanup failed");
          log.error({ pluginId, failures }, "plugin lifecycle: expiry cleanup failed");
        } else {
          shared.quiesced.add(pluginId);
        }
      },
    };
  }

  return { fence, assertNotFenced, quiesceRuntime, tryDeactivate, expiryHooks };
}
