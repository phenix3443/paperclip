/**
 * PluginJobCoordinator — bridges the plugin lifecycle manager with the
 * job scheduler and job store.
 *
 * This service listens to lifecycle events and performs the corresponding
 * scheduler and job store operations:
 *
 * - **plugin.loaded** → sync job declarations from manifest, then register
 *   the plugin with the scheduler (computes `nextRunAt` for active jobs).
 *
 * - **plugin.disabled / plugin.unloaded** → unregister the plugin from the
 *   scheduler (cancels in-flight runs, clears tracking state).
 *
 * ## Why a separate coordinator?
 *
 * The lifecycle manager, scheduler, and job store are independent services
 * with clean single-responsibility boundaries. The coordinator provides
 * the "glue" between them without adding coupling. This pattern is used
 * throughout Paperclip (e.g. heartbeat service coordinates timers + runs).
 *
 * @see PLUGIN_SPEC.md §17 — Scheduled Jobs
 * @see ./plugin-job-scheduler.ts — Scheduler service
 * @see ./plugin-job-store.ts — Persistence layer
 * @see ./plugin-lifecycle.ts — Plugin state machine
 */

import type { PluginLifecycleManager } from "./plugin-lifecycle.js";
import type { PluginJobScheduler } from "./plugin-job-scheduler.js";
import type { PluginJobStore } from "./plugin-job-store.js";
import { pluginRegistryService } from "./plugin-registry.js";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Options for creating a PluginJobCoordinator.
 */
export interface PluginJobCoordinatorOptions {
  /** Drizzle database instance. */
  db: Db;
  /** The plugin lifecycle manager to listen to. */
  lifecycle: PluginLifecycleManager;
  /** The job scheduler to register/unregister plugins with. */
  scheduler: PluginJobScheduler;
  /** The job store for syncing declarations. */
  jobStore: PluginJobStore;
}

/**
 * The public interface of the job coordinator.
 */
export interface PluginJobCoordinator {
  /**
   * Start listening to lifecycle events.
   *
   * This wires up the `plugin.loaded`, `plugin.disabled`, and
   * `plugin.unloaded` event handlers.
   */
  start(): void;

  /**
   * Stop listening to lifecycle events.
   *
   * Removes all event subscriptions added by `start()`.
   */
  stop(): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a PluginJobCoordinator.
 *
 * @example
 * ```ts
 * const coordinator = createPluginJobCoordinator({
 *   db,
 *   lifecycle,
 *   scheduler,
 *   jobStore,
 * });
 *
 * // Start listening to lifecycle events
 * coordinator.start();
 *
 * // On server shutdown
 * coordinator.stop();
 * ```
 */
export function createPluginJobCoordinator(
  options: PluginJobCoordinatorOptions,
): PluginJobCoordinator {
  const { db, lifecycle, scheduler, jobStore } = options;
  const log = logger.child({ service: "plugin-job-coordinator" });
  const registry = pluginRegistryService(db);

  // -----------------------------------------------------------------------
  // Event handlers
  // -----------------------------------------------------------------------

  /**
   * When a plugin is purged: delete its job definitions and runs.
   */
  async function onPluginUnloaded(payload: {
    pluginId: string;
    pluginKey: string;
    removeData: boolean;
  }): Promise<void> {
    const { pluginId, pluginKey, removeData } = payload;
    if (!removeData) return;

    try {
      log.info({ pluginId, pluginKey }, "purging job data for uninstalled plugin");
      await jobStore.deleteAllJobs(pluginId);
    } catch (err) {
      log.error(
        {
          pluginId,
          pluginKey,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to purge job data during unload",
      );
    }
  }

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------

  let attached = false;

  // We need stable references for on/off since the lifecycle manager
  // uses them for matching. We wrap the async handlers in sync wrappers
  // that fire-and-forget (swallowing unhandled rejections via the try/catch
  // inside each handler).
  const boundOnUnloaded = (payload: { pluginId: string; pluginKey: string; removeData: boolean }) => {
    void onPluginUnloaded(payload);
  };

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    start(): void {
      if (attached) return;
      attached = true;

      lifecycle.on("plugin.unloaded", boundOnUnloaded);

      log.info("plugin job coordinator started — listening to lifecycle events");
    },

    stop(): void {
      if (!attached) return;
      attached = false;

      lifecycle.off("plugin.unloaded", boundOnUnloaded);

      log.info("plugin job coordinator stopped");
    },
  };
}
