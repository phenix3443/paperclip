import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";

type Row = { id: string; pluginKey: string; packageName: string; packagePath: string; status: string; lastError: string | null; manifestJson: Record<string, unknown> };

const state = vi.hoisted(() => ({
  rows: new Map<string, Row>(),
  calls: [] as string[],
  holdList: null as null | Promise<void>,
  holdNextGet: null as null | Promise<void>,
}));

vi.mock("../services/plugin-registry.js", () => {
  const clone = (row: Row | undefined) => (row ? { ...row } : null);
  return {
    pluginRegistryService: () => ({
      getById: async (id: string) => {
        const hold = state.holdNextGet;
        state.holdNextGet = null;
        if (hold) await hold;
        return clone(state.rows.get(id));
      },
      listByStatus: async (status: string) => {
        const rows = [...state.rows.values()].filter((row) => row.status === status).map(clone);
        if (status === "error" && state.holdList) await state.holdList;
        return rows;
      },
      listConfigs: async () => [],
      updateStatus: async (id: string, patch: { status: string; lastError?: string | null }) => {
        const row = state.rows.get(id);
        if (!row) return null;
        Object.assign(row, patch);
        state.calls.push(`row:${row.status}`);
        return clone(row);
      },
      uninstall: async (id: string) => {
        const row = state.rows.get(id);
        if (!row) return null;
        row.status = "uninstalled";
        state.calls.push("row:uninstalled");
        return clone(row);
      },
    }),
  };
});

const { pluginLoader } = await import("../services/plugin-loader.js");
const { pluginLifecycleManager } = await import("../services/plugin-lifecycle.js");
const { createPluginWorkerManager } = await import("../services/plugin-worker-manager.js");

function seed(status: string): Row {
  const row: Row = {
    id: "plugin-startup",
    pluginKey: "example.startup",
    packageName: "@example/startup",
    packagePath: "/nonexistent/startup",
    status,
    lastError: status === "error" ? "previous boot" : null,
    manifestJson: { id: "example.startup", apiVersion: 1, version: "1.0.0", entrypoints: { worker: "dist/worker.js" }, capabilities: [] },
  };
  state.rows.set(row.id, row);
  return row;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createStartup() {
  const workerManager = createPluginWorkerManager();
  const lifecycle = pluginLifecycleManager({} as Db, { workerManager });
  const loader = pluginLoader(
    {} as Db,
    { localPluginDir: "/nonexistent/local-plugins", enableLocalFilesystem: false, enableNpmDiscovery: false },
    {
      lifecycleManager: lifecycle,
      workerManager,
      eventBus: {},
      jobScheduler: {},
      jobStore: {},
      toolDispatcher: {},
      buildHostHandlers: vi.fn(() => ({})),
      instanceInfo: { instanceId: "instance-1", hostVersion: "0.0.0-test" },
    } as never,
  );
  return { lifecycle, loader };
}

beforeEach(() => {
  state.rows.clear();
  state.calls.splice(0);
  state.holdList = null;
  state.holdNextGet = null;
});

describe("startup loadAll under the per-plugin lifecycle lease", () => {
  it("N12: a soft DELETE that lands after loadAll listed an errored plugin is not undone by the boot retry", async () => {
    const row = seed("error");
    const { lifecycle, loader } = createStartup();
    const listed = deferred();
    state.holdList = listed.promise;

    const startup = loader.loadAll();
    await lifecycle.unload(row.id, false);
    expect(state.rows.get(row.id)!.status).toBe("uninstalled");
    listed.resolve();
    const result = await startup;

    expect(state.rows.get(row.id)!.status).toBe("uninstalled");
    expect(state.calls).toEqual(["row:uninstalled"]);
    expect(result.total).toBe(0);
  });

  it("N12: a soft DELETE racing a startup activation waits for that activation, then quiesces", async () => {
    const row = seed("ready");
    const { lifecycle, loader } = createStartup();
    const inLease = deferred();
    state.holdNextGet = inLease.promise;

    const startup = loader.loadAll();
    await new Promise((resolve) => setImmediate(resolve));
    const del = lifecycle.unload(row.id, false);
    let deleted = false;
    void del.then(() => {
      deleted = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(deleted).toBe(false);

    inLease.resolve();
    const result = await startup;
    await del;

    expect(result.failed).toBe(1);
    expect(state.calls).toEqual(["row:error", "row:uninstalled"]);
    expect(state.rows.get(row.id)!.status).toBe("uninstalled");
  });
});
