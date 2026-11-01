import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

type Row = {
  id: string;
  pluginKey: string;
  packageName: string;
  version: string;
  status: string;
  lastError: string | null;
  manifestJson: PaperclipPluginManifestV1;
};

const state = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  heldReads: [] as Array<() => void>,
  holdReads: false,
  calls: [] as string[],
  prepareHold: null as null | Promise<void>,
  afterStart: null as null | { promise: Promise<void>; reached: () => void },
  failWrite: null as null | string,
  prepareSignal: null as null | AbortSignal,
  heldWrite: null as null | { status: string; promise: Promise<void>; reached: () => void },
}));

vi.mock("../services/plugin-registry.js", async () => {
  const { conflict } = await import("../errors.js");
  const read = <T>(value: T): Promise<T> => {
    if (!state.holdReads) return Promise.resolve(value);
    return new Promise<T>((resolve) => state.heldReads.push(() => resolve(value)));
  };
  const clone = (row: Row | undefined) => (row ? { ...row } : null);
  return {
    pluginRegistryService: () => ({
      getById: (id: string) => read(clone(state.rows.get(id))),
      getByKey: async (key: string) => clone([...state.rows.values()].find((row) => row.pluginKey === key)),
      listByStatus: async (status: string) => [...state.rows.values()].filter((row) => row.status === status).map(clone),
      updateStatus: async (id: string, patch: { status: string; lastError: string | null }) => {
        const held = state.heldWrite;
        if (held && held.status === patch.status) {
          state.heldWrite = null;
          held.reached();
          await held.promise;
        }
        if (state.failWrite === patch.status) throw new Error(`row write to ${patch.status} failed`);
        const row = state.rows.get(id);
        if (!row) return null;
        Object.assign(row, patch);
        state.calls.push(`row:${row.status}`);
        return clone(row);
      },
      uninstall: async (id: string, removeData: boolean) => {
        const row = state.rows.get(id);
        if (!row) return null;
        if (removeData) state.rows.delete(id);
        else row.status = "uninstalled";
        state.calls.push(`row:uninstalled`);
        return clone(row);
      },
      install: async (input: { packageName: string }, manifest: PaperclipPluginManifestV1) => {
        const existing = [...state.rows.values()].find((row) => row.pluginKey === manifest.id);
        if (existing && existing.status !== "uninstalled") {
          throw conflict(`Plugin already installed: ${manifest.id}`, { code: "already_installed" });
        }
        const row: Row = existing ?? {
          id: `id-${manifest.id}`,
          pluginKey: manifest.id,
          packageName: input.packageName,
          version: manifest.version,
          status: "installed",
          lastError: null,
          manifestJson: manifest,
        };
        Object.assign(row, { status: "installed", version: manifest.version, manifestJson: manifest, lastError: null });
        state.rows.set(row.id, row);
        state.calls.push("row:installed");
        return clone(row);
      },
    }),
  };
});

vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));

const { pluginRoutes } = await import("../routes/plugins.js");
const { errorHandler } = await import("../middleware/index.js");
const { pluginLifecycleManager } = await import("../services/plugin-lifecycle.js");
class MissingSeam extends Error {}
const sharedModule: Record<string, unknown> = await import("../services/plugin-lifecycle-shared.js").catch(() => ({}));
const workerModule: Record<string, unknown> = await import("../services/plugin-worker-manager.js");
const LeaseExpiredError = (sharedModule.LeaseExpiredError ?? MissingSeam) as typeof Error;
const LeaseReleasedError = (sharedModule.LeaseReleasedError ?? MissingSeam) as typeof Error;
const PluginWorkerStopError = (workerModule.PluginWorkerStopError
  ?? class extends Error {
    constructor(pluginId: string) {
      super(`Worker for plugin "${pluginId}" is still alive after SIGKILL`);
    }
  }) as new (pluginId: string, pid?: number) => Error;
const { createPluginWorkerManager } = await import("../services/plugin-worker-manager.js");
const { createPluginToolDispatcher } = await import("../services/plugin-tool-dispatcher.js");
const { createPluginJobCoordinator } = await import("../services/plugin-job-coordinator.js");

const GATED_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "plugin-worker-gated.cjs");

function manifest(id: string, version = "1.0.0"): PaperclipPluginManifestV1 {
  return {
    id,
    apiVersion: 1,
    version,
    displayName: id,
    description: id,
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["agent.tools.register"],
    entrypoints: { worker: "dist/worker.js" },
    tools: [{ name: "echo", displayName: "Echo", description: "Echo", parametersSchema: { type: "object" } }],
  } as PaperclipPluginManifestV1;
}

type GateEvent = { event: string; pid: number };

async function createGate() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "plugin-deadline-"));
  const socketPath = path.join(dir, "gate.sock");
  const sockets: net.Socket[] = [];
  const events: GateEvent[] = [];
  const waiters: Array<{ name: string; seen: number; resolve: () => void }> = [];
  const notify = () => {
    for (const waiter of [...waiters]) {
      if (events.filter((e) => e.event === waiter.name).length > waiter.seen) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve();
      }
    }
  };
  const server = net.createServer((socket) => {
    sockets.push(socket);
    const lines = readline.createInterface({ input: socket });
    lines.on("error", () => undefined);
    lines.on("line", (line) => {
      events.push(JSON.parse(line) as GateEvent);
      notify();
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    events,
    next(name: string, seen = 0) {
      return new Promise<void>((resolve) => {
        waiters.push({ name, seen, resolve });
        notify();
      });
    },
    crash() {
      for (const socket of sockets) if (!socket.destroyed) socket.write(`${JSON.stringify({ crash: true })}\n`);
    },
    release(name: string) {
      for (const socket of sockets) if (!socket.destroyed) socket.write(`${JSON.stringify({ release: name })}\n`);
    },
    count(name: string) {
      return events.filter((e) => e.event === name).length;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

async function createHarness(options: { hold?: string; queueWaitMs?: number; responseDeadlineMs?: number; failActivation?: boolean } = {}) {
  const gate = await createGate();
  const workerManager = createPluginWorkerManager();
  const appLifecycle = pluginLifecycleManager({} as never, { workerManager });
  const scheduler = {
    registerPlugin: vi.fn(async (id: string) => void state.calls.push(`scheduler:register:${id}`)),
    unregisterPlugin: vi.fn(async (id: string) => void state.calls.push(`scheduler:unregister:${id}`)),
  };
  const jobStore = {
    syncJobDeclarations: vi.fn(async (id: string) => void state.calls.push(`jobs:sync:${id}`)),
    deleteAllJobs: vi.fn(async () => undefined),
  };
  const subscriberReads: Array<() => void> = [];
  const startHold = () => {
    state.holdReads = true;
  };
  const stopHold = () => {
    state.holdReads = false;
    subscriberReads.push(...state.heldReads.splice(0));
  };
  appLifecycle.on("plugin.enabled", startHold);
  appLifecycle.on("plugin.loaded", startHold);
  const toolDispatcher = createPluginToolDispatcher({ workerManager, lifecycleManager: appLifecycle, db: {} as never });
  await toolDispatcher.initialize();
  const jobCoordinator = createPluginJobCoordinator({
    db: {} as never,
    lifecycle: appLifecycle,
    scheduler: scheduler as never,
    jobStore: jobStore as never,
  });
  jobCoordinator.start();
  appLifecycle.on("plugin.enabled", stopHold);
  appLifecycle.on("plugin.loaded", stopHold);

  const env = (hold: string) => ({ GATE_SOCKET: gate.socketPath, GATE_HOLD: hold });
  let hold = options.hold ?? "";
  let failActivation = options.failActivation ?? false;
  const loader = {
    hasRuntimeServices: () => true,
    async loadSingle(id: string, loadOptions?: { lease?: { assertActive(): void } }) {
      const row = state.rows.get(id)!;
      if (row.status === "installed") {
        await appLifecycle.load(id, { lease: loadOptions?.lease } as never);
        return { plugin: { ...row }, success: true, registered: {} };
      }
      try {
        if (failActivation) throw new Error("activation exploded");
        await workerManager.startWorker(id, {
          entrypointPath: GATED_WORKER,
          manifest: row.manifestJson,
          config: {},
          instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
          apiVersion: 1,
          hostHandlers: {},
          env: env(hold),
        } as never);
        state.calls.push(`worker:running:${id}`);
        const afterStart = state.afterStart;
        if (afterStart) {
          state.afterStart = null;
          afterStart.reached();
          await afterStart.promise;
        }
        loadOptions?.lease?.assertActive();
        await jobStore.syncJobDeclarations(id);
        await scheduler.registerPlugin(id);
        loadOptions?.lease?.assertActive();
        toolDispatcher.registerPluginTools(row.pluginKey, row.manifestJson, id);
        state.calls.push(`tools:register:${row.pluginKey}`);
        return { plugin: { ...row }, success: true, registered: {} };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await appLifecycle.markError(id, `Activation failed: ${message}`, { lease: loadOptions?.lease } as never);
        return { plugin: { ...row }, success: false, error: message, registered: {} };
      }
    },
    async unloadSingle(id: string, pluginKey: string) {
      const failures: unknown[] = [];
      await scheduler.unregisterPlugin(id).catch((err: unknown) => void failures.push(err));
      toolDispatcher.unregisterPluginTools(pluginKey);
      state.calls.push(`tools:unregister:${pluginKey}`);
      if (workerManager.getWorker(id)) {
        state.calls.push(`worker:stop:${id}`);
        await workerManager.stopWorker(id).catch((err: unknown) => void failures.push(err));
      }
      if (failures.length > 0) throw new AggregateError(failures, failures.map((f) => String(f)).join("; "));
    },
    async cleanupInstallArtifacts() {},
    async prepareInstall(installOptions: { packageName: string; signal?: AbortSignal }) {
      if (state.prepareHold) {
        state.prepareSignal = installOptions.signal ?? null;
        await state.prepareHold;
      }
      return { manifest: manifest(installOptions.packageName), packageName: installOptions.packageName, version: "1.0.0" };
    },
    async persistInstall(discovered: { manifest: PaperclipPluginManifestV1; packageName: string }) {
      state.calls.push(`persist:${discovered.manifest.id}`);
      const { pluginRegistryService } = await import("../services/plugin-registry.js");
      await pluginRegistryService({} as never).install({ packageName: discovered.packageName } as never, discovered.manifest);
      return discovered;
    },
    async installPlugin(installOptions: { packageName: string }) {
      return this.persistInstall(await this.prepareInstall(installOptions));
    },
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "admin", source: "session", isInstanceAdmin: true, companyIds: [] } as never;
    next();
  });
  app.use("/api", pluginRoutes(
    {} as never,
    loader as never,
    undefined,
    undefined,
    undefined,
    { workerManager } as never,
    undefined,
    { lifecycleTimings: { queueWaitMs: options.queueWaitMs ?? 15_000, responseDeadlineMs: options.responseDeadlineMs } } as never,
  ));
  app.use(errorHandler);

  return {
    app,
    loader,
    scheduler,
    gate,
    workerManager,
    appLifecycle,
    toolDispatcher,
    subscriberReads,
    setHold(next: string) {
      hold = next;
    },
    setFailActivation(next: boolean) {
      failActivation = next;
    },
    async close() {
      jobCoordinator.stop();
      toolDispatcher.teardown();
      await workerManager.stopAll().catch(() => undefined);
      await gate.close();
    },
  };
}

function seed(key: string, status: string) {
  const row: Row = {
    id: `id-${key}`,
    pluginKey: key,
    packageName: key,
    version: "1.0.0",
    status,
    lastError: null,
    manifestJson: manifest(key),
  };
  state.rows.set(row.id, row);
  return row;
}

let harness: Harness | undefined;

beforeEach(() => {
  state.rows.clear();
  state.heldReads.splice(0);
  state.holdReads = false;
  state.calls.splice(0);
  state.heldWrite = null;
  state.prepareHold = null;
  state.prepareSignal = null;
  state.afterStart = null;
  state.failWrite = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function holdAfterStart() {
  let release!: () => void;
  let reached!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  state.afterStart = { promise, reached };
  return { release, arrived };
}

function nextHandleEvent(harness: Harness, id: string, name: "crash" | "ready" | "exit") {
  return new Promise<void>((resolve) => harness.workerManager.getWorker(id)!.on(name as never, () => resolve()));
}

function holdStatusWrite(status: string) {
  let release!: () => void;
  let reached!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  const arrived = new Promise<void>((resolve) => {
    reached = resolve;
  });
  state.heldWrite = { status, promise, reached };
  return { release, arrived };
}

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function within<T>(promise: Promise<T>, ms: number): Promise<T | "pending"> {
  let timer: NodeJS.Timeout | undefined;
  const pending = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), ms);
  });
  try {
    return await Promise.race([promise, pending]);
  } finally {
    clearTimeout(timer);
  }
}

describe("plugin lifecycle response deadlines through the real route wiring", () => {
  it("N22: a Q that waits behind held work answers 200, then an A held in initialize answers 504 at its own deadline and settles to error", async () => {
    harness = await createHarness({ hold: "initialize", queueWaitMs: 400, responseDeadlineMs: 800 });
    const row = seed("deadline.a", "disabled");

    const firstEnable = request(harness.app).post(`/api/plugins/${row.pluginKey}/enable`).send({}).then((r) => r);
    await harness.gate.next("initialize-received");
    const disable = request(harness.app).post(`/api/plugins/${row.pluginKey}/disable`).send({}).then((r) => r);
    harness.gate.release("initialize");
    expect((await firstEnable).status).toBe(200);
    const q = await disable;
    expect(q.status).toBe(200);
    expect(harness.workerManager.getWorker(row.id)).toBeUndefined();

    const startedAt = Date.now();
    const seen = harness.gate.count("initialize-received");
    const enable = request(harness.app).post(`/api/plugins/${row.pluginKey}/enable`).send({}).then((r) => r);
    await harness.gate.next("initialize-received", seen);
    const a = await enable;
    const elapsed = Date.now() - startedAt;
    expect(a.status).toBe(504);
    expect(a.body).toMatchObject({ code: "plugin_lifecycle_timeout", phase: "body" });
    expect(elapsed).toBeGreaterThanOrEqual(750);
    expect(elapsed).toBeLessThan(800 + 1_000);

    const del = await request(harness.app).delete(`/api/plugins/${row.pluginKey}`);
    expect(del.status).toBe(200);
    expect(state.calls).toContain("row:error");
    expect(harness.workerManager.getWorker(row.id)).toBeUndefined();
    expect(state.rows.get(row.id)!.status).toBe("uninstalled");

    harness.setHold("");
    const install = await request(harness.app).post("/api/plugins/install").send({ packageName: row.pluginKey });
    expect(install.status).toBe(200);
    expect(harness.workerManager.getWorker(row.id)?.status).toBe("running");
    expect(state.rows.get(row.id)!.id).toBe(row.id);
  });

  it("N17b: a ready row write held past the deadline lands, then cleanup writes error and no worker is ever started", async () => {
    harness = await createHarness({ responseDeadlineMs: 300 });
    const row = seed("deadline.b", "disabled");
    const write = holdStatusWrite("ready");
    const startWorker = vi.spyOn(harness.workerManager, "startWorker");

    const enable = request(harness.app).post(`/api/plugins/${row.pluginKey}/enable`).send({}).then((r) => r);
    await write.arrived;
    const res = await enable;
    expect(res.status).toBe(504);
    expect(res.body.code).toBe("plugin_lifecycle_timeout");

    const del = request(harness.app).delete(`/api/plugins/${row.pluginKey}`).then((r) => r);
    expect(await within(del, 200)).toBe("pending");
    write.release();
    expect((await del).status).toBe(200);

    const rowWrites = state.calls.filter((call) => call.startsWith("row:"));
    expect(rowWrites).toEqual(["row:ready", "row:error", "row:uninstalled"]);
    expect(startWorker).not.toHaveBeenCalled();
    expect(harness.gate.count("spawned")).toBe(0);
    expect(harness.workerManager.getWorker(row.id)).toBeUndefined();
  });

  it("N17d: while settlement holds the key a second write gets 409 busy with no effect, and another key completes", async () => {
    harness = await createHarness({ responseDeadlineMs: 300, queueWaitMs: 200 });
    const row = seed("deadline.d", "disabled");
    const other = seed("deadline.e", "ready");
    const write = holdStatusWrite("ready");

    const enable = request(harness.app).post(`/api/plugins/${row.pluginKey}/enable`).send({}).then((r) => r);
    await write.arrived;
    expect((await enable).status).toBe(504);

    const callsBefore = state.calls.length;
    const second = await request(harness.app).post(`/api/plugins/${row.pluginKey}/disable`).send({});
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("plugin_lifecycle_busy");
    expect(state.calls.slice(callsBefore)).toEqual([]);

    const otherRes = await request(harness.app).post(`/api/plugins/${other.pluginKey}/disable`).send({});
    expect(otherRes.status).toBe(200);

    write.release();
    const recovered = await request(harness.app).delete(`/api/plugins/${row.pluginKey}`);
    expect(recovered.status).toBe(200);
    expect(harness.workerManager.getWorker(row.id)).toBeUndefined();
  });

  it("N21: a prepare held past the deadline answers 504 phase prepare, aborts, and its late result writes nothing", async () => {
    harness = await createHarness({ responseDeadlineMs: 300 });
    const other = seed("deadline.g", "ready");
    let releasePrepare!: () => void;
    state.prepareHold = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });

    const install = request(harness.app).post("/api/plugins/install").send({ packageName: "deadline.f" }).then((r) => r);
    const otherRes = await request(harness.app).post(`/api/plugins/${other.pluginKey}/disable`).send({});
    expect(otherRes.status).toBe(200);
    const res = await install;
    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({ code: "plugin_lifecycle_timeout", phase: "prepare" });
    expect(state.prepareSignal?.aborted).toBe(true);

    state.prepareHold = null;
    releasePrepare();
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.calls).not.toContain("persist:deadline.f");
    expect([...state.rows.values()].some((r) => r.pluginKey === "deadline.f")).toBe(false);
  });

  it("N20b: an expired lease runs markError inline, cannot activate, and after release can do neither", async () => {
    harness = await createHarness({ responseDeadlineMs: 300 });
    const row = seed("deadline.h", "disabled");
    let captured: unknown;
    let releaseLoad!: () => void;
    const loadHeld = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    let loadReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      loadReached = resolve;
    });
    vi.spyOn(harness.loader, "loadSingle").mockImplementation(async (_id: string, options?: { lease?: unknown }) => {
      captured = options?.lease;
      loadReached();
      await loadHeld;
      return { plugin: { ...state.rows.get(row.id)! }, success: true, registered: {} } as never;
    });

    const enable = request(harness.app).post(`/api/plugins/${row.pluginKey}/enable`).send({}).then((r) => r);
    await reached;
    expect((await enable).status).toBe(504);

    const lease = { lease: captured } as never;
    const marked = await within(harness.appLifecycle.markError(row.id, "expired lease cleanup", lease), 2_000);
    expect(marked).not.toBe("pending");
    expect(state.rows.get(row.id)!.status).toBe("error");
    await expect(harness.appLifecycle.enable(row.id, lease)).rejects.toBeInstanceOf(LeaseExpiredError);
    await expect(harness.appLifecycle.load(row.id, lease)).rejects.toBeInstanceOf(LeaseExpiredError);

    releaseLoad();
    const settled = await request(harness.app).delete(`/api/plugins/${row.pluginKey}`);
    expect(settled.status).toBe(200);
    await expect(harness.appLifecycle.markError(row.id, "late", lease)).rejects.toBeInstanceOf(LeaseReleasedError);
    await expect(harness.appLifecycle.enable(row.id, lease)).rejects.toBeInstanceOf(LeaseReleasedError);
    expect(harness.gate.count("spawned")).toBe(0);
  });


  it("N13: a stop that is not proven answers 500, keeps the handle, fences enable, and a later disable clears the fence", async () => {
    harness = await createHarness();
    const row = seed("deadline.i", "disabled");
    expect((await request(harness.app).post(`/api/plugins/${row.pluginKey}/enable`).send({})).status).toBe(200);
    const pid = harness.workerManager.getWorker(row.id)!.diagnostics().pid;
    const stop = vi.spyOn(harness.workerManager, "stopWorker").mockRejectedValueOnce(new PluginWorkerStopError(row.id, pid ?? undefined));

    const failed = await request(harness.app).post(`/api/plugins/${row.pluginKey}/disable`).send({});
    expect(failed.status).toBe(500);
    expect(failed.body.code).toBe("plugin_quiescence_failed");
    expect(harness.workerManager.getWorker(row.id)).toBeDefined();
    expect(state.rows.get(row.id)!.status).toBe("disabled");
    expect(harness.appLifecycle.isFenced(row.id)).toBe(true);

    const fenced = await request(harness.app).post(`/api/plugins/${row.pluginKey}/enable`).send({});
    expect(fenced.status).toBe(409);
    expect(fenced.body.code).toBe("plugin_lifecycle_fenced");
    expect(state.rows.get(row.id)!.status).toBe("disabled");

    stop.mockRestore();
    const retried = await request(harness.app).post(`/api/plugins/${row.pluginKey}/disable`).send({});
    expect(retried.status).toBe(200);
    expect(harness.workerManager.getWorker(row.id)).toBeUndefined();
    expect(harness.appLifecycle.isFenced(row.id)).toBe(false);
    expect((await request(harness.app).post(`/api/plugins/${row.pluginKey}/enable`).send({})).status).toBe(200);
  });

  it("N7d: a scheduler unregister failure still stops the worker, answers 500 quiescence failed, and a fixed retry clears the fence", async () => {
    harness = await createHarness();
    const row = seed("deadline.j", "disabled");
    expect((await request(harness.app).post(`/api/plugins/${row.pluginKey}/enable`).send({})).status).toBe(200);
    harness.scheduler.unregisterPlugin.mockRejectedValueOnce(new Error("scheduler unavailable"));
    const callsBefore = state.calls.length;

    const failed = await request(harness.app).post(`/api/plugins/${row.pluginKey}/disable`).send({});
    expect(failed.status).toBe(500);
    expect(failed.body.code).toBe("plugin_quiescence_failed");
    expect(failed.body.error).toContain("scheduler unavailable");
    expect(state.calls.slice(callsBefore)).toContain(`worker:stop:${row.id}`);
    expect(harness.workerManager.getWorker(row.id)).toBeUndefined();
    expect(harness.appLifecycle.isFenced(row.id)).toBe(true);

    const retried = await request(harness.app).post(`/api/plugins/${row.pluginKey}/disable`).send({});
    expect(retried.status).toBe(200);
    expect(harness.appLifecycle.isFenced(row.id)).toBe(false);
  });


  it("N17a: a post-initialize step held past the deadline answers 504, registers nothing after release, and settles to error", async () => {
    harness = await createHarness({ responseDeadlineMs: 300 });
    const row = seed("deadline.k", "disabled");
    const held = holdAfterStart();

    const enable = request(harness.app).post(`/api/plugins/${row.pluginKey}/enable`).send({}).then((r) => r);
    await held.arrived;
    const res = await enable;
    expect(res.status).toBe(504);
    expect(res.body.code).toBe("plugin_lifecycle_timeout");

    const callsBefore = state.calls.length;
    const del = request(harness.app).delete(`/api/plugins/${row.pluginKey}`).then((r) => r);
    expect(await within(del, 200)).toBe("pending");
    held.release();
    expect((await del).status).toBe(200);
    const after = state.calls.slice(callsBefore);
    expect(after.filter((call) => /^(jobs:sync|scheduler:register|tools:register)/.test(call))).toEqual([]);
    expect(after).toContain("row:error");
    expect(harness.workerManager.getWorker(row.id)).toBeUndefined();

    const install = await request(harness.app).post("/api/plugins/install").send({ packageName: row.pluginKey });
    expect(install.status).toBe(200);
    expect(state.rows.get(row.id)!.id).toBe(row.id);
    expect(harness.workerManager.getWorker(row.id)?.status).toBe("running");
  });

  it("N17c: when expiry cleanup cannot stop the worker or write error, the plugin is fenced until a later disable succeeds", async () => {
    harness = await createHarness({ responseDeadlineMs: 300 });
    const row = seed("deadline.l", "disabled");
    const held = holdAfterStart();
    const stop = vi.spyOn(harness.workerManager, "stopWorker").mockRejectedValue(new PluginWorkerStopError(row.id, undefined));
    state.failWrite = "error";

    const enable = request(harness.app).post(`/api/plugins/${row.pluginKey}/enable`).send({}).then((r) => r);
    await held.arrived;
    expect((await enable).status).toBe(504);
    held.release();
    const blocked = await request(harness.app).post(`/api/plugins/${row.pluginKey}/enable`).send({});
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("plugin_lifecycle_fenced");
    expect(state.rows.get(row.id)!.status).toBe("ready");
    expect(harness.appLifecycle.isFenced(row.id)).toBe(true);
    expect(harness.appLifecycle.isQuiesced(row.id)).toBe(true);
    expect(harness.workerManager.getWorker(row.id)).toBeDefined();
    const reload = await harness.appLifecycle.restartWorker(row.id, {
      source: "watcher",
      epoch: harness.appLifecycle.currentEpoch(row.id),
    });
    expect(reload).toEqual({ superseded: true });

    stop.mockRestore();
    state.failWrite = null;
    const disable = await request(harness.app).post(`/api/plugins/${row.pluginKey}/disable`).send({});
    expect(disable.status).toBe(200);
    expect(harness.appLifecycle.isFenced(row.id)).toBe(false);
    expect(harness.workerManager.getWorker(row.id)).toBeUndefined();
  });

  it("N7b: a pending crash backoff cannot spawn while a stuck disable answers 504, and cleanup leaves no handle", async () => {
    harness = await createHarness({ responseDeadlineMs: 300 });
    const row = seed("deadline.m", "disabled");
    expect((await request(harness.app).post(`/api/plugins/${row.pluginKey}/enable`).send({})).status).toBe(200);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const crashed = nextHandleEvent(harness, row.id, "crash");
    harness.gate.crash();
    await crashed;
    expect(harness.workerManager.getWorker(row.id)?.status).toBe("backoff");
    const spawned = harness.gate.count("spawned");
    const statuses: string[] = [];
    harness.workerManager.getWorker(row.id)!.on("ready" as never, () => void statuses.push("ready"));
    const write = holdStatusWrite("disabled");

    const disable = request(harness.app).post(`/api/plugins/${row.pluginKey}/disable`).send({}).then((r) => r);
    await write.arrived;
    await vi.advanceTimersByTimeAsync(300);
    const res = await disable;
    expect(res.status).toBe(504);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.gate.count("spawned")).toBe(spawned);
    expect(statuses).toEqual([]);

    write.release();
    vi.useRealTimers();
    const del = await request(harness.app).delete(`/api/plugins/${row.pluginKey}`);
    expect(del.status).toBe(200);
    expect(harness.workerManager.getWorker(row.id)).toBeUndefined();
    expect(harness.gate.count("spawned")).toBe(spawned);
  });

  it("N7c: an in-flight crash retry cannot publish running after a stuck disable answers 504", async () => {
    harness = await createHarness({ hold: "initialize", responseDeadlineMs: 300 });
    const row = seed("deadline.n", "disabled");
    const enable = request(harness.app).post(`/api/plugins/${row.pluginKey}/enable`).send({}).then((r) => r);
    await harness.gate.next("initialize-received");
    harness.gate.release("initialize");
    expect((await enable).status).toBe(200);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const crashed = nextHandleEvent(harness, row.id, "crash");
    harness.gate.crash();
    await crashed;
    const seen = harness.gate.count("initialize-received");
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();
    await harness.gate.next("initialize-received", seen);
    const spawned = harness.gate.count("spawned");
    const write = holdStatusWrite("disabled");

    const disable = request(harness.app).post(`/api/plugins/${row.pluginKey}/disable`).send({}).then((r) => r);
    await write.arrived;
    const res = await disable;
    expect(res.status).toBe(504);
    harness.gate.release("initialize");
    write.release();
    const del = await request(harness.app).delete(`/api/plugins/${row.pluginKey}`);
    expect(del.status).toBe(200);
    expect(harness.workerManager.getWorker(row.id)).toBeUndefined();
    expect(harness.gate.count("spawned")).toBe(spawned);
    expect(harness.gate.count("initialize-replied")).toBe(1);
  });


  it("N13: the exit of a fenced worker clears the fence for the next operation without reporting Q", async () => {
    harness = await createHarness();
    const row = seed("deadline.o", "disabled");
    expect((await request(harness.app).post(`/api/plugins/${row.pluginKey}/enable`).send({})).status).toBe(200);
    const pid = harness.workerManager.getWorker(row.id)!.diagnostics().pid!;
    vi.spyOn(harness.workerManager, "stopWorker").mockRejectedValueOnce(new PluginWorkerStopError(row.id, pid));

    expect((await request(harness.app).post(`/api/plugins/${row.pluginKey}/disable`).send({})).status).toBe(500);
    expect(harness.appLifecycle.isFenced(row.id)).toBe(true);
    const exited = nextHandleEvent(harness, row.id, "exit");
    process.kill(pid, "SIGKILL");
    await exited;
    expect(harness.appLifecycle.isFenced(row.id)).toBe(false);
    expect(harness.appLifecycle.isQuiesced(row.id)).toBe(true);
  });

});
