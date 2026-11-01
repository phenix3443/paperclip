import { EventEmitter } from "node:events";
import { HttpError } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

export type PluginLifecycleOpKind = "Q" | "A" | "R";

export interface PluginLifecycleTimings {
  queueWaitMs?: number;
}

export const DEFAULT_PLUGIN_LIFECYCLE_QUEUE_WAIT_MS = 15_000;

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

export interface PluginLifecycleLease {
  readonly pluginKey: string;
  readonly kind: PluginLifecycleOpKind;
  readonly released: boolean;
  assertActive(): void;
  assertCleanup(): void;
}

interface MutableLease extends PluginLifecycleLease {
  release(): void;
}

function createLease(pluginKey: string, kind: PluginLifecycleOpKind): MutableLease {
  let released = false;
  const assertHeld = () => {
    if (released) throw new LeaseReleasedError(pluginKey);
  };
  return {
    pluginKey,
    kind,
    get released() {
      return released;
    },
    assertActive: assertHeld,
    assertCleanup: assertHeld,
    release() {
      released = true;
    },
  };
}

export interface PluginLifecycleSerializer {
  run<T>(
    pluginKey: string,
    kind: PluginLifecycleOpKind,
    fn: (lease: PluginLifecycleLease) => Promise<T>,
    options?: { queueWaitMs?: number; onSettled?: () => void },
  ): Promise<T>;
}

export function createPluginLifecycleSerializer(
  defaults: { queueWaitMs?: number } = {},
): PluginLifecycleSerializer {
  const tails = new Map<string, Promise<void>>();

  return {
    run(pluginKey, kind, fn, options) {
      const queueWaitMs =
        options?.queueWaitMs ?? defaults.queueWaitMs ?? DEFAULT_PLUGIN_LIFECYCLE_QUEUE_WAIT_MS;
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
        const timer = setTimeout(() => {
          abandoned = true;
          reject(new PluginLifecycleBusyError(pluginKey));
        }, queueWaitMs);
        timer.unref?.();

        void previous.then(() => {
          clearTimeout(timer);
          if (abandoned) {
            releaseSlot();
            return;
          }
          const lease = createLease(pluginKey, kind);
          let settled: Promise<T>;
          try {
            settled = fn(lease);
          } catch (err) {
            settled = Promise.reject(err);
          }
          settled.then(
            (value) => {
              lease.release();
              options?.onSettled?.();
              releaseSlot();
              resolve(value);
            },
            (err: unknown) => {
              lease.release();
              options?.onSettled?.();
              releaseSlot();
              reject(err);
            },
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
  exclusive<T>(
    pluginKey: string,
    kind: PluginLifecycleOpKind,
    fn: (lease: PluginLifecycleLease) => Promise<T>,
    queueWaitMs?: number,
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
  let bumps = 0;
  const serializer = createPluginLifecycleSerializer(defaults);
  const pendingEvents = new WeakMap<PluginLifecycleLease, Array<[string, unknown]>>();
  return {
    emitter,
    serializer,
    quiesced,
    exclusive(pluginKey, kind, fn, queueWaitMs) {
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
      }, { queueWaitMs, onSettled: flush });
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
      return (lastBump.get(pluginId) ?? 0) > mark || quiesced.has(pluginId);
    },
    currentEpoch(pluginId) {
      return epochs.get(pluginId) ?? 0;
    },
    isCurrentGeneration(pluginId, epoch) {
      return (epochs.get(pluginId) ?? 0) === epoch && !quiesced.has(pluginId);
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
