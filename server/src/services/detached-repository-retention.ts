import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { resolveDetachedRepositoryRetentionDir, resolvePaperclipInstanceRoot } from "../home-paths.js";

export type RetentionWorkspace = {
  id: string;
  companyId: string;
  cwd: string | null;
  providerRef?: string | null;
};

const states = new Set(["pending", "retained", "rolled_back", "aborted", "in_doubt", "rollback_failed", "conflict", "unknown"]);

async function children(directory: string): Promise<string[]> {
  const stat = await fs.lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return [];
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe retention directory: ${directory}`);
  return (await fs.readdir(directory)).sort();
}

export async function readRetentionReceipt(file: string): Promise<Record<string, unknown>> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error("Invalid retention receipt");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}

export async function inspectDetachedRepositoryRetention(
  workspace: RetentionWorkspace,
  activeRepositoryNames: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const reasons: string[] = [];
  try {
    const directory = resolveDetachedRepositoryRetentionDir({ companyId: workspace.companyId, executionWorkspaceId: workspace.id });
    const instance = path.resolve(resolvePaperclipInstanceRoot());
    for (const component of [path.join(instance, "detached-repositories"), path.dirname(directory), directory]) {
      const stat = await fs.lstat(component).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Unsafe retention directory: ${component}`);
    }
    for (const name of await children(directory)) {
      if (!name.endsWith(".json")) {
        const entry = await fs.lstat(path.join(directory, name));
        if (entry.isDirectory() && !entry.isSymbolicLink()) continue;
        reasons.push(`Detached repository retention history: ${path.join(directory, name)}`);
        continue;
      }
      const receipt = await readRetentionReceipt(path.join(directory, name)).catch(() => null);
      const state = !receipt ? "unreadable" : receipt.schemaVersion !== 1 ? "unknown schema"
        : typeof receipt.state === "string" && states.has(receipt.state) ? receipt.state : "unknown state";
      reasons.push(`Detached repository retention history (${state}): ${path.join(directory, name)}`);
    }
    const cwd = workspace.providerRef ?? workspace.cwd;
    if (cwd) {
      const root = path.join(cwd, ".paperclip-repositories");
      for (const name of await children(root)) {
        if (activeRepositoryNames.has(name) || name.startsWith("task-repo-") || name.includes(".clone-")) continue;
        reasons.push(`Detached repository remains in workspace: ${path.join(root, name)}`);
      }
      const runtime = path.join(cwd, ".paperclip-runtime");
      const runtimeStat = await fs.lstat(runtime).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (runtimeStat?.isSymbolicLink()) throw new Error(`Unsafe retention directory: ${runtime}`);
      const legacy = path.join(runtime, "detached-repositories");
      if ((await children(legacy)).length) reasons.push(`Legacy detached repositories remain: ${legacy}`);
    }
  } catch (error) {
    reasons.push(`Cannot verify detached repository retention: ${error instanceof Error ? error.message : String(error)}`);
  }
  return reasons;
}
