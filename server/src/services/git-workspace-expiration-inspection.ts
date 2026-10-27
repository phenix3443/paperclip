import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { executionWorkspaces, issues, heartbeatRuns, nativeRunFinalizations, environmentLeases,
  workspaceRuntimeServices, issueRecoveryActions, projectWorkspaces, type Db } from "@paperclipai/db";
import { readManagedCheckoutContents, selectRestoredProjectRepositories, type ManagedCheckoutContents } from "./git-workspace-contents.js";
import { createGitRemoteAuthProvider, type GitRemoteAuthProvider } from "./git-credentials.js";
import { managedProjectCheckoutName } from "./managed-project-checkout-name.js";
import { assertReproducibleManagedCheckout, inspectGitCacheRecipe, readGitCacheRestoration, readGitCacheExpiration,
  GitCacheRestorationFailure, type GitCacheExpiration, type GitCacheRestoration, type ManagedCheckoutProver } from "./git-workspace-restoration.js";

export type Workspace = typeof executionWorkspaces.$inferSelect;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const DAY_MS = 24 * 60 * 60 * 1000;
export const GIT_CACHE_EXPIRATION_KEY = "gitCacheExpiration";

export async function allocatedBytes(target: string, shouldContinue: () => boolean): Promise<number> {
  if (!shouldContinue()) throw new Error("scan_stopped");
  const entry = await fs.lstat(target);
  if (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink()) throw new Error("unsupported_filesystem_entry");
  let bytes = entry.blocks * 512;
  if (entry.isDirectory()) for (const name of await fs.readdir(target)) bytes += await allocatedBytes(path.join(target, name), shouldContinue);
  return bytes;
}

export async function pathExists(target: string) {
  return fs.lstat(target).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
}

export function gitExpirationSkipReason(error: unknown) {
  if (error instanceof GitCacheRestorationFailure) return "upstream_commit_unverified";
  return error instanceof Error && /^[a-z][a-z_]+$/.test(error.message) ? error.message : "inspection_failed";
}

export function withAnonymousGitFallback(provider: GitRemoteAuthProvider): GitRemoteAuthProvider {
  return async (remoteUrl) => provider(remoteUrl).catch(() => null);
}

export function expirationGitAuth(db: Db, workspace: Workspace) {
  return withAnonymousGitFallback(createGitRemoteAuthProvider(db, workspace.companyId, { issueId: workspace.sourceIssueId! }));
}

/** Re-read the whole tree and every runtime/recovery consumer immediately before deletion. */
export async function isGitWorkspaceExpirationEligible(tx: Tx, workspace: Workspace, now: Date) {
  if (workspace.metadata?.reopenPendingConsumption === true) return false;
  const rows = await tx.execute<{ allowed: boolean }>(sql`
    WITH RECURSIVE tree AS (
      SELECT id, status, completed_at, cancelled_at, updated_at FROM ${issues}
      WHERE company_id = ${workspace.companyId} AND id = ${workspace.sourceIssueId}
      UNION
      SELECT c.id, c.status, c.completed_at, c.cancelled_at, c.updated_at FROM ${issues} c
      JOIN tree p ON c.parent_id = p.id WHERE c.company_id = ${workspace.companyId}
    ), relevant_runs AS (
      SELECT r.* FROM ${heartbeatRuns} r WHERE r.company_id = ${workspace.companyId} AND (
        r.issue_id IN (SELECT id FROM tree) OR r.native_issue_id IN (SELECT id FROM tree)
        OR r.context_snapshot->>'issueId' IN (SELECT id::text FROM tree)
        OR r.context_snapshot->>'taskId' IN (SELECT id::text FROM tree)
        OR r.context_snapshot->>'executionWorkspaceId' = ${workspace.id}
        OR r.id IN (SELECT unnest(ARRAY[checkout_run_id, execution_run_id]) FROM ${issues}
          WHERE company_id = ${workspace.companyId} AND execution_workspace_id = ${workspace.id})
      )
    ) SELECT CASE WHEN
      EXISTS (SELECT 1 FROM ${executionWorkspaces} other WHERE other.id <> ${workspace.id}
        AND (other.cwd = ${workspace.cwd} OR other.provider_ref = ${workspace.cwd}
          OR left(other.cwd, length(${workspace.cwd}) + 1) = ${workspace.cwd} || '/'))
      OR EXISTS (SELECT 1 FROM ${projectWorkspaces} WHERE cwd = ${workspace.cwd}
        OR left(cwd, length(${workspace.cwd}) + 1) = ${workspace.cwd} || '/')
    THEN false ELSE (
      EXISTS (SELECT 1 FROM tree)
      AND NOT EXISTS (SELECT 1 FROM tree WHERE status NOT IN ('done', 'cancelled')
        OR coalesce(CASE WHEN status = 'done' THEN completed_at ELSE cancelled_at END, updated_at) > ${new Date(now.getTime() - DAY_MS).toISOString()}::timestamptz)
      AND NOT EXISTS (SELECT 1 FROM ${issues} WHERE company_id = ${workspace.companyId}
        AND execution_workspace_id = ${workspace.id} AND status NOT IN ('done', 'cancelled'))
      AND NOT EXISTS (SELECT 1 FROM relevant_runs WHERE status NOT IN ('succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted')
        OR finished_at IS NULL OR controller_lease_expires_at > now())
      AND NOT EXISTS (SELECT 1 FROM ${issueRecoveryActions} WHERE company_id = ${workspace.companyId}
        AND source_issue_id IN (SELECT id FROM tree) AND status IN ('active', 'escalated'))
      AND NOT EXISTS (SELECT 1 FROM ${nativeRunFinalizations} f WHERE f.company_id = ${workspace.companyId}
        AND (f.issue_id IN (SELECT id FROM tree) OR f.run_id IN (SELECT id FROM relevant_runs))
        AND (f.phase <> 'committed' OR f.lease_owner IS NOT NULL OR f.recovery_state IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM ${environmentLeases} l WHERE l.company_id = ${workspace.companyId}
        AND (l.execution_workspace_id = ${workspace.id} OR l.heartbeat_run_id IN (SELECT id FROM relevant_runs))
        AND (l.status = 'pending_cleanup' OR l.cleanup_status = 'failed' OR l.metadata ? 'nativeWorkspaceExportResume'
          OR (l.released_at IS NULL AND NOT coalesce(l.status = 'retained' AND l.lease_policy = 'reuse_by_environment' AND l.cleanup_status = 'success', false))))
      AND NOT EXISTS (SELECT 1 FROM ${workspaceRuntimeServices} WHERE company_id = ${workspace.companyId}
        AND (execution_workspace_id = ${workspace.id} OR cwd = ${workspace.cwd}
          OR left(cwd, length(${workspace.cwd}) + 1) = ${workspace.cwd} || '/') AND status <> 'stopped')

    ) END AS allowed`);
  return rows[0]?.allowed === true;
}

export function hasPendingGitExpiration(workspace: Workspace) {
  const state = workspace.metadata?.[GIT_CACHE_EXPIRATION_KEY] as GitCacheExpiration | undefined;
  return state?.schema === "paperclip.git-cache-expiration.v1" && !state.completed;
}

export const LIVE_EXECUTION_WORKSPACE_STATUSES = ["active", "idle", "in_review"];

export function liveExecutionWorkspaceFilter() {
  return and(inArray(executionWorkspaces.status, LIVE_EXECUTION_WORKSPACE_STATUSES), isNull(executionWorkspaces.closedAt));
}

export function pendingGitExpirationFilter() {
  return and(inArray(executionWorkspaces.status, ["archived", "cleanup_failed"]),
    sql`${executionWorkspaces.metadata}->'gitCacheExpiration'->>'completed' = 'false'`);
}

export function gitExpirationSelectionFilter() {
  return and(isNotNull(executionWorkspaces.sourceIssueId), or(liveExecutionWorkspaceFilter(), pendingGitExpirationFilter()));
}

export function isGitExpirationCandidate(workspace: Workspace) {
  return workspace.providerType !== "plugin" && (hasPendingGitExpiration(workspace)
    || (workspace.mode === "isolated_workspace" && workspace.strategyType === "git_worktree"));
}

function managedCheckoutProver(db: Tx, workspace: Workspace, auth: GitRemoteAuthProvider, checkouts: Map<string, ManagedCheckoutContents>): ManagedCheckoutProver {
  let rows: Promise<Array<{ id: string; repoUrl: string | null; repoRef: string | null; cwd: string | null }>> | undefined;
  return async (checkoutPath, name, signal) => {
    if (!workspace.projectId) throw new Error("unknown_managed_checkout");
    rows ??= db.select({ id: projectWorkspaces.id, repoUrl: projectWorkspaces.repoUrl, repoRef: projectWorkspaces.repoRef,
      cwd: projectWorkspaces.cwd }).from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.companyId, workspace.companyId), eq(projectWorkspaces.projectId, workspace.projectId)));
    const source = selectRestoredProjectRepositories(await rows, readGitCacheRestoration(workspace)?.contents).find(row => row.repoUrl
      && managedProjectCheckoutName({ id: row.id, repoUrl: row.repoUrl, repoRef: row.repoRef, cwd: row.cwd }) === name);
    if (!source?.repoUrl) throw new Error("unknown_managed_checkout");
    await assertReproducibleManagedCheckout(checkoutPath, { repoUrl: source.repoUrl, resolveGitAuth: auth, signal });
    checkouts.set(name, await readManagedCheckoutContents(checkoutPath, name, { ...source, repoUrl: source.repoUrl }, signal));
  };
}

export type GitExpirationInspection = {
  workspace: Workspace;
  state: GitCacheExpiration | null;
  recipe: GitCacheRestoration;
  present: boolean;
  candidateBytes: number;
  auth: GitRemoteAuthProvider;
  checkouts: Map<string, ManagedCheckoutContents>;
  proveManagedCheckout: ManagedCheckoutProver;
};

export async function inspectLockedGitExpirationCandidate(tx: Tx, snapshot: Workspace,
  options: { now: Date; auth: GitRemoteAuthProvider; signal?: AbortSignal }): Promise<GitExpirationInspection> {
  const acquired = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${`execution_workspace_lifecycle:${snapshot.id}`}, 0)) as locked`);
  if (!acquired[0]?.locked) throw new Error("lifecycle_busy");
  const workspace = (await tx.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, snapshot.id), eq(executionWorkspaces.companyId, snapshot.companyId))))[0];
  if (!workspace || workspace.updatedAt.getTime() !== snapshot.updatedAt.getTime()) throw new Error("workspace_changed");
  if (!await isGitWorkspaceExpirationEligible(tx, workspace, options.now)) throw new Error("live_or_unresolved_consumer");
  const live = LIVE_EXECUTION_WORKSPACE_STATUSES.includes(workspace.status);
  // A restored active workspace starts a new expiration cycle and records its new HEAD.
  if (!live && !hasPendingGitExpiration(workspace)) throw new Error("not_expirable");
  const state = live ? null : readGitCacheExpiration(workspace);
  const auth = options.auth;
  const checkouts = new Map<string, ManagedCheckoutContents>();
  const proveManagedCheckout = managedCheckoutProver(tx, workspace, auth, checkouts);
  const recipe = state ? readGitCacheRestoration(workspace)! : await inspectGitCacheRecipe(workspace,
    auth, options.signal, { proveManagedCheckout });
  const present = await pathExists(recipe.worktreePath);
  if (!state && !present) throw new Error("missing_unverified_worktree");
  const candidateBytes = present ? await allocatedBytes(recipe.worktreePath, () => { options.signal?.throwIfAborted(); return true; }) : 0;
  return { workspace, state, recipe, present, candidateBytes, auth, checkouts, proveManagedCheckout };
}
