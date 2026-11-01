import { readGitCacheRestoration } from "./git-workspace-restoration.js";
import { selectRestoredProjectRepositories } from "./git-workspace-contents.js";
import { projectWorkspaces, type Db } from "@paperclipai/db";
import { and, asc, eq } from "drizzle-orm";
import { inspectDetachedRepositoryRetention, type RetentionWorkspace } from "./detached-repository-retention.js";
import { managedProjectCheckoutName, projectRepositoryIdentity } from "./managed-project-checkout-name.js";

type Reader = Pick<Db, "select">;
type Workspace = RetentionWorkspace & Parameters<typeof readGitCacheRestoration>[0];

export async function workspaceRetentionBlockingReasons(db: Reader, workspace: Workspace) {
  const active = new Set<string>();
  if (workspace.projectId) {
    const repositories = await db.select().from(projectWorkspaces).where(and(
      eq(projectWorkspaces.companyId, workspace.companyId), eq(projectWorkspaces.projectId, workspace.projectId),
    )).orderBy(asc(projectWorkspaces.createdAt), asc(projectWorkspaces.id));
    const seen = new Set(workspace.repoUrl ? [projectRepositoryIdentity(workspace.repoUrl)] : []);
    let selected: typeof repositories;
    try { selected = selectRestoredProjectRepositories(repositories, readGitCacheRestoration(workspace)?.contents); }
    catch {
      return [`Cannot verify active repository selection for retained workspace: ${workspace.cwd ?? workspace.id}`];
    }
    for (const repository of selected) {
      if (!repository.repoUrl || seen.has(projectRepositoryIdentity(repository.repoUrl))) continue;
      seen.add(projectRepositoryIdentity(repository.repoUrl));
      active.add(managedProjectCheckoutName({ ...repository, repoUrl: repository.repoUrl }));
    }
  }
  return inspectDetachedRepositoryRetention(workspace, active);
}

export class DetachedRepositoryRetentionBlocksRemoval extends Error {
  constructor(readonly reasons: string[]) { super("detached_repository_retention"); }
}

export async function assertWorkspaceRetentionAllowsRemoval(db: Reader, workspace: Workspace) {
  const reasons = await workspaceRetentionBlockingReasons(db, workspace);
  if (reasons.length) throw new DetachedRepositoryRetentionBlocksRemoval(reasons);
}
