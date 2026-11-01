/**
 * PluginLifecycleManager — state-machine controller for plugin status
 * transitions and worker process coordination.
 *
 * Each plugin moves through a well-defined state machine:
 *
 * ```
 *   installed ──→ ready ──→ disabled
 *       │            │         │
 *       │            ├──→ error│
 *       │            ↓         │
 *       │     upgrade_pending  │
 *       │            │         │
 *       ↓            ↓         ↓
 *              uninstalled
 * ```
 *
 * The lifecycle manager:
 *
 * 1. **Validates transitions** — Only transitions defined in
 *    `VALID_TRANSITIONS` are allowed; invalid transitions throw.
 *
 * 2. **Coordinates workers** — When a plugin moves to `ready`, its
 *    worker process is started. When it moves out of `ready`, the
 *    worker is stopped gracefully.
 *
 * 3. **Emits events** — `plugin.loaded`, `plugin.enabled`,
 *    `plugin.disabled`, `plugin.unloaded`, `plugin.status_changed`
 *    events are emitted so that other services (job coordinator,
 *    tool dispatcher, event bus) can react accordingly.
 *
 * 4. **Persists state** — Status changes are written to the database
 *    through the plugin registry service.
 *
 * @see PLUGIN_SPEC.md §12 — Process Model
 * @see PLUGIN_SPEC.md §12.5 — Graceful Shutdown Policy
 */
import type { Db } from "@paperclipai/db";
import type {
  PluginStatus,
  PluginRecord,
  PaperclipPluginManifestV1,
} from "@paperclipai/shared";
import { pluginRegistryService } from "./plugin-registry.js";
import { pluginLoader, type PluginLoader } from "./plugin-loader.js";
import type { PluginWorkerManager, WorkerStartOptions } from "./plugin-worker-manager.js";
import { badRequest, notFound } from "../errors.js";
import { PluginTeardownError } from "./plugin-teardown-error.js";
import { logger } from "../middleware/logger.js";
import {
  DEFAULT_PLUGIN_LIFECYCLE_RESPONSE_DEADLINE_MS,
  LeaseKeyMismatchError,
  PluginLifecycleFencedError,
  pluginLifecycleSharedFor,
  type PluginLifecycleRunOptions,
  type PluginLifecycleLease,
  type PluginLifecycleOpKind,
  type PluginLifecycleTimings,
  type PluginLoadOptions,
  type PluginRestartOptions,
  type PluginRestartResult,
} from "./plugin-lifecycle-shared.js";
export type { PluginLoadOptions, PluginRestartOptions, PluginRestartResult };

const invalidTransition = (message: string) => badRequest(message, { code: "invalid_transition" });

// ---------------------------------------------------------------------------
// Lifecycle state machine
// ---------------------------------------------------------------------------

/**
 * Valid state transitions for the plugin lifecycle.
 *
 *   installed → ready       (initial load succeeds)
 *   installed → error       (initial load fails)
 *   installed → uninstalled (abort installation)
 *
 *   ready → disabled        (operator disables plugin)
 *   ready → error           (runtime failure)
 *   ready → upgrade_pending (upgrade with new capabilities)
 *   ready → uninstalled     (uninstall)
 *
 *   disabled → ready        (operator re-enables plugin)
 *   disabled → uninstalled  (uninstall while disabled)
 *
 *   error → ready           (retry / recovery)
 *   error → uninstalled     (give up and uninstall)
 *
 *   upgrade_pending → ready       (operator approves new capabilities)
 *   upgrade_pending → error       (upgrade worker fails)
 *   upgrade_pending → uninstalled (reject upgrade and uninstall)
 *
 *   uninstalled → installed (reinstall)
 */
const VALID_TRANSITIONS: Record<string, readonly PluginStatus[]> = {
  installed: ["ready", "error", "uninstalled"],
  ready: ["ready", "disabled", "error", "upgrade_pending", "uninstalled"],
  disabled: ["ready", "uninstalled"],
  error: ["ready", "uninstalled"],
  upgrade_pending: ["ready", "error", "uninstalled"],
  uninstalled: ["installed"], // reinstall
};

/**
 * Check whether a transition from `from` → `to` is valid.
 */
function isValidTransition(from: PluginStatus, to: PluginStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export class PluginActivationError extends Error {
  readonly code = "plugin_activation_failed";
  constructor(message: string) {
    super(message);
    this.name = "PluginActivationError";
  }
}

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

/**
 * Events emitted by the PluginLifecycleManager.
 * Consumers can subscribe to these for routing-table updates, UI refresh
 * notifications, and observability.
 */
export interface PluginLifecycleEventGeneration {
  epoch?: number;
  kind?: PluginLifecycleOpKind;
}

export interface PluginLifecycleEvents {
  /** Emitted after a plugin is loaded (installed → ready). */
  "plugin.loaded": { pluginId: string; pluginKey: string } & PluginLifecycleEventGeneration;
  /** Emitted after a plugin transitions to ready (enabled). */
  "plugin.enabled": { pluginId: string; pluginKey: string } & PluginLifecycleEventGeneration;
  /** Emitted after a plugin is disabled (ready → disabled). */
  "plugin.disabled": { pluginId: string; pluginKey: string; reason?: string } & PluginLifecycleEventGeneration;
  /** Emitted after a plugin is unloaded (any → uninstalled). */
  "plugin.unloaded": { pluginId: string; pluginKey: string; removeData: boolean } & PluginLifecycleEventGeneration;
  /** Emitted on any status change. */
  "plugin.status_changed": {
    pluginId: string;
    pluginKey: string;
    previousStatus: PluginStatus;
    newStatus: PluginStatus;
  } & PluginLifecycleEventGeneration;
  /** Emitted when a plugin enters an error state. */
  "plugin.error": { pluginId: string; pluginKey: string; error: string } & PluginLifecycleEventGeneration;
  /** Emitted when a plugin enters upgrade_pending. */
  "plugin.upgrade_pending": { pluginId: string; pluginKey: string } & PluginLifecycleEventGeneration;
  /** Emitted when a plugin worker process has been started. */
  "plugin.worker_started": { pluginId: string; pluginKey: string } & PluginLifecycleEventGeneration;
  /** Emitted when a plugin worker process has been stopped. */
  "plugin.worker_stopped": { pluginId: string; pluginKey: string } & PluginLifecycleEventGeneration;
}

type LifecycleEventName = keyof PluginLifecycleEvents;
type LifecycleEventPayload<K extends LifecycleEventName> = PluginLifecycleEvents[K];

// ---------------------------------------------------------------------------
// PluginLifecycleManager
// ---------------------------------------------------------------------------

export interface PluginLifecycleOpOptions {
  lease?: PluginLifecycleLease;
  deadlineAt?: number;
}

export interface PluginLifecycleExclusiveOptions {
  deadlineAt?: number;
  pluginId?: () => string | undefined;
}

export interface PluginLifecycleManager {
  /**
   * Load a newly installed plugin – transitions `installed` → `ready`.
   *
   * This is called after the registry has persisted the initial install record.
   * The caller should have already spawned the worker and performed health
   * checks before calling this.  If the worker fails, call `markError` instead.
   */
  load(pluginId: string, options?: PluginLoadOptions): Promise<PluginRecord>;

  /**
   * Enable a plugin that is in `disabled`, `error`, or `upgrade_pending` state.
   * Transitions → `ready`.
   */
  enable(pluginId: string, options?: PluginLifecycleOpOptions): Promise<PluginRecord>;

  /**
   * Disable a running plugin.
   * Transitions `ready` → `disabled`.
   */
  disable(pluginId: string, reason?: string, options?: PluginLifecycleOpOptions): Promise<PluginRecord>;

  /**
   * Unload (uninstall) a plugin from any active state.
   * Transitions → `uninstalled`.
   *
   * When `removeData` is true, the plugin row and cascaded config are
   * hard-deleted.  Otherwise a soft-delete sets status to `uninstalled`.
   */
  unload(
    pluginId: string,
    removeData?: boolean,
    options?: PluginLifecycleOpOptions,
  ): Promise<PluginRecord | null>;

  /**
   * Mark a plugin as errored (e.g. worker crash, health-check failure).
   * Transitions → `error`.
   */
  markError(pluginId: string, error: string, options?: PluginLifecycleOpOptions): Promise<PluginRecord>;

  /**
   * Mark a plugin as requiring upgrade approval.
   * Transitions `ready` → `upgrade_pending`.
   */
  markUpgradePending(pluginId: string, options?: PluginLifecycleOpOptions): Promise<PluginRecord>;

  /**
   * Upgrade a plugin to a newer version.
   * This is a placeholder that handles the lifecycle state transition.
   * The actual package installation is handled by plugin-loader.
   *
   * If the upgrade adds new capabilities, transitions to `upgrade_pending`.
   * Otherwise, transitions to `ready` directly.
   */
  upgrade(pluginId: string, version?: string, options?: PluginLifecycleOpOptions): Promise<PluginRecord>;

  /**
   * Start the worker process for a plugin that is already in `ready` state.
   *
   * This is used by the server startup orchestration to start workers for
   * plugins that were persisted as `ready`. It requires a `PluginWorkerManager`
   * to have been provided at construction time.
   *
   * @param pluginId - The UUID of the plugin to start
   * @param options  - Worker start options (entrypoint path, config, etc.)
   * @throws if no worker manager is configured or the plugin is not ready
   */
  startWorker(pluginId: string, options: WorkerStartOptions): Promise<void>;

  /**
   * Stop the worker process for a plugin without changing lifecycle state.
   *
   * This is used during server shutdown to gracefully stop all workers.
   * It does not transition the plugin state — plugins remain in their
   * current status so they can be restarted on next server boot.
   *
   * @param pluginId - The UUID of the plugin to stop
   */
  stopWorker(pluginId: string): Promise<void>;

  /**
   * Restart the worker process for a running plugin.
   *
   * Stops and re-starts the worker process. The plugin remains in `ready`
   * state throughout. This is typically called after a config change.
   *
   * @param pluginId - The UUID of the plugin to restart
   * @throws if no worker manager is configured or the plugin is not ready
   */
  restartWorker(pluginId: string, options?: PluginRestartOptions): Promise<PluginRestartResult>;

  exclusive<T>(
    pluginKey: string,
    kind: PluginLifecycleOpKind,
    fn: (lease: PluginLifecycleLease) => Promise<T>,
    options?: PluginLifecycleExclusiveOptions,
  ): Promise<T>;

  responseDeadline(): number;

  isFenced(pluginId: string): boolean;

  currentEpoch(pluginId: string): number;

  generationMark(): number;

  changedSince(pluginId: string, mark: number): boolean;

  isCurrentGeneration(pluginId: string, epoch: number): boolean;

  isQuiesced(pluginId: string): boolean;
  registerWatchWithdrawer(withdraw: (pluginId: string) => void): () => void;

  /**
   * Get the current lifecycle state for a plugin.
   */
  getStatus(pluginId: string): Promise<PluginStatus | null>;

  /**
   * Check whether a transition is allowed from the plugin's current state.
   */
  canTransition(pluginId: string, to: PluginStatus): Promise<boolean>;

  /**
   * Subscribe to lifecycle events.
   */
  on<K extends LifecycleEventName>(
    event: K,
    listener: (payload: LifecycleEventPayload<K>) => void,
  ): void;

  /**
   * Unsubscribe from lifecycle events.
   */
  off<K extends LifecycleEventName>(
    event: K,
    listener: (payload: LifecycleEventPayload<K>) => void,
  ): void;

  /**
   * Subscribe to a lifecycle event once.
   */
  once<K extends LifecycleEventName>(
    event: K,
    listener: (payload: LifecycleEventPayload<K>) => void,
  ): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Options for constructing a PluginLifecycleManager.
 */
export interface PluginLifecycleManagerOptions {
  /** Plugin loader instance. Falls back to the default if omitted. */
  loader?: PluginLoader;

  /**
   * Worker process manager. When provided, lifecycle transitions that bring
   * a plugin online (load, enable, upgrade-to-ready) will start the worker
   * process, and transitions that take a plugin offline (disable, unload,
   * markError) will stop it.
   *
   * When omitted the lifecycle manager operates in state-only mode — the
   * caller is responsible for managing worker processes externally.
   */
  workerManager?: PluginWorkerManager;

  lifecycleTimings?: PluginLifecycleTimings;
}

/**
 * Create a PluginLifecycleManager.
 *
 * This service orchestrates plugin state transitions on top of the
 * `pluginRegistryService` (which handles raw DB persistence).  It enforces
 * the lifecycle state machine, emits events for downstream consumers
 * (routing tables, UI, observability), and manages worker processes via
 * the `PluginWorkerManager` when one is provided.
 *
 * Usage:
 * ```ts
 * const lifecycle = pluginLifecycleManager(db, {
 *   workerManager: createPluginWorkerManager(),
 * });
 * lifecycle.on("plugin.enabled", ({ pluginId }) => { ... });
 * await lifecycle.load(pluginId);
 * ```
 *
 * @see PLUGIN_SPEC.md §21.3 — `plugins.status` column
 * @see PLUGIN_SPEC.md §12 — Process Model
 */
export function pluginLifecycleManager(
  db: Db,
  options?: PluginLoader | PluginLifecycleManagerOptions,
): PluginLifecycleManager {
  // Support the legacy signature: pluginLifecycleManager(db, loader)
  // as well as the new options object form.
  let loaderArg: PluginLoader | undefined;
  let workerManager: PluginWorkerManager | undefined;
  let lifecycleTimings: PluginLifecycleTimings | undefined;

  if (options && typeof options === "object" && "discoverAll" in options) {
    // Legacy: second arg is a PluginLoader directly
    loaderArg = options as PluginLoader;
  } else if (options && typeof options === "object") {
    const opts = options as PluginLifecycleManagerOptions;
    loaderArg = opts.loader;
    workerManager = opts.workerManager;
    lifecycleTimings = opts.lifecycleTimings;
  }

  const registry = pluginRegistryService(db);
  const pluginLoaderInstance = loaderArg ?? pluginLoader(db);
  const shared = pluginLifecycleSharedFor(workerManager);
  const hasRuntime = (candidate: PluginLoader | undefined): candidate is PluginLoader =>
    typeof candidate?.hasRuntimeServices === "function" && candidate.hasRuntimeServices();
  if (workerManager && !shared.runtimeLoader && hasRuntime(pluginLoaderInstance)) {
    shared.runtimeLoader = pluginLoaderInstance;
  }
  const runtimeLoader = (): PluginLoader | undefined =>
    hasRuntime(pluginLoaderInstance) ? pluginLoaderInstance : shared.runtimeLoader;
  const emitter = shared.emitter;

  interface LifecycleOp {
    lease: PluginLifecycleLease;
    kind: PluginLifecycleOpKind;
  }

  const log = logger.child({ service: "plugin-lifecycle" });

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  async function requirePlugin(pluginId: string): Promise<PluginRecord> {
    const plugin = await registry.getById(pluginId);
    if (!plugin) throw notFound(`Plugin not found: ${pluginId}`);
    return plugin as PluginRecord;
  }

  function assertTransition(plugin: PluginRecord, to: PluginStatus): void {
    if (!isValidTransition(plugin.status, to)) {
      throw invalidTransition(
        `Invalid lifecycle transition: ${plugin.status} → ${to} for plugin ${plugin.pluginKey}`,
      );
    }
  }

  async function transition(
    pluginId: string,
    to: PluginStatus,
    lastError: string | null = null,
    existingPlugin: PluginRecord | undefined,
    op: LifecycleOp,
  ): Promise<PluginRecord> {
    const plugin = existingPlugin ?? await requirePlugin(pluginId);
    assertTransition(plugin, to);

    const previousStatus = plugin.status;

    const updated = await registry.updateStatus(pluginId, {
      status: to,
      lastError,
    });

    if (!updated) throw notFound(`Plugin not found after status update: ${pluginId}`);
    const result = updated as PluginRecord;

    log.info(
      { pluginId, pluginKey: result.pluginKey, from: previousStatus, to },
      `plugin lifecycle: ${previousStatus} → ${to}`,
    );

    // Emit the generic status_changed event
    emitDomain("plugin.status_changed", {
      pluginId,
      pluginKey: result.pluginKey,
      previousStatus,
      newStatus: to,
    }, op);

    return result;
  }

  function emitDomain(
    event: LifecycleEventName,
    payload: PluginLifecycleEvents[LifecycleEventName],
    op?: LifecycleOp,
  ): void {
    if (!op) {
      emitter.emit(event, payload);
      return;
    }
    shared.emitAtRelease(op.lease, event, { ...payload, epoch: shared.currentEpoch(payload.pluginId), kind: op.kind });
  }

  function fence(pluginId: string, reason: string): void {
    shared.fenced.set(pluginId, reason);
    shared.quiesced.add(pluginId);
    workerManager?.revokeStarts?.(pluginId);
    log.warn({ pluginId, reason }, "plugin lifecycle: plugin fenced");
  }

  function assertNotFenced(pluginId: string, pluginKey: string): void {
    const reason = shared.fenced.get(pluginId);
    if (reason !== undefined) throw new PluginLifecycleFencedError(pluginKey, reason);
  }

  function expiryHooks(
    getPluginId: () => string | undefined,
    kind: PluginLifecycleOpKind,
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
      async expiryCleanup(lease, bodyError) {
        const pluginId = getPluginId();
        if (!pluginId) return;
        const failures: unknown[] = [];
        const stopError = await expiryStop;
        if (stopError) failures.push(stopError);
        const plugin = await registry.getById(pluginId).catch((err: unknown) => {
          failures.push(err);
          return null;
        });
        if (plugin) {
          const op: LifecycleOp = { lease, kind: "Q" };
          if (kind !== "Q" && isValidTransition(plugin.status, "error")) {
            await runOp(pluginId, "Q", { lease }, async () => {
              const teardownError = await tryDeactivatePluginRuntime(pluginId, plugin.pluginKey, op);
              if (teardownError) failures.push(teardownError);
              await transition(pluginId, "error", "lifecycle deadline expired", plugin, op);
              emitDomain("plugin.error", { pluginId, pluginKey: plugin.pluginKey, error: "lifecycle deadline expired" }, op);
            }).catch((err: unknown) => failures.push(err));
          } else {
            const teardownError = await tryDeactivatePluginRuntime(pluginId, plugin.pluginKey, op);
            if (teardownError) failures.push(teardownError);
            if (kind === "Q" && bodyError) failures.push(bodyError);
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

  function exclusive<T>(
    pluginKey: string,
    kind: PluginLifecycleOpKind,
    fn: (lease: PluginLifecycleLease) => Promise<T>,
    options?: PluginLifecycleExclusiveOptions,
  ): Promise<T> {
    const getPluginId = options?.pluginId;
    return shared.exclusive(pluginKey, kind, fn, {
      queueWaitMs: lifecycleTimings?.queueWaitMs,
      deadlineAt: options?.deadlineAt,
      ...(getPluginId ? expiryHooks(getPluginId, kind) : {}),
    });
  }

  async function runOp<T>(
    pluginId: string,
    kind: PluginLifecycleOpKind,
    options: PluginLifecycleOpOptions | undefined,
    body: (op: LifecycleOp) => Promise<T>,
  ): Promise<T> {
    const lease = options?.lease;
    if (lease) {
      if (kind === "Q") lease.assertCleanup();
      else lease.assertActive();
      const target = await requirePlugin(pluginId);
      if (target.pluginKey !== lease.pluginKey) throw new LeaseKeyMismatchError(lease.pluginKey, target.pluginKey);
      if (kind === "A") assertNotFenced(pluginId, target.pluginKey);
      return body({ lease, kind });
    }
    const plugin = await requirePlugin(pluginId);
    return exclusive(plugin.pluginKey, kind, (granted) => {
      if (kind === "A") assertNotFenced(pluginId, plugin.pluginKey);
      return body({ lease: granted, kind });
    }, { deadlineAt: options?.deadlineAt, pluginId: () => pluginId });
  }

  function beginQuiescence(pluginId: string, op: LifecycleOp): void {
    op.lease.assertCleanup();
    shared.bumpEpoch(pluginId);
    shared.quiesced.add(pluginId);
    workerManager?.revokeStarts?.(pluginId);
    shared.withdraw(pluginId);
  }

  function beginActivation(pluginId: string, op: LifecycleOp): void {
    op.lease.assertActive();
    shared.bumpEpoch(pluginId);
    shared.quiesced.delete(pluginId);
    workerManager?.allowStarts?.(pluginId);
  }

  // -----------------------------------------------------------------------
  // Worker management helpers
  // -----------------------------------------------------------------------

  /**
   * Stop the worker for a plugin if one is running.
   * This is a best-effort operation — if no worker manager is configured
   * or no worker is running, it silently succeeds.
   */
  async function stopWorkerIfRunning(
    pluginId: string,
    pluginKey: string,
    op?: LifecycleOp,
  ): Promise<void> {
    if (!workerManager?.getWorker(pluginId)) return;

    await workerManager.stopWorker(pluginId);
    log.info({ pluginId, pluginKey }, "plugin lifecycle: worker stopped");
    emitDomain("plugin.worker_stopped", { pluginId, pluginKey }, op);
  }

  async function activateReadyPlugin(pluginId: string, op: LifecycleOp): Promise<void> {
    const loader = runtimeLoader();
    if (typeof loader?.loadSingle !== "function") return;

    op.lease.assertActive();
    const loadResult = await loader.loadSingle(pluginId, { lease: op.lease });
    if (!loadResult.success) {
      throw new PluginActivationError(
        loadResult.error
        ?? `Failed to activate plugin ${loadResult.plugin.pluginKey}`,
      );
    }
  }

  async function deactivatePluginRuntime(
    pluginId: string,
    pluginKey: string,
    op: LifecycleOp,
  ): Promise<void> {
    op.lease.assertCleanup();
    const loader = runtimeLoader();
    if (typeof loader?.unloadSingle === "function") {
      await loader.unloadSingle(pluginId, pluginKey);
      return;
    }

    await stopWorkerIfRunning(pluginId, pluginKey, op);
  }

  async function tryDeactivatePluginRuntime(
    pluginId: string,
    pluginKey: string,
    op: LifecycleOp,
  ): Promise<unknown> {
    try {
      await deactivatePluginRuntime(pluginId, pluginKey, op);
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
    op: LifecycleOp,
  ): Promise<unknown> {
    const teardownError = await tryDeactivatePluginRuntime(pluginId, pluginKey, op);
    if (teardownError) {
      fence(pluginId, teardownError instanceof Error ? teardownError.message : String(teardownError));
    } else {
      shared.fenced.delete(pluginId);
    }
    return teardownError;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  return {
    // -- load -------------------------------------------------------------
    /**
     * load — Transitions a plugin to 'ready' status and starts its worker.
     *
     * This method is called after a plugin has been successfully installed and
     * validated. It marks the plugin as ready in the database and immediately
     * triggers the plugin loader to start the worker process.
     *
     * @param pluginId - The UUID of the plugin to load.
     * @returns The updated plugin record.
     */
    async load(pluginId: string, options?: PluginLoadOptions): Promise<PluginRecord> {
      return runOp(pluginId, "A", options, async (op) => {
        const plugin = await requirePlugin(pluginId);
        assertTransition(plugin, "ready");
        beginActivation(pluginId, op);
        const result = await transition(pluginId, "ready", null, plugin, op);
        if (options?.activate !== false) await activateReadyPlugin(pluginId, op);

        emitDomain("plugin.loaded", { pluginId, pluginKey: result.pluginKey }, op);
        emitDomain("plugin.enabled", { pluginId, pluginKey: result.pluginKey }, op);
        return result;
      });
    },

    // -- enable -----------------------------------------------------------
    /**
     * enable — Re-enables a plugin that was previously in an error or upgrade state.
     *
     * Similar to load(), this method transitions the plugin to 'ready' and starts
     * its worker, but it specifically targets plugins that are currently disabled.
     *
     * @param pluginId - The UUID of the plugin to enable.
     * @returns The updated plugin record.
     */
    async enable(pluginId: string, options?: PluginLifecycleOpOptions): Promise<PluginRecord> {
      return runOp(pluginId, "A", options, async (op) => {
        const plugin = await requirePlugin(pluginId);

        // Only allow enabling from disabled, error, or upgrade_pending states
        if (plugin.status !== "disabled" && plugin.status !== "error" && plugin.status !== "upgrade_pending") {
          throw invalidTransition(
            `Cannot enable plugin in status '${plugin.status}'. ` +
              `Plugin must be in 'disabled', 'error', or 'upgrade_pending' status to be enabled.`,
          );
        }

        beginActivation(pluginId, op);
        const result = await transition(pluginId, "ready", null, plugin, op);
        await activateReadyPlugin(pluginId, op);
        emitDomain("plugin.enabled", { pluginId, pluginKey: result.pluginKey }, op);
        return result;
      });
    },

    // -- disable ----------------------------------------------------------
    async disable(
      pluginId: string,
      reason?: string,
      options?: PluginLifecycleOpOptions,
    ): Promise<PluginRecord> {
      return runOp(pluginId, "Q", options, async (op) => {
        const plugin = await requirePlugin(pluginId);

        // Only allow disabling from ready state
        if (plugin.status !== "ready" && plugin.status !== "disabled") {
          throw invalidTransition(
            `Cannot disable plugin in status '${plugin.status}'. ` +
              `Plugin must be in 'ready' or 'disabled' status to be disabled.`,
          );
        }

        beginQuiescence(pluginId, op);
        const teardownError = await quiesceRuntime(pluginId, plugin.pluginKey, op);
        if (plugin.status === "disabled") {
          if (teardownError) throw new PluginTeardownError(plugin.pluginKey, teardownError);
          return plugin;
        }

        const result = await transition(pluginId, "disabled", reason ?? null, plugin, op);
        emitDomain("plugin.disabled", { pluginId, pluginKey: result.pluginKey, reason }, op);
        if (teardownError) throw new PluginTeardownError(plugin.pluginKey, teardownError);
        return result;
      });
    },

    // -- unload -----------------------------------------------------------
    async unload(
      pluginId: string,
      removeData = false,
      options?: PluginLifecycleOpOptions,
    ): Promise<PluginRecord | null> {
      return runOp(pluginId, "Q", options, async (op) => {
        const plugin = await requirePlugin(pluginId);
        beginQuiescence(pluginId, op);

        if (plugin.status === "uninstalled") {
          if (removeData) {
            await deactivatePluginRuntime(pluginId, plugin.pluginKey, op);
            await pluginLoaderInstance.cleanupInstallArtifacts(plugin);
            const deleted = await registry.uninstall(pluginId, true);
            log.info(
              { pluginId, pluginKey: plugin.pluginKey },
              "plugin lifecycle: hard-deleted already-uninstalled plugin",
            );
            emitDomain("plugin.unloaded", { pluginId, pluginKey: plugin.pluginKey, removeData: true }, op);
            return deleted as PluginRecord | null;
          }
          const teardownError = await quiesceRuntime(pluginId, plugin.pluginKey, op);
          if (teardownError) throw new PluginTeardownError(plugin.pluginKey, teardownError);
          return plugin;
        }

        const teardownError = await quiesceRuntime(pluginId, plugin.pluginKey, op);
        if (teardownError && removeData) throw teardownError;
        if (!teardownError) await pluginLoaderInstance.cleanupInstallArtifacts(plugin);

        // Perform the uninstall via registry (handles soft/hard delete)
        const result = await registry.uninstall(pluginId, removeData);

        log.info(
          { pluginId, pluginKey: plugin.pluginKey, removeData },
          `plugin lifecycle: ${plugin.status} → uninstalled${removeData ? " (hard delete)" : ""}`,
        );

        emitDomain("plugin.status_changed", {
          pluginId,
          pluginKey: plugin.pluginKey,
          previousStatus: plugin.status,
          newStatus: "uninstalled" as PluginStatus,
        }, op);
        emitDomain("plugin.unloaded", { pluginId, pluginKey: plugin.pluginKey, removeData }, op);
        if (teardownError) throw new PluginTeardownError(plugin.pluginKey, teardownError);

        return result as PluginRecord | null;
      });
    },

    // -- markError --------------------------------------------------------
    async markError(
      pluginId: string,
      error: string,
      options?: PluginLifecycleOpOptions,
    ): Promise<PluginRecord> {
      return runOp(pluginId, "Q", options, async (op) => {
        // Stop the worker — the plugin is in an error state and should not
        // continue running. The worker manager's auto-restart is disabled
        // because we are intentionally taking the plugin offline.
        const plugin = await requirePlugin(pluginId);
        beginQuiescence(pluginId, op);
        const teardownError = await quiesceRuntime(pluginId, plugin.pluginKey, op);

        const result = await transition(pluginId, "error", error, plugin, op);
        emitDomain("plugin.error", { pluginId, pluginKey: result.pluginKey, error }, op);
        if (teardownError) throw teardownError;
        return result;
      });
    },

    // -- markUpgradePending -----------------------------------------------
    async markUpgradePending(
      pluginId: string,
      options?: PluginLifecycleOpOptions,
    ): Promise<PluginRecord> {
      return runOp(pluginId, "Q", options, async (op) => {
        const plugin = await requirePlugin(pluginId);
        beginQuiescence(pluginId, op);
        await deactivatePluginRuntime(pluginId, plugin.pluginKey, op);

        const result = await transition(pluginId, "upgrade_pending", null, plugin, op);
        emitDomain("plugin.upgrade_pending", { pluginId, pluginKey: result.pluginKey }, op);
        return result;
      });
    },

    // -- upgrade ----------------------------------------------------------
    /**
     * Upgrade a plugin to a newer version by performing a package update and
     * managing the lifecycle state transition.
     *
     * Following PLUGIN_SPEC.md §25.3, the upgrade process:
     * 1. Stops the current worker process (if running).
     * 2. Fetches and validates the new plugin package via the `PluginLoader`.
     * 3. Compares the capabilities declared in the new manifest against the old one.
     * 4. If new capabilities are added, transitions the plugin to `upgrade_pending`
     *    to await operator approval (worker stays stopped).
     * 5. If no new capabilities are added, transitions the plugin back to `ready`
     *    with the updated version and manifest metadata.
     *
     * @param pluginId - The UUID of the plugin to upgrade.
     * @param version - Optional target version specifier.
     * @returns The updated `PluginRecord`.
     * @throws {BadRequest} If the plugin is not in a ready or upgrade_pending state.
     */
    async upgrade(
      pluginId: string,
      version?: string,
      options?: PluginLifecycleOpOptions,
    ): Promise<PluginRecord> {
      return runOp(pluginId, "A", options, async (op) => {
        const plugin = await requirePlugin(pluginId);

        // Can only upgrade plugins that are ready or already in upgrade_pending
        if (plugin.status !== "ready" && plugin.status !== "upgrade_pending") {
          throw invalidTransition(
            `Cannot upgrade plugin in status '${plugin.status}'. ` +
              `Plugin must be in 'ready' or 'upgrade_pending' status to be upgraded.`,
          );
        }

        log.info(
          { pluginId, pluginKey: plugin.pluginKey, targetVersion: version },
          "plugin lifecycle: upgrade requested",
        );

        const quiesce: LifecycleOp = { lease: op.lease, kind: "Q" };
        beginQuiescence(pluginId, quiesce);
        await deactivatePluginRuntime(pluginId, plugin.pluginKey, quiesce);

        // 1. Download and validate new package via loader
        const { oldManifest, newManifest, discovered } =
          await pluginLoaderInstance.upgradePlugin(pluginId, { version });

        log.info(
          {
            pluginId,
            pluginKey: plugin.pluginKey,
            oldVersion: oldManifest.version,
            newVersion: newManifest.version,
          },
          "plugin lifecycle: package upgraded on disk",
        );

        // 2. Compare capabilities
        const addedCaps = newManifest.capabilities.filter(
          (cap) => !oldManifest.capabilities.includes(cap),
        );

        // 3. Transition state
        if (addedCaps.length > 0) {
          // New capabilities require operator approval — worker stays stopped
          log.info(
            { pluginId, pluginKey: plugin.pluginKey, addedCaps },
            "plugin lifecycle: new capabilities detected, transitioning to upgrade_pending",
          );
          const result = await transition(pluginId, "upgrade_pending", null, plugin, quiesce);
          emitDomain("plugin.upgrade_pending", { pluginId, pluginKey: result.pluginKey }, quiesce);
          return result;
        }

        beginActivation(pluginId, op);
        const result = await transition(pluginId, "ready", null, {
          ...plugin,
          version: discovered.version,
          manifestJson: newManifest,
        } as PluginRecord, op);
        await activateReadyPlugin(pluginId, op);

        emitDomain("plugin.loaded", { pluginId, pluginKey: result.pluginKey }, op);
        emitDomain("plugin.enabled", { pluginId, pluginKey: result.pluginKey }, op);
        return result;
      });
    },

    // -- startWorker ------------------------------------------------------
    async startWorker(
      pluginId: string,
      options: WorkerStartOptions,
    ): Promise<void> {
      if (!workerManager) {
        throw badRequest(
          "Cannot start worker: no PluginWorkerManager is configured. " +
            "Provide a workerManager option when constructing the lifecycle manager.",
        );
      }

      const plugin = await requirePlugin(pluginId);
      if (plugin.status !== "ready") {
        throw invalidTransition(
          `Cannot start worker for plugin in status '${plugin.status}'. ` +
            `Plugin must be in 'ready' status.`,
        );
      }

      log.info(
        { pluginId, pluginKey: plugin.pluginKey },
        "plugin lifecycle: starting worker",
      );

      await workerManager.startWorker(pluginId, options);
      emitDomain("plugin.worker_started", {
        pluginId,
        pluginKey: plugin.pluginKey,
      });

      log.info(
        { pluginId, pluginKey: plugin.pluginKey },
        "plugin lifecycle: worker started",
      );
    },

    // -- stopWorker -------------------------------------------------------
    async stopWorker(pluginId: string): Promise<void> {
      if (!workerManager) return; // No worker manager — nothing to stop

      const plugin = await requirePlugin(pluginId);
      await stopWorkerIfRunning(pluginId, plugin.pluginKey);
    },

    // -- restartWorker ----------------------------------------------------
    async restartWorker(pluginId: string, options?: PluginRestartOptions): Promise<PluginRestartResult> {
      if (!workerManager) {
        throw badRequest(
          "Cannot restart worker: no PluginWorkerManager is configured.",
        );
      }

      const manager = workerManager;
      const scheduledEpoch = options?.epoch ?? shared.currentEpoch(pluginId);
      return runOp(pluginId, "R", options, async (op) => {
        const plugin = await requirePlugin(pluginId);
        const handle = manager.getWorker(pluginId);
        if (
          !shared.isCurrentGeneration(pluginId, scheduledEpoch)
          || plugin.status !== "ready"
          || !handle
        ) {
          log.info({ pluginId, source: options?.source, status: plugin.status }, "plugin lifecycle: reload superseded");
          return { superseded: true };
        }

        const loader = runtimeLoader();
        if (typeof loader?.loadSingle === "function" && typeof loader.unloadSingle === "function") {
          log.info(
            { pluginId, pluginKey: plugin.pluginKey, source: options?.source },
            "plugin lifecycle: reloading plugin (re-reading manifest, re-applying pending migrations, restarting worker)",
          );

          // Full deactivate+reactivate cycle (not just `handle.restart()`) so that:
          //   - the manifest is re-read from disk, picking up newly declared
          //     `migrations/*.sql` files and any other manifest changes,
          //   - `applyMigrations` runs idempotently against the up-to-date
          //     migrations directory — pending migrations get applied, already-
          //     applied ones are skipped via the `pluginMigrations` table,
          //   - the worker subprocess is replaced with one loading the freshly
          //     built bundle.
          //
          // Bouncing the worker process alone (`handle.restart()`) leaves plugin
          // schema out of sync with worker code whenever a hot reload adds a new
          // migration, which makes downstream queries fail against missing tables.
          await deactivatePluginRuntime(pluginId, plugin.pluginKey, op);
          await activateReadyPlugin(pluginId, op);
        } else {
          // No runtime activation services wired in (e.g. state-only test harness)
          // — fall back to a bare worker subprocess bounce.
          log.info(
            { pluginId, pluginKey: plugin.pluginKey, source: options?.source },
            "plugin lifecycle: restarting worker (runtime services unavailable; skipping migration re-apply)",
          );
          op.lease.assertActive();
          await handle.restart();
          emitDomain("plugin.worker_stopped", { pluginId, pluginKey: plugin.pluginKey }, op);
          emitDomain("plugin.worker_started", { pluginId, pluginKey: plugin.pluginKey }, op);
        }

        log.info(
          { pluginId, pluginKey: plugin.pluginKey },
          "plugin lifecycle: plugin reloaded",
        );
        return { superseded: false };
      });
    },

    exclusive,

    responseDeadline(): number {
      return Date.now() + (lifecycleTimings?.responseDeadlineMs ?? DEFAULT_PLUGIN_LIFECYCLE_RESPONSE_DEADLINE_MS);
    },

    isFenced(pluginId: string): boolean {
      return shared.fenced.has(pluginId);
    },

    currentEpoch(pluginId: string): number {
      return shared.currentEpoch(pluginId);
    },

    generationMark(): number {
      return shared.generationMark();
    },

    changedSince(pluginId: string, mark: number): boolean {
      return shared.changedSince(pluginId, mark);
    },

    isCurrentGeneration(pluginId: string, epoch: number): boolean {
      return shared.isCurrentGeneration(pluginId, epoch);
    },

    isQuiesced(pluginId: string): boolean {
      return shared.quiesced.has(pluginId);
    },

    registerWatchWithdrawer(withdraw: (pluginId: string) => void): () => void {
      return shared.registerWithdrawer(withdraw);
    },

    // -- getStatus --------------------------------------------------------
    async getStatus(pluginId: string): Promise<PluginStatus | null> {
      const plugin = await registry.getById(pluginId);
      return plugin?.status ?? null;
    },

    // -- canTransition ----------------------------------------------------
    async canTransition(pluginId: string, to: PluginStatus): Promise<boolean> {
      const plugin = await registry.getById(pluginId);
      if (!plugin) return false;
      return isValidTransition(plugin.status, to);
    },

    // -- Event subscriptions ----------------------------------------------
    on(event, listener) {
      emitter.on(event, listener);
    },

    off(event, listener) {
      emitter.off(event, listener);
    },

    once(event, listener) {
      emitter.once(event, listener);
    },
  };
}
