import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { resolveDetachedRepositoryRetentionDir, resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { retainProjectRepositoryEntries } from "../../services/project-repository-retention.js";
import { withIsolatedRepositorySourceLock } from "../../services/isolated-remote-workspace-source.js";
import { withExecutionWorkspaceLifecycleLock } from "../../services/execution-workspace-lifecycle-lock.js";
import { ensureManagedRepositoriesIgnored } from "../../services/managed-repository-checkout.js";

export const receiptCases = [null, "pending", "retained", "rolled_back", "aborted", "in_doubt", "rollback_failed", "conflict", "unknown", "unreadable", "unknown_schema"] as const;
export async function retainedFixture(db: Db, workspace: { id: string; companyId: string; sourceIssueId: string; cwd: string }, state: typeof receiptCases[number]) {
  await fs.mkdir(resolvePaperclipInstanceRoot(), { recursive: true });
  const source = path.join(workspace.cwd, ".paperclip-repositories", "removed");
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "unique"), "retained unique bytes");
  if (await fs.lstat(path.join(workspace.cwd, ".git")).catch(() => null)) await ensureManagedRepositoriesIgnored(workspace.cwd);
  const warnings = await withIsolatedRepositorySourceLock(db, workspace.companyId, workspace.sourceIssueId, () => retainProjectRepositoryEntries({
    cwd: workspace.cwd, active: new Set(), retention: { companyId: workspace.companyId, executionWorkspaceId: workspace.id,
      sourceIssueId: workspace.sourceIssueId, runId: null, generation: 0,
      withLifecycleLock: work => withExecutionWorkspaceLifecycleLock(db, workspace.id, work) },
  }));
  if (warnings.length) throw new Error(warnings.join("; "));
  const directory = resolveDetachedRepositoryRetentionDir({ companyId: workspace.companyId, executionWorkspaceId: workspace.id });
  const file = path.join(directory, (await fs.readdir(directory)).find(name => name.endsWith(".json"))!);
  const value = JSON.parse(await fs.readFile(file, "utf8"));
  if (state === null) await fs.unlink(file);
  else if (state === "unreadable") await fs.writeFile(file, "{broken");
  else { value.state = state === "unknown_schema" ? "retained" : state; if (state === "unknown_schema") value.schemaVersion = 2; await fs.writeFile(file, JSON.stringify(value)); }
  return { source, file, destination: value.destination as string, bytes: state === null ? null : await fs.readFile(file, "utf8") };
}
