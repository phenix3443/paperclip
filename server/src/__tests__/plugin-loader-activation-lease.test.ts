import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type Row = {
  id: string;
  pluginKey: string;
  packageName: string;
  packagePath: string;
  version: string;
  status: string;
  lastError: string | null;
  manifestJson: Record<string, unknown>;
};

const state = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  update: async () => undefined as void,
  applyMigrations: async () => null as { namespaceName: string } | null,
}));

vi.mock("../services/plugin-registry.js", () => {
  const clone = (row: Row | undefined) => (row ? { ...row } : null);
  return {
    pluginRegistryService: () => ({
      getById: async (id: string) => clone(state.rows.get(id)),
      listConfigs: async () => [],
      update: () => state.update(),
      updateStatus: async (id: string, patch: Partial<Row>) => {
        const row = state.rows.get(id);
        if (!row) return null;
        Object.assign(row, patch);
        return clone(row);
      },
    }),
  };
});

vi.mock("../services/plugin-database.js", () => ({
  pluginDatabaseService: () => ({ applyMigrations: () => state.applyMigrations() }),
}));

const { pluginLoader } = await import("../services/plugin-loader.js");

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const dirs: string[] = [];

afterEach(async () => {
  state.rows.clear();
  state.update = async () => undefined;
  state.applyMigrations = async () => null;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function seedPackage(options: { database?: boolean; staleRow?: boolean } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-activation-lease-"));
  dirs.push(dir);
  const manifest = {
    id: "lease.activation",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "Lease",
    description: "Lease",
    author: "Paperclip",
    categories: ["automation"],
    capabilities: ["agent.tools.register", "jobs.schedule"],
    entrypoints: { worker: "worker.js" },
    jobs: [{ jobKey: "tick", displayName: "Tick", schedule: "* * * * *" }],
    tools: [{ name: "echo", displayName: "Echo", description: "Echo", parametersSchema: { type: "object" } }],
    ...(options.database
      ? { database: { migrationsDir: "migrations" } }
      : {}),
  };
  if (options.database) manifest.capabilities.push("database.namespace.migrate", "database.namespace.read");
  await writeFile(path.join(dir, "package.json"), JSON.stringify({
    name: "@example/lease-activation",
    version: "1.0.0",
    paperclipPlugin: { manifest: "manifest.mjs" },
  }));
  await writeFile(path.join(dir, "manifest.mjs"), `export default ${JSON.stringify(manifest)};`);
  await writeFile(path.join(dir, "worker.js"), "");
  const row: Row = {
    id: "plugin-lease-activation",
    pluginKey: manifest.id,
    packageName: "@example/lease-activation",
    packagePath: dir,
    version: "1.0.0",
    status: "ready",
    lastError: null,
    manifestJson: options.staleRow ? { ...manifest, description: "Stale" } : manifest,
  };
  state.rows.set(row.id, row);
  return { dir, row };
}

function expiringLease(pluginKey: string) {
  const lease = {
    expired: false,
    pluginKey,
    kind: "A",
    released: false,
    assertActive() {
      if (lease.expired) throw new Error("lease expired");
    },
    assertCleanup() {},
  };
  return lease;
}

function runtime(dir: string, overrides: { syncJobDeclarations?: () => Promise<void> } = {}) {
  const spies = {
    buildHostHandlers: vi.fn(() => ({})),
    startWorker: vi.fn(async () => undefined),
    registerPlugin: vi.fn(async () => undefined),
    forPlugin: vi.fn(() => ({})),
    registerPluginTools: vi.fn(),
  };
  const services = {
    lifecycleManager: { markError: vi.fn(async () => undefined) },
    workerManager: { startWorker: spies.startWorker, getWorker: () => undefined, call: vi.fn() },
    jobStore: { syncJobDeclarations: overrides.syncJobDeclarations ?? (async () => undefined) },
    jobScheduler: { registerPlugin: spies.registerPlugin, unregisterPlugin: vi.fn(async () => undefined) },
    eventBus: { forPlugin: spies.forPlugin, subscriptionCount: () => 0, clearPlugin: vi.fn() },
    toolDispatcher: { registerPluginTools: spies.registerPluginTools, unregisterPluginTools: vi.fn() },
    buildHostHandlers: spies.buildHostHandlers,
    instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
  };
  const loader = pluginLoader({} as never, { localPluginDir: dir }, services as never);
  return { loader, spies };
}

async function expireWhileHeld(
  load: Promise<{ success: boolean }>,
  reached: Promise<void>,
  lease: { expired: boolean },
  release: () => void,
) {
  const first = await Promise.race([reached.then(() => "reached"), load]);
  expect(first).toBe("reached");
  lease.expired = true;
  release();
  return load;
}

describe("real plugin loader activation under an expiring lease", () => {
  it("creates no host services once the lease expired during the manifest refresh", async () => {
    const { dir, row } = await seedPackage({ staleRow: true });
    const lease = expiringLease(row.pluginKey);
    const reached = deferred();
    const held = deferred();
    state.update = async () => {
      reached.resolve();
      await held.promise;
    };
    const { loader, spies } = runtime(dir);

    const result = await expireWhileHeld(loader.loadSingle(row.id, { lease } as never), reached.promise, lease, held.resolve);

    expect(result.success).toBe(false);
    expect(spies.buildHostHandlers).not.toHaveBeenCalled();
    expect(spies.startWorker).not.toHaveBeenCalled();
  });

  it("creates no host services once the lease expired during the database migrations", async () => {
    const { dir, row } = await seedPackage({ database: true });
    const lease = expiringLease(row.pluginKey);
    const reached = deferred();
    const held = deferred();
    state.applyMigrations = async () => {
      reached.resolve();
      await held.promise;
      return { namespaceName: "plugin_lease" };
    };
    const { loader, spies } = runtime(dir);

    const result = await expireWhileHeld(loader.loadSingle(row.id, { lease } as never), reached.promise, lease, held.resolve);

    expect(result.success).toBe(false);
    expect(spies.buildHostHandlers).not.toHaveBeenCalled();
    expect(spies.startWorker).not.toHaveBeenCalled();
  });

  it("starts no scheduler, event bus or tool registration once the lease expired during the job sync", async () => {
    const { dir, row } = await seedPackage();
    const lease = expiringLease(row.pluginKey);
    const reached = deferred();
    const held = deferred();
    const { loader, spies } = runtime(dir, {
      syncJobDeclarations: async () => {
        reached.resolve();
        await held.promise;
      },
    });

    const result = await expireWhileHeld(loader.loadSingle(row.id, { lease } as never), reached.promise, lease, held.resolve);

    expect(result.success).toBe(false);
    expect(spies.registerPlugin).not.toHaveBeenCalled();
    expect(spies.forPlugin).not.toHaveBeenCalled();
    expect(spies.registerPluginTools).not.toHaveBeenCalled();
  });
});
