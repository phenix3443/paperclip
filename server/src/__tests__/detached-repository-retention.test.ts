import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDetachedRepositoryRetentionDir } from "../home-paths.js";
import { inspectDetachedRepositoryRetention } from "../services/detached-repository-retention.js";

const states = ["pending", "retained", "rolled_back", "aborted", "in_doubt", "rollback_failed", "conflict", "unknown"];
describe("detached repository removal boundary", () => {
  let root: string;
  let cwd: string;
  const workspace = { companyId: "company", id: "workspace", projectId: null, repoUrl: null };
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "detached-retention-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    cwd = path.join(root, "task");
    await fs.mkdir(cwd);
  });
  afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
  it.each(states)("refuses removal with a %s receipt without changing it", async state => {
    const directory = resolveDetachedRepositoryRetentionDir({ companyId: workspace.companyId, executionWorkspaceId: workspace.id });
    await fs.mkdir(directory, { recursive: true });
    const receipt = path.join(directory, "receipt.json");
    const bytes = JSON.stringify({ schemaVersion: 1, state, history: [{ state }] });
    await fs.writeFile(receipt, bytes);
    const reasons = await inspectDetachedRepositoryRetention({ ...workspace, cwd });
    expect(reasons).toContain(`Detached repository retention history (${state}): ${receipt}`);
    expect(await fs.readFile(receipt, "utf8")).toBe(bytes);
  });
  it("refuses unreadable and unknown receipt formats", async () => {
    const directory = resolveDetachedRepositoryRetentionDir({ companyId: workspace.companyId, executionWorkspaceId: workspace.id });
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "invalid.json"), "not json");
    await fs.writeFile(path.join(directory, "future.json"), JSON.stringify({ schemaVersion: 2, state: "retained" }));
    expect(await inspectDetachedRepositoryRetention({ ...workspace, cwd })).toEqual([
      `Detached repository retention history (unknown schema): ${path.join(directory, "future.json")}`,
      `Detached repository retention history (unreadable): ${path.join(directory, "invalid.json")}`,
    ]);
  });
  it("blocks refused entries and legacy contents without modifying them", async () => {
    const entry = path.join(cwd, ".paperclip-repositories", "removed");
    const legacy = path.join(cwd, ".paperclip-runtime", "detached-repositories", "old");
    for (const location of [entry, legacy]) { await fs.mkdir(location, { recursive: true }); await fs.writeFile(path.join(location, "unique"), "keep"); }
    expect(await inspectDetachedRepositoryRetention({ ...workspace, cwd })).toEqual([
      `Detached repository remains in workspace: ${entry}`,
      `Legacy detached repositories remain: ${path.dirname(legacy)}`,
    ]);
    for (const location of [entry, legacy]) expect(await fs.readFile(path.join(location, "unique"), "utf8")).toBe("keep");
  });
  it("allows a workspace without retention history", async () => {
    expect(await inspectDetachedRepositoryRetention({ ...workspace, cwd })).toEqual([]);
  });
});
