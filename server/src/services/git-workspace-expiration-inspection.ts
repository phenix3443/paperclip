import { assertWorkspaceRetentionAllowsRemoval } from "./detached-repository-retention-guard.js";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { executionWorkspaces, issues, heartbeatRuns, nativeRunFinalizations, environmentLeases,
  workspaceRuntimeServices, issueRecoveryActions, projectWorkspaces, type Db } from "@paperclipai/db";
import { readManagedCheckoutContents, selectRestoredProjectRepositories, type ManagedCheckoutContents } from "./git-workspace-contents.js";
import { createIssueGitRemoteAuthProvider, type GitRemoteAuthProvider } from "./git-credentials.js";
import { readBoundedDirectory } from "./git-expiration-budget.js";
import { managedProjectCheckoutName } from "./managed-project-checkout-name.js";
import { nestedRepositoryBaseCandidates } from "./nested-repository-worktrees.js";
import { TASK_DIRECTORY_RETENTION_KEY } from "./isolated-task-directory-snapshot.js";
import { assertReproducibleManagedCheckout, inspectGitCacheRecipe, inspectGitCacheRecipeForRestorePoint, readGitCacheRestoration, readGitCacheExpiration,
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
  if (entry.isDirectory()) {
    for (const child of await readBoundedDirectory(target)) bytes += await allocatedBytes(path.join(target, child.name), shouldContinue);
  }
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
  return withAnonymousGitFallback(createIssueGitRemoteAuthProvider(db, workspace.companyId, workspace.sourceIssueId!));
}

/** Re-read the whole tree and every runtime/recovery consumer immediately before deletion. */
export function expirationScope(workspace: Workspace) {
  // Decode the three legacy keys together only after cheap native/pointer
  // matches fail. Strict JSONPath leaves non-object inputs unmatched, as ->>
  // did, while those inputs can still match an independent native binding.
  return sql`
    WITH RECURSIVE tree AS (
      SELECT id, status, completed_at, cancelled_at, updated_at FROM ${issues}
      WHERE company_id = ${workspace.companyId} AND id = ${workspace.sourceIssueId}
      UNION
      SELECT c.id, c.status, c.completed_at, c.cancelled_at, c.updated_at FROM ${issues} c
      JOIN tree p ON c.parent_id = p.id WHERE c.company_id = ${workspace.companyId}
    ), bound AS (
      SELECT id, updated_at, checkout_run_id, execution_run_id FROM ${issues}
      WHERE company_id = ${workspace.companyId} AND execution_workspace_id = ${workspace.id}
    ), legacy_issue_ids AS MATERIALIZED (
      SELECT unnest(array_agg(id::text)) AS id FROM tree
    ), relevant_runs AS (
      SELECT r.id, r.status, r.created_at, r.started_at, r.finished_at, r.controller_lease_expires_at
      FROM ${heartbeatRuns} r WHERE r.company_id = ${workspace.companyId} AND (
        r.issue_id IN (SELECT id FROM tree) OR r.native_issue_id IN (SELECT id FROM tree)
        OR r.issue_id IN (SELECT id FROM bound) OR r.native_issue_id IN (SELECT id FROM bound)
        OR r.id IN (SELECT unnest(ARRAY[checkout_run_id, execution_run_id]) FROM bound)
        OR EXISTS (
          SELECT 1 FROM jsonb_to_record(
            jsonb_path_query_first(r.context_snapshot, 'strict $ ? (@.type() == "object")')
          ) context("issueId" text, "taskId" text, "executionWorkspaceId" text)
          WHERE context."issueId" IN (SELECT id FROM legacy_issue_ids)
            OR context."taskId" IN (SELECT id FROM legacy_issue_ids)
            OR context."executionWorkspaceId" = ${workspace.id}
        )
      )
    )`;
}

function issueUsesWorkspace(workspace: Pick<Workspace, "id" | "sourceIssueId">) {
  return sql`(${issues.id} = ${workspace.sourceIssueId} OR ${issues.executionWorkspaceId} = ${workspace.id}
    OR (${issues.workspaceSelection}->'selection'->>'kind' = 'existing'
      AND ${issues.workspaceSelection}->'selection'->>'workspaceId' = ${workspace.id})
    OR (${issues.workspacePendingSelection}->'intent'->'selection'->>'kind' = 'existing'
      AND ${issues.workspacePendingSelection}->'intent'->'selection'->>'workspaceId' = ${workspace.id}))`;
}

export async function listIssuesUsingGitWorkspace(db: Db | Tx, workspace: Pick<Workspace, "id" | "companyId" | "sourceIssueId">, issueIds: string[]) {
  if (issueIds.length === 0) return new Set<string>();
  const rows = await db.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.companyId, workspace.companyId), inArray(issues.id, issueIds), issueUsesWorkspace(workspace)));
  return new Set(rows.map(row => row.id));
}

export async function gitWorkspaceLastActivityAt(db: Db | Tx, workspace: Workspace): Promise<Date | null> {
  if (!workspace.sourceIssueId) return null;
  const rows = await db.execute<{ at: string | Date | null }>(sql`${expirationScope(workspace)}
    SELECT greatest(
      (SELECT max(updated_at) FROM tree),
      (SELECT max(updated_at) FROM bound),
      (SELECT max(greatest(created_at, started_at, finished_at)) FROM relevant_runs)
    ) AS at`);
  const at = rows[0]?.at;
  return at ? new Date(at) : null;
}

export async function isGitWorkspaceExpirationEligible(tx: Tx, workspace: Workspace, now: Date, idleCutoff?: Date,
  options: { closedSiblingsAllowed?: boolean } = {}) {
  if (workspace.metadata?.reopenPendingConsumption === true) return false;
  const siblingBlocks = options.closedSiblingsAllowed
    ? sql`AND (other.status NOT IN ('archived', 'cleanup_failed') OR other.closed_at IS NULL
        OR other.metadata->${TASK_DIRECTORY_RETENTION_KEY}->>'removed' = 'false')`
    : sql``;
  const closedTree = idleCutoff ? sql`
      NOT EXISTS (SELECT 1 FROM tree WHERE updated_at > ${idleCutoff.toISOString()}::timestamptz)
      AND NOT EXISTS (SELECT 1 FROM bound WHERE updated_at > ${idleCutoff.toISOString()}::timestamptz)
      AND NOT EXISTS (SELECT 1 FROM relevant_runs WHERE greatest(created_at, started_at, finished_at) > ${idleCutoff.toISOString()}::timestamptz)` : sql`
      NOT EXISTS (SELECT 1 FROM ${issues} WHERE ${issues.companyId} = ${workspace.companyId}
        AND ${issues.id} IN (SELECT id FROM tree) AND ${issueUsesWorkspace(workspace)}
        AND (${issues.status} NOT IN ('done', 'cancelled')
          OR coalesce(CASE WHEN ${issues.status} = 'done' THEN ${issues.completedAt} ELSE ${issues.cancelledAt} END, ${issues.updatedAt}) > ${new Date(now.getTime() - DAY_MS).toISOString()}::timestamptz))
      AND NOT EXISTS (SELECT 1 FROM ${issues} WHERE company_id = ${workspace.companyId}
        AND execution_workspace_id = ${workspace.id} AND status NOT IN ('done', 'cancelled'))`;
  const recoveryActionBlocks = idleCutoff ? sql`true` : sql`(cause = 'native_workspace_finalization_owner_unverified'
          OR evidence->'systemRecovery'->>'state' IN ('scheduled', 'running', 'awaiting_evidence'))`;
  const finalizationBlocks = idleCutoff
    ? sql`(f.phase <> 'committed' OR f.lease_owner IS NOT NULL OR f.recovery_state IS NOT NULL)`
    : sql`(f.lease_owner IS NOT NULL OR f.phase NOT IN ('committed', 'terminal_failure'))`;
  const rows = await tx.execute<{ allowed: boolean }>(sql`${expirationScope(workspace)}
    SELECT CASE WHEN
      EXISTS (SELECT 1 FROM ${executionWorkspaces} other WHERE other.id <> ${workspace.id}
        AND (other.cwd = ${workspace.cwd} OR other.provider_ref = ${workspace.cwd}
          OR left(other.cwd, length(${workspace.cwd}) + 1) = ${workspace.cwd} || '/') ${siblingBlocks})
      OR EXISTS (SELECT 1 FROM ${projectWorkspaces} WHERE cwd = ${workspace.cwd}
        OR left(cwd, length(${workspace.cwd}) + 1) = ${workspace.cwd} || '/')
    THEN false ELSE (
      EXISTS (SELECT 1 FROM tree)
      AND ${closedTree}
      AND NOT EXISTS (SELECT 1 FROM relevant_runs WHERE status NOT IN ('succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted')
        OR finished_at IS NULL OR controller_lease_expires_at > now())
      AND NOT EXISTS (SELECT 1 FROM ${issueRecoveryActions} WHERE company_id = ${workspace.companyId}
        AND source_issue_id IN (SELECT id FROM tree) AND status IN ('active', 'escalated')
        AND ${recoveryActionBlocks})
      AND NOT EXISTS (SELECT 1 FROM ${nativeRunFinalizations} f WHERE f.company_id = ${workspace.companyId}
        AND (f.issue_id IN (SELECT id FROM tree) OR f.run_id IN (SELECT id FROM relevant_runs))
        AND ${finalizationBlocks})
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

export const RESTORE_POINT_RELAXABLE = new Set(["dirty_or_untracked_files", "unique_ignored_files", "unique_original_head",
  "unique_reflog_commits", "upstream_commit_unverified", "unpushed_managed_checkout"]);
const CHECKOUT_RESTORE_POINT_RELAXABLE = new Set(["dirty_or_untracked_files", "unpushed_managed_checkout", "unique_ignored_files",
  "unique_original_head", "unique_reflog_commits"]);

export type CheckoutRestorePointNeed = { headOnRemote: boolean; path: string; repoUrl: string };
const skipReason = gitExpirationSkipReason;

export function managedCheckoutProver(db: Db | Tx, workspace: Workspace, auth: GitRemoteAuthProvider, checkouts: Map<string, ManagedCheckoutContents>,
  restorePoints?: Map<string, CheckoutRestorePointNeed>): ManagedCheckoutProver {
  let rows: Promise<Array<{ id: string; repoUrl: string | null; repoRef: string | null; cwd: string | null }>> | undefined;
  return async (checkoutPath, name, signal) => {
    if (!workspace.projectId) throw new Error("unknown_managed_checkout");
    rows ??= db.select({ id: projectWorkspaces.id, repoUrl: projectWorkspaces.repoUrl, repoRef: projectWorkspaces.repoRef,
      cwd: projectWorkspaces.cwd }).from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.companyId, workspace.companyId), eq(projectWorkspaces.projectId, workspace.projectId)));
    const source = selectRestoredProjectRepositories(await rows, readGitCacheRestoration(workspace)?.contents).find(row => row.repoUrl
      && managedProjectCheckoutName({ id: row.id, repoUrl: row.repoUrl, repoRef: row.repoRef, cwd: row.cwd }) === name);
    if (!source?.repoUrl) throw new Error("unknown_managed_checkout");
    const baseCandidates = nestedRepositoryBaseCandidates({ companyId: workspace.companyId, projectId: workspace.projectId, repoUrl: source.repoUrl });
    try { await assertReproducibleManagedCheckout(checkoutPath, { repoUrl: source.repoUrl, resolveGitAuth: auth, signal, baseCandidates }); }
    catch (error) {
      if (!restorePoints || !CHECKOUT_RESTORE_POINT_RELAXABLE.has(skipReason(error))) throw error;
      const { headOnRemote } = await assertReproducibleManagedCheckout(checkoutPath, { repoUrl: source.repoUrl, resolveGitAuth: auth, signal, restorePoint: true, baseCandidates });
      restorePoints.set(name, { headOnRemote, path: checkoutPath, repoUrl: source.repoUrl });
    }
    checkouts.set(name, await readManagedCheckoutContents(checkoutPath, name, { ...source, repoUrl: source.repoUrl }, signal));
  };
}

export type GitExpirationInspection = {
  workspace: Workspace;
  state: GitCacheExpiration | null;
  recipe: GitCacheRestoration;
  headOnRemote: boolean;
  needsRestorePoint: boolean;
  checkoutRestorePoints: Map<string, CheckoutRestorePointNeed>;
  present: boolean;
  candidateBytes: number;
  auth: GitRemoteAuthProvider;
  checkouts: Map<string, ManagedCheckoutContents>;
  proveManagedCheckout: ManagedCheckoutProver;
};

export async function inspectLockedGitExpirationCandidate(tx: Tx, snapshot: Workspace,
  options: { now: Date; auth: GitRemoteAuthProvider; signal?: AbortSignal; idleCutoff?: Date;
    restorePoint?: { notBefore: Date; keyDurable: boolean };
    onRestorePointFallback?: () => void;
    observeCurrent?: (current: { workspace: Workspace; updatedAtKey: string } | null) => void }): Promise<GitExpirationInspection> {
  const acquired = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtextextended(${`execution_workspace_lifecycle:${snapshot.id}`}, 0)) as locked`);
  if (!acquired[0]?.locked) throw new Error("lifecycle_busy");
  const current = (await tx.select({ workspace: executionWorkspaces, updatedAtKey: sql<string>`${executionWorkspaces.updatedAt}::text` })
    .from(executionWorkspaces).where(and(eq(executionWorkspaces.id, snapshot.id), eq(executionWorkspaces.companyId, snapshot.companyId))))[0] ?? null;
  options.observeCurrent?.(current);
  const workspace = current?.workspace;
  if (!workspace || workspace.updatedAt.getTime() !== snapshot.updatedAt.getTime()) throw new Error("workspace_changed");
  await assertWorkspaceRetentionAllowsRemoval(tx, workspace);
  if (!await isGitWorkspaceExpirationEligible(tx, workspace, options.now, options.idleCutoff)) throw new Error("live_or_unresolved_consumer");
  const live = LIVE_EXECUTION_WORKSPACE_STATUSES.includes(workspace.status);
  // A restored active workspace starts a new expiration cycle and records its new HEAD.
  if (!live && !hasPendingGitExpiration(workspace)) throw new Error("not_expirable");
  const state = live ? null : readGitCacheExpiration(workspace);
  const auth = options.auth;
  const checkouts = new Map<string, ManagedCheckoutContents>();
  const proveManagedCheckout = managedCheckoutProver(tx, workspace, auth, checkouts);
  const checkoutRestorePoints = new Map<string, CheckoutRestorePointNeed>();
  let headOnRemote = true;
  let needsRestorePoint = false;
  let recipe: GitCacheRestoration;
  if (state) recipe = readGitCacheRestoration(workspace)!;
  else {
    try { recipe = await inspectGitCacheRecipe(workspace, auth, options.signal, { proveManagedCheckout }); }
    catch (error) {
      if (!options.restorePoint || !RESTORE_POINT_RELAXABLE.has(skipReason(error))) throw error;
      if (options.now.getTime() < options.restorePoint.notBefore.getTime()) throw new Error("restore_point_not_due");
      if (!options.restorePoint.keyDurable) throw new Error("restore_point_key_not_durable");
      checkouts.clear();
      checkoutRestorePoints.clear();
      const inspected = await inspectGitCacheRecipeForRestorePoint(workspace, auth, options.signal, {
        proveManagedCheckout: managedCheckoutProver(tx, workspace, auth, checkouts, checkoutRestorePoints) });
      recipe = inspected.recipe;
      headOnRemote = inspected.headOnRemote;
      needsRestorePoint = true;
      options.onRestorePointFallback?.();
    }
  }
  const present = await pathExists(recipe.worktreePath);
  if (!state && !present) throw new Error("missing_unverified_worktree");
  const candidateBytes = present ? await allocatedBytes(recipe.worktreePath, () => { options.signal?.throwIfAborted(); return true; }) : 0;
  return { workspace, state, recipe, headOnRemote, needsRestorePoint, checkoutRestorePoints, present, candidateBytes, auth, checkouts, proveManagedCheckout };
}
