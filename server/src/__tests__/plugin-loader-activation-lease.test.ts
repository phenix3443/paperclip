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

const state = vi.hoisted(() => ({ rows: new Map<string, Row>() }));

vi.mock("../services/plugin-registry.js", () => {
  const clone = (row: Row | undefined) => (row ? { ...row } : null);
  return {
    pluginRegistryService: () => ({
      getById: async (id: string) => clone(state.rows.get(id)),
      listConfigs: async () => [],
      update: async () => undefined,
      updateStatus: async (id: string, patch: Partial<Row>) => {
        const row = state.rows.get(id);
        if (!row) return null;
        Object.assign(row, patch);
        return clone(row);
      },
    }),
  };
});

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
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function seedPackage() {
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
  };
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
    manifestJson: manifest,
  };
  state.rows.set(row.id, row);
  return { dir, row };
}

describe("real plugin loader activation under an expiring lease", () => {
  it("starts no scheduler, event bus or tool registration once the lease expired during the job sync", async () => {
    const { dir, row } = await seedPackage();
    let expired = false;
    const lease = {
      pluginKey: row.pluginKey,
      kind: "A",
      released: false,
      get expired() {
        return expired;
      },
      assertActive() {
        if (expired) throw new Error("lease expired");
      },
      assertCleanup() {},
    };
    const syncReached = deferred();
    const syncHeld = deferred();
    const registerPlugin = vi.fn(async () => undefined);
    const forPlugin = vi.fn(() => ({}));
    const registerPluginTools = vi.fn();
    const loader = pluginLoader({} as never, { localPluginDir: dir }, {
      lifecycleManager: { markError: vi.fn(async () => undefined) },
      workerManager: { startWorker: vi.fn(async () => undefined), getWorker: () => undefined, call: vi.fn() },
      jobStore: {
        syncJobDeclarations: async () => {
          syncReached.resolve();
          await syncHeld.promise;
        },
      },
      jobScheduler: { registerPlugin, unregisterPlugin: vi.fn(async () => undefined) },
      eventBus: { forPlugin, subscriptionCount: () => 0, clearPlugin: vi.fn() },
      toolDispatcher: { registerPluginTools, unregisterPluginTools: vi.fn() },
      buildHostHandlers: () => ({}),
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
    } as never);

    const loading = loader.loadSingle(row.id, { lease } as never);
    const first = await Promise.race([syncReached.promise.then(() => "reached"), loading]);
    expect(first).toBe("reached");
    expired = true;
    syncHeld.resolve();
    const result = await loading;

    expect(result.success).toBe(false);
    expect(registerPlugin).not.toHaveBeenCalled();
    expect(forPlugin).not.toHaveBeenCalled();
    expect(registerPluginTools).not.toHaveBeenCalled();
  });
});
