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
  const dir = mkdtempSync(path.join(os.tmpdir(), "plugin-serial-"));
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

async function createHarness(options: { hold?: string; queueWaitMs?: number; failActivation?: boolean } = {}) {
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
    async loadSingle(id: string, loadOptions?: { lease?: unknown }) {
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
        await jobStore.syncJobDeclarations(id);
        await scheduler.registerPlugin(id);
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
      await scheduler.unregisterPlugin(id);
      toolDispatcher.unregisterPluginTools(pluginKey);
      state.calls.push(`tools:unregister:${pluginKey}`);
      if (workerManager.getWorker(id)) await workerManager.stopWorker(id);
    },
    async cleanupInstallArtifacts() {},
    async prepareInstall(installOptions: { packageName: string }) {
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
    { lifecycleTimings: { queueWaitMs: options.queueWaitMs ?? 15_000 } } as never,
  ));
  app.use(errorHandler);

  return {
    app,
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
});

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

describe("plugin lifecycle serialization through the real route wiring", () => {
  it("N4a: route lifecycle events reach subscribers of the app lifecycle", async () => {
    harness = await createHarness();
    const row = seed("serial.a", "ready");
    const disabled = vi.fn();
    harness.appLifecycle.on("plugin.disabled", disabled);

    const res = await request(harness.app).post(`/api/plugins/${row.pluginKey}/disable`).send({});

    expect(res.status).toBe(200);
    expect(disabled).toHaveBeenCalledTimes(1);
    expect(disabled.mock.calls[0]![0]).toMatchObject({ pluginId: row.id, pluginKey: "serial.a" });
  });

  it("N4b: subscriber reads held across a disable cannot register tools, jobs or the scheduler again", async () => {
    harness = await createHarness();
    const row = seed("serial.b", "disabled");

    await harness.appLifecycle.enable(row.id);
    await harness.appLifecycle.disable(row.id);
    const afterQ = state.calls.length;

    for (const release of harness.subscriberReads.splice(0)) release();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(harness.toolDispatcher.toolCount("serial.b")).toBe(0);
    expect(state.calls.slice(afterQ)).toEqual([]);
    expect(harness.workerManager.getWorker(row.id)).toBeUndefined();
  });

  it("N5: a DELETE during a gated enable waits for it, then stops it; install starts exactly one new process", async () => {
    harness = await createHarness({ hold: "initialize" });
    const row = seed("serial.c", "disabled");

    const enable = request(harness.app).post(`/api/plugins/${row.pluginKey}/enable`).send({}).then((r) => r);
    await harness.gate.next("initialize-received");
    const del = request(harness.app).delete(`/api/plugins/${row.pluginKey}`).then((r) => r);
    expect(await within(del, 200)).toBe("pending");

    harness.gate.release("initialize");
    expect((await enable).status).toBe(200);
    expect((await del).status).toBe(200);
    expect(harness.workerManager.getWorker(row.id)).toBeUndefined();
    expect(state.rows.get(row.id)!.status).toBe("uninstalled");

    harness.setHold("");
    const spawnedBefore = harness.gate.count("spawned");
    const install = await request(harness.app).post("/api/plugins/install").send({ packageName: "serial.c" });
    expect(install.status).toBe(200);
    expect(harness.gate.count("spawned") - spawnedBefore).toBe(1);
    expect(harness.workerManager.getWorker(row.id)?.status).toBe("running");
    expect(state.rows.get(row.id)!.id).toBe(row.id);
  });

  it("N9: soft DELETE then install of a newer package keeps the row and answers after activation", async () => {
    harness = await createHarness();
    const row = seed("serial.d", "ready");

    expect((await request(harness.app).delete(`/api/plugins/${row.pluginKey}`)).status).toBe(200);
    const install = await request(harness.app).post("/api/plugins/install").send({ packageName: "serial.d" });

    expect(install.status).toBe(200);
    expect(install.body.id).toBe(row.id);
    expect(state.rows.get(row.id)!.status).toBe("ready");
    expect(harness.workerManager.getWorker(row.id)?.status).toBe("running");
  });

  it("N10: two concurrent first installs of one key produce one 200 and one 409 already_installed", async () => {
    harness = await createHarness();

    const [first, second] = await Promise.all([
      request(harness.app).post("/api/plugins/install").send({ packageName: "serial.e" }),
      request(harness.app).post("/api/plugins/install").send({ packageName: "serial.e" }),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    expect(loser.body.code).toBe("already_installed");
    expect(harness.gate.count("spawned")).toBe(1);
    const persists = state.calls.flatMap((call, index) => (call === "persist:serial.e" ? [index] : []));
    expect(persists).toHaveLength(2);
    expect(persists[1]).toBeGreaterThan(state.calls.indexOf("worker:running:id-serial.e"));
  });

  it("N14: a client that drops its DELETE mid-teardown does not stop the server, and a repeated soft DELETE is a 200", async () => {
    harness = await createHarness({ hold: "shutdown" });
    const row = seed("serial.f", "disabled");
    expect((await request(harness.app).post(`/api/plugins/${row.pluginKey}/enable`).send({})).status).toBe(200);

    const dropped = request(harness.app).delete(`/api/plugins/${row.pluginKey}`);
    const settled = dropped.then(() => "answered", () => "dropped");
    await harness.gate.next("shutdown-received");
    dropped.abort();
    expect(await settled).toBe("dropped");
    harness.gate.release("shutdown");
    await harness.gate.next("shutdown-replied");
    for (let i = 0; i < 200 && state.rows.get(row.id)!.status !== "uninstalled"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(state.rows.get(row.id)!.status).toBe("uninstalled");

    const again = await request(harness.app).delete(`/api/plugins/${row.pluginKey}`);
    expect(again.status).toBe(200);
    expect(state.rows.get(row.id)!.status).toBe("uninstalled");
    expect(harness.workerManager.getWorker(row.id)).toBeUndefined();
  });

  it("N15: disable on disabled and soft DELETE on uninstalled stop a stray worker and answer 200", async () => {
    harness = await createHarness();
    const startStray = async (row: Row) => {
      harness!.workerManager.allowStarts?.(row.id);
      await harness!.workerManager.startWorker(row.id, {
        entrypointPath: GATED_WORKER,
        manifest: row.manifestJson,
        config: {},
        instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
        apiVersion: 1,
        hostHandlers: {},
        env: { GATE_SOCKET: harness!.gate.socketPath, GATE_HOLD: "" },
      } as never);
    };

    const disabledRow = seed("serial.g", "disabled");
    await startStray(disabledRow);
    const disable = await request(harness.app).post(`/api/plugins/${disabledRow.pluginKey}/disable`).send({});
    expect(disable.status).toBe(200);
    expect(harness.workerManager.getWorker(disabledRow.id)).toBeUndefined();

    const uninstalledRow = seed("serial.h", "uninstalled");
    await startStray(uninstalledRow);
    const del = await request(harness.app).delete(`/api/plugins/${uninstalledRow.pluginKey}`);
    expect(del.status).toBe(200);
    expect(harness.workerManager.getWorker(uninstalledRow.id)).toBeUndefined();
  });

  it("N16: a write that cannot get the plugin within queueWaitMs gets 409 plugin_lifecycle_busy and has no effect", async () => {
    harness = await createHarness({ hold: "initialize", queueWaitMs: 100 });
    const row = seed("serial.i", "disabled");

    const enable = request(harness.app).post(`/api/plugins/${row.pluginKey}/enable`).send({}).then((r) => r);
    await harness.gate.next("initialize-received");
    const callsBefore = state.calls.length;
    const disable = request(harness.app).post(`/api/plugins/${row.pluginKey}/disable`).send({}).then((r) => r);
    const outcome = await within(disable, 2_000);

    harness.gate.release("initialize");
    expect((await enable).status).toBe(200);
    expect(outcome).not.toBe("pending");
    expect(outcome !== "pending" && outcome.status).toBe(409);
    expect(outcome !== "pending" && outcome.body.code).toBe("plugin_lifecycle_busy");
    expect(state.calls.slice(callsBefore)).not.toContain("row:disabled");
    expect(state.rows.get(row.id)!.status).toBe("ready");
    await disable;
  });

  it("N19: an operation on another plugin completes while the first plugin is held in initialize", async () => {
    harness = await createHarness({ hold: "initialize" });
    const held = seed("serial.j", "disabled");
    const other = seed("serial.k", "ready");

    const enable = request(harness.app).post(`/api/plugins/${held.pluginKey}/enable`).send({}).then((r) => r);
    await harness.gate.next("initialize-received");

    const res = await request(harness.app).post(`/api/plugins/${other.pluginKey}/disable`).send({});
    expect(res.status).toBe(200);
    expect(state.rows.get(other.id)!.status).toBe("disabled");

    harness.gate.release("initialize");
    expect((await enable).status).toBe(200);
  });

  it("N20a: an activation failure inside a route enable marks the plugin error without a deadlock", async () => {
    harness = await createHarness({ failActivation: true });
    const row = seed("serial.l", "disabled");
    const statuses: string[] = [];
    harness.appLifecycle.on("plugin.status_changed", ({ newStatus }) => void statuses.push(newStatus));

    const res = await within(request(harness.app).post(`/api/plugins/${row.pluginKey}/enable`).send({}).then((r) => r), 5_000);

    expect(res).not.toBe("pending");
    expect(res !== "pending" && res.status).toBeGreaterThanOrEqual(400);
    expect(state.rows.get(row.id)!.status).toBe("error");
    expect(harness.workerManager.getWorker(row.id)).toBeUndefined();
    expect(statuses.at(-1)).toBe("error");
  });

  it("a lease held for one plugin cannot run a lifecycle operation on another plugin", async () => {
    harness = await createHarness();
    const holder = seed("serial.m", "ready");
    const target = seed("serial.n", "disabled");
    const callsBefore = state.calls.length;

    const outcome = await harness.appLifecycle
      .exclusive(holder.pluginKey, "A", (lease) => harness!.appLifecycle.enable(target.id, { lease }))
      .then(() => null, (err: unknown) => err);

    expect((outcome as Error | null)?.name).toBe("LeaseKeyMismatchError");
    expect(state.rows.get(target.id)!.status).toBe("disabled");
    expect(state.calls.slice(callsBefore)).not.toContain("row:ready");
    expect(harness.workerManager.getWorker(target.id)).toBeUndefined();
  });

  it("disable from a state without a Q transition answers 400 invalid_transition with no side effect", async () => {
    harness = await createHarness();
    const row = seed("serial.o", "error");
    const disabled = vi.fn();
    harness.appLifecycle.on("plugin.disabled", disabled);
    const callsBefore = state.calls.length;

    const res = await request(harness.app).post(`/api/plugins/${row.pluginKey}/disable`).send({});

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_transition");
    expect(state.rows.get(row.id)!.status).toBe("error");
    expect(state.calls.slice(callsBefore).filter((call) => call.startsWith("row:"))).toEqual([]);
    expect(disabled).not.toHaveBeenCalled();
  });
});
