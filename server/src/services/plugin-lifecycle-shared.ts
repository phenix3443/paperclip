import { EventEmitter } from "node:events";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { PluginLoader } from "./plugin-loader.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

export type PluginLifecycleOpKind = "Q" | "A" | "R";

export interface PluginLifecycleTimings {
  queueWaitMs?: number;
  responseDeadlineMs?: number;
}

export const DEFAULT_PLUGIN_LIFECYCLE_QUEUE_WAIT_MS = 15_000;
export const DEFAULT_PLUGIN_LIFECYCLE_RESPONSE_DEADLINE_MS = 60_000;

export class PluginLifecycleTimeoutError extends HttpError {
  readonly code = "plugin_lifecycle_timeout";
  constructor(pluginKey: string, readonly phase: "queue" | "body" | "prepare") {
    super(504, `Plugin ${pluginKey} lifecycle operation did not finish before its response deadline`, {
      code: "plugin_lifecycle_timeout",
      phase,
    });
    this.name = "PluginLifecycleTimeoutError";
  }
}

export class PluginLifecycleFencedError extends HttpError {
  readonly code = "plugin_lifecycle_fenced";
  constructor(pluginKey: string, reason: string) {
    super(409, `Plugin ${pluginKey} is fenced until a disable or uninstall succeeds: ${reason}`, {
      code: "plugin_lifecycle_fenced",
    });
    this.name = "PluginLifecycleFencedError";
  }
}

export class LeaseExpiredError extends Error {
  constructor(pluginKey: string) {
    super(`Lifecycle lease for plugin ${pluginKey} expired at its response deadline`);
    this.name = "LeaseExpiredError";
  }
}

export class PluginLifecycleBusyError extends HttpError {
  readonly code = "plugin_lifecycle_busy";
  constructor(pluginKey: string) {
    super(409, `Plugin ${pluginKey} is busy with another lifecycle operation`, {
      code: "plugin_lifecycle_busy",
    });
    this.name = "PluginLifecycleBusyError";
  }
}

export class LeaseReleasedError extends Error {
  constructor(pluginKey: string) {
    super(`Lifecycle lease for plugin ${pluginKey} was already released`);
    this.name = "LeaseReleasedError";
  }
}

export class LeaseKeyMismatchError extends Error {
  constructor(leaseKey: string, targetKey: string) {
    super(`Lifecycle lease for plugin ${leaseKey} cannot be used for plugin ${targetKey}`);
    this.name = "LeaseKeyMismatchError";
  }
}

export interface PluginLoadOptions {
  lease?: PluginLifecycleLease;
  activate?: boolean;
  deadlineAt?: number;
}

export interface PluginRestartOptions {
  lease?: PluginLifecycleLease;
  deadlineAt?: number;
  source?: "watcher" | "config";
  epoch?: number;
}

export interface PluginRestartResult {
  superseded: boolean;
}

export interface PluginLifecycleLease {
  readonly pluginKey: string;
  readonly kind: PluginLifecycleOpKind;
  readonly released: boolean;
  readonly expired: boolean;
  assertActive(): void;
  assertCleanup(): void;
}

interface MutableLease extends PluginLifecycleLease {
  expire(): void;
  release(): void;
}

function createLease(pluginKey: string, kind: PluginLifecycleOpKind): MutableLease {
  let state: "active" | "expired" | "released" = "active";
  const assertCleanup = () => {
    if (state === "released") throw new LeaseReleasedError(pluginKey);
  };
  return {
    pluginKey,
    kind,
    get released() {
      return state === "released";
    },
    get expired() {
      return state !== "active";
    },
    assertActive() {
      assertCleanup();
      if (state === "expired") throw new LeaseExpiredError(pluginKey);
    },
    assertCleanup,
    expire() {
      if (state === "active") state = "expired";
    },
    release() {
      state = "released";
    },
  };
}

export interface PluginLifecycleRunOptions {
  queueWaitMs?: number;
  deadlineAt?: number;
  onSettled?: () => void;
  onExpire?: (lease: PluginLifecycleLease) => void;
  expiryCleanup?: (lease: PluginLifecycleLease, bodyError: unknown) => Promise<void>;
}

export interface PluginLifecycleSerializer {
  run<T>(
    pluginKey: string,
    kind: PluginLifecycleOpKind,
    fn: (lease: PluginLifecycleLease) => Promise<T>,
    options?: PluginLifecycleRunOptions,
  ): Promise<T>;
}

export function createPluginLifecycleSerializer(
  defaults: { queueWaitMs?: number } = {},
): PluginLifecycleSerializer {
  const tails = new Map<string, Promise<void>>();

  return {
    run<T>(
      pluginKey: string,
      kind: PluginLifecycleOpKind,
      fn: (lease: PluginLifecycleLease) => Promise<T>,
      options?: PluginLifecycleRunOptions,
    ): Promise<T> {
      const queueWaitMs =
        options?.queueWaitMs ?? defaults.queueWaitMs ?? DEFAULT_PLUGIN_LIFECYCLE_QUEUE_WAIT_MS;
      const deadlineAt = options?.deadlineAt;
      const remaining = () => (deadlineAt === undefined ? Infinity : deadlineAt - Date.now());
      const previous = tails.get(pluginKey) ?? Promise.resolve();
      let releaseSlot!: () => void;
      const slot = new Promise<void>((resolve) => {
        releaseSlot = resolve;
      });
      const tail = previous.then(() => slot);
      tails.set(pluginKey, tail);
      void tail.then(() => {
        if (tails.get(pluginKey) === tail) tails.delete(pluginKey);
      });

      return new Promise<T>((resolve, reject) => {
        let abandoned = false;
        const deadlineFirst = remaining() < queueWaitMs;
        const timer = setTimeout(() => {
          abandoned = true;
          reject(deadlineFirst
            ? new PluginLifecycleTimeoutError(pluginKey, "queue")
            : new PluginLifecycleBusyError(pluginKey));
        }, Math.max(0, Math.min(queueWaitMs, remaining())));
        timer.unref?.();

        void previous.then(() => {
          clearTimeout(timer);
          if (!abandoned && remaining() <= 0) {
            abandoned = true;
            reject(new PluginLifecycleTimeoutError(pluginKey, "queue"));
          }
          if (abandoned) {
            releaseSlot();
            return;
          }
          const lease = createLease(pluginKey, kind);
          let responded = false;
          const deadlineTimer = deadlineAt === undefined
            ? undefined
            : setTimeout(() => {
              if (responded) return;
              responded = true;
              lease.expire();
              try {
                options?.onExpire?.(lease);
              } catch (err) {
                logger.warn({ err, pluginKey }, "plugin lifecycle: expiry hook failed");
              }
              reject(new PluginLifecycleTimeoutError(pluginKey, "body"));
            }, remaining());
          deadlineTimer?.unref?.();
          let settled: Promise<T>;
          try {
            settled = fn(lease);
          } catch (err) {
            settled = Promise.reject(err);
          }
          const finish = async (outcome: { value?: T; error?: unknown; failed: boolean }) => {
            if (deadlineTimer) clearTimeout(deadlineTimer);
            if (lease.expired && options?.expiryCleanup) {
              try {
                await options.expiryCleanup(lease, outcome.failed ? outcome.error ?? new Error("failed") : null);
              } catch (err) {
                logger.warn({ err, pluginKey }, "plugin lifecycle: expiry cleanup failed");
              }
            }
            lease.release();
            options?.onSettled?.();
            releaseSlot();
            if (responded) return;
            responded = true;
            if (outcome.failed) reject(outcome.error);
            else resolve(outcome.value as T);
          };
          settled.then(
            (value) => finish({ value, failed: false }),
            (error: unknown) => finish({ error, failed: true }),
          );
        });
      });
    },
  };
}

export interface PluginLifecycleShared {
  readonly emitter: EventEmitter;
  readonly serializer: PluginLifecycleSerializer;
  readonly quiesced: Set<string>;
  readonly fenced: Map<string, string>;
  runtimeLoader: PluginLoader | undefined;
  registerWithdrawer(withdraw: (pluginId: string) => void): () => void;
  withdraw(pluginId: string): void;
  exclusive<T>(
    pluginKey: string,
    kind: PluginLifecycleOpKind,
    fn: (lease: PluginLifecycleLease) => Promise<T>,
    options?: Omit<PluginLifecycleRunOptions, "onSettled">,
  ): Promise<T>;
  emitAtRelease(lease: PluginLifecycleLease, event: string, payload: unknown): void;
  bumpEpoch(pluginId: string): number;
  currentEpoch(pluginId: string): number;
  isCurrentGeneration(pluginId: string, epoch: number): boolean;
  generationMark(): number;
  changedSince(pluginId: string, mark: number): boolean;
}

export function createPluginLifecycleShared(
  defaults: { queueWaitMs?: number } = {},
): PluginLifecycleShared {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);
  const epochs = new Map<string, number>();
  const lastBump = new Map<string, number>();
  const quiesced = new Set<string>();
  const fenced = new Map<string, string>();
  let bumps = 0;
  const serializer = createPluginLifecycleSerializer(defaults);
  const pendingEvents = new WeakMap<PluginLifecycleLease, Array<[string, unknown]>>();
  const withdrawers = new Set<(pluginId: string) => void>();
  return {
    emitter,
    serializer,
    quiesced,
    fenced,
    runtimeLoader: undefined,
    registerWithdrawer(withdraw) {
      withdrawers.add(withdraw);
      return () => void withdrawers.delete(withdraw);
    },
    withdraw(pluginId) {
      for (const withdraw of withdrawers) {
        try {
          withdraw(pluginId);
        } catch (err) {
          logger.warn({ err, pluginId }, "plugin lifecycle: watch withdrawer failed");
        }
      }
    },
    exclusive(pluginKey, kind, fn, options) {
      const queue: Array<[string, unknown]> = [];
      const flush = () => {
        for (const [event, payload] of queue.splice(0)) {
          try {
            emitter.emit(event, payload);
          } catch (err) {
            logger.warn({ err, event }, "plugin lifecycle: event listener failed");
          }
        }
      };
      return serializer.run(pluginKey, kind, (lease) => {
        pendingEvents.set(lease, queue);
        return fn(lease);
      }, { ...options, onSettled: flush });
    },
    emitAtRelease(lease, event, payload) {
      const queue = pendingEvents.get(lease);
      if (queue && !lease.released) queue.push([event, payload]);
      else emitter.emit(event, payload);
    },
    bumpEpoch(pluginId) {
      const next = (epochs.get(pluginId) ?? 0) + 1;
      epochs.set(pluginId, next);
      lastBump.set(pluginId, ++bumps);
      return next;
    },
    generationMark() {
      return bumps;
    },
    changedSince(pluginId, mark) {
      return (lastBump.get(pluginId) ?? 0) > mark || quiesced.has(pluginId) || fenced.has(pluginId);
    },
    currentEpoch(pluginId) {
      return epochs.get(pluginId) ?? 0;
    },
    isCurrentGeneration(pluginId, epoch) {
      return (epochs.get(pluginId) ?? 0) === epoch && !quiesced.has(pluginId) && !fenced.has(pluginId);
    },
  };
}

const sharedByWorkerManager = new WeakMap<PluginWorkerManager, PluginLifecycleShared>();

export function pluginLifecycleSharedFor(
  workerManager: PluginWorkerManager | undefined,
): PluginLifecycleShared {
  if (!workerManager) return createPluginLifecycleShared();
  let shared = sharedByWorkerManager.get(workerManager);
  if (!shared) {
    shared = createPluginLifecycleShared();
    sharedByWorkerManager.set(workerManager, shared);
  }
  return shared;
}
