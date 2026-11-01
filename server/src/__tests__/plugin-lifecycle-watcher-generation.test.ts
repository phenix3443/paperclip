import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  packagePath: string | null;
  version: string;
  status: string;
  lastError: string | null;
  manifestJson: PaperclipPluginManifestV1;
};

type FakeWatcher = { paths: string[]; closed: boolean; emit: (file: string) => void };

const state = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  calls: [] as string[],
  watchers: [] as FakeWatcher[],
  nextPackagePath: null as string | null,
}));

vi.mock("chokidar", () => {
  const watch = (paths: string[]) => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const fake: FakeWatcher & { on: (event: string, fn: (...args: unknown[]) => void) => unknown; close: () => Promise<void> } = {
      paths,
      closed: false,
      emit: (file: string) => handlers.get("all")?.("change", file),
      on(event, fn) {
        handlers.set(event, fn);
        return fake;
      },
      async close() {
        fake.closed = true;
      },
    };
    state.watchers.push(fake);
    return fake;
  };
  return { default: { watch }, watch };
});

vi.mock("../services/plugin-registry.js", async () => {
  const { conflict } = await import("../errors.js");
  const clone = (row: Row | undefined) => (row ? { ...row } : null);
  return {
    pluginRegistryService: () => ({
      getById: async (id: string) => clone(state.rows.get(id)),
      getByKey: async (key: string) => clone([...state.rows.values()].find((row) => row.pluginKey === key)),
      listByStatus: async (status: string) => [...state.rows.values()].filter((row) => row.status === status).map(clone),
      listConfigs: async () => [],
      upsertConfig: async (pluginId: string, companyId: string, input: { configJson: unknown }) => ({ pluginId, companyId, configJson: input.configJson }),
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
        state.calls.push("row:uninstalled");
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
          packagePath: null,
          version: manifest.version,
          status: "installed",
          lastError: null,
          manifestJson: manifest,
        };
        Object.assign(row, {
          status: "installed",
          version: manifest.version,
          manifestJson: manifest,
          lastError: null,
          packagePath: state.nextPackagePath ?? row.packagePath,
        });
        state.rows.set(row.id, row);
        state.calls.push("row:installed");
        return clone(row);
      },
    }),
  };
});

vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/live-events.js", () => ({ publishGlobalLiveEvent: vi.fn() }));
vi.mock("../services/secrets.js", () => ({
  secretService: () => ({ syncSecretRefsForTarget: vi.fn(async () => undefined) }),
}));

const { pluginRoutes } = await import("../routes/plugins.js");
const { errorHandler } = await import("../middleware/index.js");
const { pluginLifecycleManager } = await import("../services/plugin-lifecycle.js");
const { createPluginWorkerManager } = await import("../services/plugin-worker-manager.js");
const { createPluginDevWatcher } = await import("../services/plugin-dev-watcher.js");
const { ensureBundledPlugins } = await import("../services/bundled-plugins.js");

const GATED_WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "plugin-worker-gated.cjs");
const DEBOUNCE_SETTLE_MS = 800;

function manifest(id: string, version = "1.0.0"): PaperclipPluginManifestV1 {
  return {
    id,
    apiVersion: 1,
    version,
    displayName: id,
    description: id,
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["ui.page.register"],
    entrypoints: { worker: "dist/worker.js" },
  } as PaperclipPluginManifestV1;
}

type GateEvent = { event: string; pid: number };

async function createGate(dir: string) {
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
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function writePackage(dir: string, name: string) {
  const packagePath = path.join(dir, name);
  mkdirSync(path.join(packagePath, "dist"), { recursive: true });
  writeFileSync(path.join(packagePath, "package.json"), JSON.stringify({ name, paperclipPlugin: { worker: "dist/worker.js" } }));
  writeFileSync(path.join(packagePath, "dist", "worker.js"), "// bundle\n");
  return packagePath;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createHarness() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "plugin-watch-gen-"));
  const gate = await createGate(dir);
  const workerManager = createPluginWorkerManager();
  const appLifecycle = pluginLifecycleManager({} as never, { workerManager });

  let hold = "";
  let marker = "A";
  let activationGate: { promise: Promise<void>; paused: () => void } | null = null;
  const loader = {
    hasRuntimeServices: () => true,
    async loadSingle(id: string, loadOptions?: { lease?: unknown }) {
      const row = state.rows.get(id)!;
      if (row.status === "installed") {
        await appLifecycle.load(id, { lease: loadOptions?.lease } as never);
        return { plugin: { ...row }, success: true, registered: {} };
      }
      if (activationGate) {
        const current = activationGate;
        activationGate = null;
        current.paused();
        await current.promise;
      }
      try {
        state.calls.push(`worker:start:${id}`);
        workerManager.allowStarts?.(id);
        await workerManager.startWorker(id, {
          entrypointPath: GATED_WORKER,
          manifest: row.manifestJson,
          config: {},
          instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
          apiVersion: 1,
          hostHandlers: {},
          env: { GATE_SOCKET: gate.socketPath, GATE_HOLD: hold, BUNDLE_MARKER: marker },
        } as never);
        return { plugin: { ...row }, success: true, registered: {} };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await appLifecycle.markError(id, `Activation failed: ${message}`, { lease: loadOptions?.lease } as never);
        return { plugin: { ...row }, success: false, error: message, registered: {} };
      }
    },
    async unloadSingle(id: string) {
      state.calls.push(`worker:stop:${id}`);
      if (workerManager.getWorker(id)) await workerManager.stopWorker(id);
    },
    async cleanupInstallArtifacts() {},
    async loadManifest() {
      return null;
    },
    async prepareInstall(installOptions: { packageName?: string; localPath?: string }) {
      const name = installOptions.packageName ?? path.basename(installOptions.localPath ?? "");
      return { manifest: manifest(name), packageName: name, version: "1.0.0" };
    },
    async persistInstall(discovered: { manifest: PaperclipPluginManifestV1; packageName: string }) {
      const { pluginRegistryService } = await import("../services/plugin-registry.js");
      await pluginRegistryService({} as never).install({ packageName: discovered.packageName } as never, discovered.manifest);
      return discovered;
    },
    async installPlugin(installOptions: { packageName?: string; localPath?: string }) {
      return this.persistInstall(await this.prepareInstall(installOptions));
    },
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "board", userId: "admin", source: "session", isInstanceAdmin: true, companyIds: ["company-1"] } as never;
    next();
  });
  app.use("/api", pluginRoutes({} as never, loader as never, undefined, undefined, undefined, { workerManager } as never));
  app.use(errorHandler);

  const heldLookups: Array<() => void> = [];
  let holdLookups = false;
  const devWatcher = createPluginDevWatcher(appLifecycle, async (pluginId) => {
    const packagePath = state.rows.get(pluginId)?.packagePath ?? null;
    if (!holdLookups) return packagePath;
    await new Promise<void>((resolve) => heldLookups.push(resolve));
    return packagePath;
  });
  const restarts = vi.spyOn(appLifecycle, "restartWorker");

  return {
    app,
    dir,
    gate,
    workerManager,
    appLifecycle,
    devWatcher,
    loader,
    restarts,
    heldLookups,
    setHold(next: string) {
      hold = next;
    },
    setMarker(next: string) {
      marker = next;
    },
    setHoldLookups(next: boolean) {
      holdLookups = next;
    },
    pauseNextActivation() {
      const released = deferred();
      const paused = deferred();
      activationGate = { promise: released.promise, paused: paused.resolve };
      return { paused: paused.promise, release: released.resolve };
    },
    watcherFor(packagePath: string) {
      return state.watchers.filter((w) => !w.closed && w.paths.some((p) => p.startsWith(packagePath))).at(-1);
    },
    async settleRestarts() {
      await Promise.allSettled(restarts.mock.results.map((r) => r.value));
    },
    async close() {
      devWatcher.close();
      await workerManager.stopAll().catch(() => undefined);
      await gate.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

function seed(h: Harness, key: string, status: string) {
  const row: Row = {
    id: `id-${key}`,
    pluginKey: key,
    packageName: key,
    packagePath: writePackage(h.dir, key),
    version: "1.0.0",
    status,
    lastError: null,
    manifestJson: manifest(key),
  };
  state.rows.set(row.id, row);
  return row;
}

async function boot(h: Harness, row: Row) {
  if (!h.workerManager.getWorker(row.id)) {
    const loaded = h.loader.loadSingle(row.id);
    if (row.status === "ready" || state.rows.get(row.id)!.status === "ready") {
      await h.gate.next("initialize-received", h.gate.count("initialize-received"));
      h.gate.release("initialize");
    }
    await loaded;
  }
  h.devWatcher.watch(row.id, row.packagePath!);
}

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

let harness: Harness | undefined;

beforeEach(() => {
  state.rows.clear();
  state.calls.splice(0);
  state.watchers.splice(0);
  state.nextPackagePath = null;
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe("watcher and config reload generations through the real app, route and watcher wiring", () => {
  it("N1: a DELETE during a watcher reload held in initialize drains it, stops the worker, and the next install starts once", async () => {
    harness = await createHarness();
    const h = harness;
    h.setHold("initialize");
    const row = seed(h, "gen.n1", "ready");
    await boot(h, row);

    const seen = h.gate.count("initialize-received");
    h.watcherFor(row.packagePath!)!.emit(path.join(row.packagePath!, "dist", "worker.js"));
    await h.gate.next("initialize-received", seen);

    const del = request(h.app).delete(`/api/plugins/${row.pluginKey}`).then((r) => r);
    expect(await within(del, 200)).toBe("pending");
    h.gate.release("initialize");
    expect((await del).status).toBe(200);
    await h.settleRestarts();
    expect(h.workerManager.getWorker(row.id)).toBeUndefined();

    h.setHold("");
    const spawned = h.gate.count("spawned");
    const install = await request(h.app).post("/api/plugins/install").send({ packageName: row.pluginKey });
    expect(install.status).toBe(200);
    expect(h.gate.count("spawned") - spawned).toBe(1);
    expect(h.workerManager.getWorker(row.id)?.status).toBe("running");
  });

  it("N2a: a DELETE during a watcher reload held between stop and start leaves no worker once every gate is released", async () => {
    harness = await createHarness();
    const h = harness;
    h.setHold("shutdown");
    const row = seed(h, "gen.n2a", "ready");
    await boot(h, row);

    h.watcherFor(row.packagePath!)!.emit(path.join(row.packagePath!, "dist", "worker.js"));
    await h.gate.next("shutdown-received");
    h.setHold("");

    const del = request(h.app).delete(`/api/plugins/${row.pluginKey}`).then((r) => r);
    expect(await within(del, 200)).toBe("pending");
    h.gate.release("shutdown");
    expect((await del).status).toBe(200);
    await h.settleRestarts();
    h.gate.release("initialize");
    await delay(100);

    expect(state.rows.get(row.id)!.status).toBe("uninstalled");
    expect(h.workerManager.getWorker(row.id)).toBeUndefined();
  });

  it("N2b: a DELETE while a config restart is paused between teardown and activation waits for it, and nothing starts after the uninstall", async () => {
    harness = await createHarness();
    const h = harness;
    const row = seed(h, "gen.n2b", "ready");
    await boot(h, row);

    const pause = h.pauseNextActivation();
    const config = request(h.app).post(`/api/plugins/${row.pluginKey}/config`).send({ companyId: "company-1", configJson: { a: 1 } }).then((r) => r);
    await pause.paused;

    const del = request(h.app).delete(`/api/plugins/${row.pluginKey}`).then((r) => r);
    expect(await within(del, 200)).toBe("pending");
    pause.release();
    expect((await config).status).toBe(200);
    expect((await del).status).toBe(200);

    expect(state.rows.get(row.id)!.status).toBe("uninstalled");
    expect(h.workerManager.getWorker(row.id)).toBeUndefined();
    expect(state.calls.lastIndexOf(`worker:start:${row.id}`)).toBeLessThan(state.calls.indexOf("row:uninstalled"));
  });

  it("N3: a route disable withdraws the app watcher under its lease, so a later file change and a stale path lookup do nothing", async () => {
    harness = await createHarness();
    const h = harness;
    h.setHold("shutdown");
    const row = seed(h, "gen.n3", "disabled");
    h.setHoldLookups(true);
    await h.appLifecycle.enable(row.id);
    await boot(h, row);
    expect(h.heldLookups.length).toBeGreaterThan(0);
    const fake = h.watcherFor(row.packagePath!)!;
    const watchesBefore = state.watchers.length;

    const disable = request(h.app).post(`/api/plugins/${row.pluginKey}/disable`).send({}).then((r) => r);
    await h.gate.next("shutdown-received");
    expect(fake.closed).toBe(true);
    fake.emit(path.join(row.packagePath!, "dist", "worker.js"));
    h.gate.release("shutdown");
    expect((await disable).status).toBe(200);
    await delay(DEBOUNCE_SETTLE_MS);
    for (const resolve of h.heldLookups.splice(0)) resolve();
    await delay(10);

    expect(h.restarts).not.toHaveBeenCalled();
    expect(state.watchers.length).toBe(watchesBefore);
    expect(h.workerManager.getWorker(row.id)).toBeUndefined();
  });

  it("N4b (watcher): a lookup of the old generation cannot watch the old path after Q and a reinstall from a new path", async () => {
    harness = await createHarness();
    const h = harness;
    const row = seed(h, "gen.n4b", "disabled");
    const oldPath = row.packagePath!;
    h.setHoldLookups(true);
    await h.appLifecycle.enable(row.id);
    await boot(h, row);
    const oldLookups = h.heldLookups.splice(0);

    expect((await request(h.app).delete(`/api/plugins/${row.pluginKey}`)).status).toBe(200);
    const newPath = writePackage(h.dir, "gen.n4b-next");
    state.nextPackagePath = newPath;
    const install = request(h.app).post("/api/plugins/install").send({ packageName: row.pluginKey }).then((r) => r);
    await h.gate.next("initialize-received", h.gate.count("initialize-received"));
    h.gate.release("initialize");
    expect((await install).status).toBe(200);

    const watchesAfterQ = state.watchers.length;
    for (const resolve of oldLookups) resolve();
    await delay(10);
    for (const resolve of h.heldLookups.splice(0)) resolve();
    await delay(10);

    const watchedAfterQ = state.watchers.slice(watchesAfterQ).flatMap((w) => w.paths);
    expect(watchedAfterQ.some((p) => p.startsWith(oldPath + path.sep))).toBe(false);
    expect(watchedAfterQ.some((p) => p.startsWith(newPath + path.sep))).toBe(true);
  });

  it("N8: after Q, a rebuilt same-version bundle and its file events are served only after enable, with no reload of the old bundle", async () => {
    harness = await createHarness();
    const h = harness;
    const row = seed(h, "gen.n8", "ready");
    await boot(h, row);
    const fake = h.watcherFor(row.packagePath!)!;

    expect((await request(h.app).post(`/api/plugins/${row.pluginKey}/disable`).send({})).status).toBe(200);
    h.setMarker("B");
    for (let i = 0; i < 3; i += 1) fake.emit(path.join(row.packagePath!, "dist", "worker.js"));
    await delay(DEBOUNCE_SETTLE_MS);

    const spawned = h.gate.count("spawned");
    const enable = request(h.app).post(`/api/plugins/${row.pluginKey}/enable`).send({}).then((r) => r);
    await h.gate.next("initialize-received", h.gate.count("initialize-received"));
    h.gate.release("initialize");
    expect((await enable).status).toBe(200);
    await delay(DEBOUNCE_SETTLE_MS);
    await h.settleRestarts();

    expect(h.gate.count("spawned") - spawned).toBe(1);
    const data = await request(h.app).post(`/api/plugins/${row.pluginKey}/data/marker`).send({});
    expect(data.status).toBe(200);
    expect(data.body.data).toEqual({ marker: "B" });
    expect(state.rows.get(row.id)).toMatchObject({ id: row.id, version: "1.0.0", packagePath: row.packagePath, status: "ready" });
  });

  it("N11: a disable that arrives while a config restart holds the plugin drains it, then quiesces", async () => {
    harness = await createHarness();
    const h = harness;
    const row = seed(h, "gen.n11", "ready");
    await boot(h, row);

    const pause = h.pauseNextActivation();
    const config = request(h.app).post(`/api/plugins/${row.pluginKey}/config`).send({ companyId: "company-1", configJson: { a: 1 } }).then((r) => r);
    await pause.paused;
    const disable = request(h.app).post(`/api/plugins/${row.pluginKey}/disable`).send({}).then((r) => r);
    expect(await within(disable, 200)).toBe("pending");

    pause.release();
    await h.gate.next("initialize-received", h.gate.count("initialize-received"));
    h.gate.release("initialize");
    expect((await config).status).toBe(200);
    expect((await disable).status).toBe(200);
    expect(state.rows.get(row.id)!.status).toBe("disabled");
    expect(h.workerManager.getWorker(row.id)).toBeUndefined();

    const spawned = h.gate.count("spawned");
    await expect(h.appLifecycle.restartWorker(row.id)).resolves.toMatchObject({ superseded: true });
    expect(h.gate.count("spawned")).toBe(spawned);
  });

  it("N12: bundled startup records ready through the app lifecycle without spawning; a later disable waits for the startup activation", async () => {
    harness = await createHarness();
    const h = harness;
    const packagePath = writePackage(h.dir, "gen.n12");
    state.nextPackagePath = packagePath;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await ensureBundledPlugins(
      [{ key: "gen", pluginKey: "gen.n12", localPath: packagePath } as never],
      { registry: (await import("../services/plugin-registry.js")).pluginRegistryService({} as never) as never, loader: h.loader as never, lifecycle: h.appLifecycle, logger: logger as never, bundleManifestExists: () => true } as never,
      { reinstallUninstalled: false },
    );
    const row = state.rows.get("id-gen.n12")!;
    expect(row.status).toBe("ready");
    expect(h.gate.count("spawned")).toBe(0);

    const startup = h.loader.loadSingle(row.id);
    await h.gate.next("initialize-received");
    expect(h.gate.count("spawned")).toBe(1);
    h.gate.release("initialize");
    await startup;

    expect((await request(h.app).post(`/api/plugins/${row.pluginKey}/disable`).send({})).status).toBe(200);
    expect(h.gate.count("spawned")).toBe(1);
    expect(h.workerManager.getWorker(row.id)).toBeUndefined();
  });

  it("N18: a reload scheduled before a queued disable is superseded, and the following enable runs alone", async () => {
    harness = await createHarness();
    const h = harness;
    h.setHold("initialize");
    const row = seed(h, "gen.n18", "ready");
    await boot(h, row);
    const file = path.join(row.packagePath!, "dist", "worker.js");

    const seen = h.gate.count("initialize-received");
    h.watcherFor(row.packagePath!)!.emit(file);
    await h.gate.next("initialize-received", seen);
    const disable = request(h.app).post(`/api/plugins/${row.pluginKey}/disable`).send({}).then((r) => r);
    expect(await within(disable, 100)).toBe("pending");
    h.watcherFor(row.packagePath!)?.emit(file);
    await vi.waitFor(() => expect(h.restarts).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    const enable = request(h.app).post(`/api/plugins/${row.pluginKey}/enable`).send({}).then((r) => r);

    h.setHold("");
    h.gate.release("initialize");
    expect((await disable).status).toBe(200);
    expect((await enable).status).toBe(200);
    const results = await Promise.all(h.restarts.mock.results.map((r) => r.value));
    expect(results).toEqual([{ superseded: false }, { superseded: true }]);
    expect(h.workerManager.getWorker(row.id)?.status).toBe("running");
    const starts = state.calls.filter((call) => call === `worker:start:${row.id}`);
    expect(starts).toHaveLength(3);
  });
});
