import { captureGitWorkspaceContents, assertGitWorkspaceContentsUnchanged, readManagedCheckoutContents } from "./git-workspace-contents.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { acquireGitExpirationLocks } from "./git-workspace-expiration-locks.js";
import { and, eq, ne, sql } from "drizzle-orm";
import { executionWorkspaces, workspaceRuntimeServices, projectWorkspaces, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { withIsolatedRepositorySourceLock, verifiedRecordedIsolatedRemoteSource } from "./isolated-remote-workspace-source.js";
import { assertReproducibleGitFiles, assertReproducibleBaseGitStorage, readGitCacheRestoration,
  verifyRemoteGitCommit, gitCacheExpirationLockLocations, recoverGitCacheExpirationLocks, gitCacheCommand, readGitCacheExpiration, finishGitCacheTrash, type GitCacheExpiration, GIT_CACHE_RESTORATION_KEY, GIT_CACHE_EXPIRATION_REASON } from "./git-workspace-restoration.js";
import { allocatedBytes, pathExists, gitExpirationSkipReason, expirationGitAuth, isGitWorkspaceExpirationEligible, inspectLockedGitExpirationCandidate,
  verifiedWorktreeAdmin, gitWorktreeTrashPath, GIT_CACHE_EXPIRATION_KEY, type Workspace } from "./git-workspace-expiration-inspection.js";

export { gitExpirationSkipReason, withAnonymousGitFallback, isGitWorkspaceExpirationEligible, hasPendingGitExpiration } from "./git-workspace-expiration-inspection.js";
const skipReason = gitExpirationSkipReason;
const exists = pathExists;
const EXPIRATION_KEY = GIT_CACHE_EXPIRATION_KEY;
type Expiration = GitCacheExpiration;
export type GitExpirationResult = { candidate: boolean; expired: boolean; reclaimedBytes: number;
  candidateBytes: number; baseExpired: boolean; skipReason: string | null };

/** Each ref/reflog object must be recoverable, and no other checkout may consume the base. */
async function inspectBase(db: Db, workspace: Workspace, signal?: AbortSignal, allowCurrentWorktree = false) {
  const recipe = readGitCacheRestoration(workspace)!;
  if (recipe.sourceKind !== "isolated_remote") throw new Error("shared_base_preserved");
  const other = await db.select().from(executionWorkspaces).where(and(ne(executionWorkspaces.id, workspace.id),
    sql`(${executionWorkspaces.metadata}->'isolatedRemoteSource'->>'companyId' = ${workspace.companyId}
      AND ${executionWorkspaces.metadata}->'isolatedRemoteSource'->>'issueId' = ${workspace.sourceIssueId})
      OR ${executionWorkspaces.cwd} = ${recipe.sourcePath} OR ${executionWorkspaces.providerRef} = ${recipe.sourcePath}`));
  if (other.some(row => !["archived", "cleanup_failed"].includes(row.status)
    || !readGitCacheRestoration(row) || !readGitCacheExpiration(row)?.workspaceRemoved)) throw new Error("base_has_consumers");
  const [projectConsumer] = await db.select({ id: projectWorkspaces.id }).from(projectWorkspaces).where(eq(projectWorkspaces.cwd, recipe.sourcePath)).limit(1);
  if (projectConsumer) throw new Error("base_has_consumers");
  const [service] = await db.select({ id: workspaceRuntimeServices.id }).from(workspaceRuntimeServices).where(sql`
    ${workspaceRuntimeServices.status} <> 'stopped' AND (${workspaceRuntimeServices.cwd} = ${recipe.sourcePath}
      OR left(${workspaceRuntimeServices.cwd}, length(${recipe.sourcePath}) + 1) = ${recipe.sourcePath} || '/')`).limit(1);
  if (service) throw new Error("base_has_live_services");
  await verifiedRecordedIsolatedRemoteSource(workspace);
  const worktrees = (await gitCacheCommand(recipe.sourcePath, ["worktree", "list", "--porcelain"], signal))
    .split("\n").filter(line => line.startsWith("worktree ")).map(line => line.slice(9));
  const allowed = [await fs.realpath(recipe.sourcePath), ...(allowCurrentWorktree ? [await fs.realpath(recipe.worktreePath)] : [])];
  if (worktrees.some(cwd => !allowed.includes(cwd))) throw new Error("base_has_worktrees");
  await assertReproducibleGitFiles(recipe.sourcePath, signal);
  await assertReproducibleBaseGitStorage(recipe.sourcePath, signal);
  const refs = (await gitCacheCommand(recipe.sourcePath, ["for-each-ref", "--format=%(objectname) %(refname)"], signal)).trim().split("\n").filter(Boolean);
  if (refs.some(ref => !/^[a-f0-9]{40} refs\/(heads|remotes\/origin)\//.test(ref))) throw new Error("unsupported_base_refs");
  const commits = new Set([...refs.map(ref => ref.split(" ")[0]!),
    ...(await gitCacheCommand(recipe.sourcePath, ["reflog", "show", "--all", "--format=%H"], signal)).trim().split("\n").filter(Boolean)]);
  if (commits.size > 50) throw new Error("base_ref_verification_budget");
  const auth = expirationGitAuth(db, workspace);
  for (const commit of commits) await verifyRemoteGitCommit(recipe.repoUrl, commit, auth, signal);
  // Unreachable objects may contain unique rewritten work not present in a reflog.
  const unreachable = await gitCacheCommand(recipe.sourcePath, ["fsck", "--no-reflogs", "--unreachable", "--no-progress"], signal);
  if (unreachable.trim()) throw new Error("unreachable_base_objects");
  return allocatedBytes(recipe.sourcePath, () => { signal?.throwIfAborted(); return true; });
}

export async function expireReconstructableGitWorkspace(db: Db, snapshot: Workspace, options: {
  dryRun: boolean; expireBase: boolean; now: Date; signal?: AbortSignal;
  beforeDelete?: (workspace: Workspace) => Promise<void>;
}): Promise<GitExpirationResult> {
  const result: GitExpirationResult = { candidate: false, expired: false, reclaimedBytes: 0,
    candidateBytes: 0, baseExpired: false, skipReason: null };
  if (!snapshot.sourceIssueId) return { ...result, skipReason: "missing_source_issue" };
  try {
    return await withIsolatedRepositorySourceLock(db, snapshot.companyId, snapshot.sourceIssueId, () =>
      withDedicatedDbConnection(db, connection => connection.transaction(async tx => {
        const inspection = await inspectLockedGitExpirationCandidate(tx, snapshot, { now: options.now, signal: options.signal, auth: expirationGitAuth(db, snapshot) });
        let { workspace, state } = inspection as { workspace: Workspace | undefined; state: Expiration | null };
        if (!workspace) throw new Error("workspace_changed");
        const { recipe, present, auth, checkouts, proveManagedCheckout } = inspection;
        const identity = { companyId: workspace.companyId, workspaceId: workspace.id };
        if (!state) recipe.contents = await captureGitWorkspaceContents(recipe.worktreePath, identity, [...checkouts.values()]);
        result.candidate = true;
        result.candidateBytes = inspection.candidateBytes;
        if (options.dryRun) {
          if (options.expireBase) {
            try { result.candidateBytes += await inspectBase(db, { ...workspace,
              metadata: { ...workspace.metadata, [GIT_CACHE_RESTORATION_KEY]: recipe } }, options.signal, present); }
            catch (error) { result.skipReason = skipReason(error); }
          }
          return result;
        }
        if (!state) {
          const generation = Number(workspace.metadata?.lifecycleGeneration ?? 0) + 1;
          const rawAdmin = (await gitCacheCommand(recipe.worktreePath, ["rev-parse", "--absolute-git-dir"], options.signal)).trim();
          const worktreeAdmin = await verifiedWorktreeAdmin(recipe.sourcePath, rawAdmin);
          state = { schema: "paperclip.git-cache-expiration.v1", generation, workspaceRemoved: false,
            worktreeTrash: gitWorktreeTrashPath(recipe.worktreePath, workspace.id, generation),
            worktreeAdmin, baseTrash: null, completed: false, lockToken: randomBytes(32).toString("hex") };
          if (await exists(state.worktreeTrash)) throw new Error("unknown_worktree_trash");
          // Commit the immutable restoration recipe BEFORE touching disk. The separate
          // lifecycle-lock connection remains held through deletion and final state.
          [workspace] = await db.update(executionWorkspaces).set({ status: "archived", closedAt: options.now,
            cleanupEligibleAt: options.now, cleanupReason: GIT_CACHE_EXPIRATION_REASON, updatedAt: options.now,
            metadata: { ...workspace.metadata, lifecycleGeneration: generation, [GIT_CACHE_RESTORATION_KEY]: recipe, [EXPIRATION_KEY]: state },
          }).where(eq(executionWorkspaces.id, workspace.id)).returning();
        }
        if (!workspace) throw new Error("workspace_changed");
        const persist = async () => {
          [workspace] = await db.update(executionWorkspaces).set({ metadata: { ...workspace!.metadata, [EXPIRATION_KEY]: state }, updatedAt: new Date() })
            .where(eq(executionWorkspaces.id, snapshot.id)).returning();
        };
        if (!state.lockToken) {
          state.lockToken = randomBytes(32).toString("hex");
          await persist();
        }
        await recoverGitCacheExpirationLocks(workspace!);
        const lockLocations = gitCacheExpirationLockLocations(workspace!);
        await options.beforeDelete?.(workspace!);
        if (!await isGitWorkspaceExpirationEligible(tx, workspace, options.now)) throw new Error("live_or_unresolved_consumer");
        if (!state.workspaceRemoved && present) {
          const locks = [await acquireGitExpirationLocks(lockLocations.filter(location => location.checkout === null), state.lockToken)];
          try {
            try {
              checkouts.clear();
              await assertReproducibleGitFiles(recipe.worktreePath, options.signal, { proveManagedCheckout, preserveSettings: true,
                verifyFetchedCommit: (commit, signal) => verifyRemoteGitCommit(recipe.repoUrl, commit, auth, signal) });
              for (const checkout of checkouts.values()) {
                const cwd = path.join(recipe.worktreePath, ".paperclip-repositories", checkout.name);
                locks.push(await acquireGitExpirationLocks(lockLocations.filter(location => location.checkout === checkout.name), state.lockToken));
                if ((await gitCacheCommand(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "-z"], options.signal)).length) throw new Error("managed_checkouts_changed");
                checkouts.set(checkout.name, await readManagedCheckoutContents(cwd, checkout.name, checkout.source, options.signal));
              }
              await assertGitWorkspaceContentsUnchanged(recipe.worktreePath, identity, recipe.contents, [...checkouts.values()]);
              if ((await gitCacheCommand(recipe.worktreePath, ["symbolic-ref", "--short", "HEAD"], options.signal)).trim() !== recipe.branchName) throw new Error("branch_identity_changed");
              if ((await gitCacheCommand(recipe.worktreePath, ["rev-parse", "HEAD"], options.signal)).trim() !== recipe.commit) throw new Error("head_changed");
            } catch (error) {
              for (const lock of [...locks].reverse()) await lock.release();
              const metadata: Record<string, unknown> = { ...workspace.metadata, lifecycleGeneration: state.generation + 1,
                [GIT_CACHE_RESTORATION_KEY]: { ...recipe, restoredAt: new Date().toISOString() } };
              delete metadata[EXPIRATION_KEY];
              await db.update(executionWorkspaces).set({ status: "active", closedAt: null, cleanupEligibleAt: null,
                cleanupReason: null, metadata, updatedAt: new Date() }).where(eq(executionWorkspaces.id, workspace.id));
              throw error;
            }
            await fs.rename(recipe.worktreePath, state.worktreeTrash);
            await finishGitCacheTrash(workspace);
            result.reclaimedBytes += result.candidateBytes;
          } finally { for (const lock of locks.reverse()) await lock.release(); }
        }
        await finishGitCacheTrash(workspace);
        state.workspaceRemoved = true;
        await persist();
        result.expired = true;
        if (options.expireBase) {
          try {
            if ((!state.baseTrash || !await exists(state.baseTrash)) && await exists(recipe.sourcePath)) {
              const bytes = await inspectBase(db, workspace!, options.signal);
              if (!await isGitWorkspaceExpirationEligible(tx, workspace!, options.now)) throw new Error("live_or_unresolved_consumer");
              const trash = path.join(path.dirname(recipe.sourcePath), `.expired-git-base-${snapshot.id}-${state.generation}`);
              if (await exists(trash)) throw new Error("unknown_base_trash");
              state.baseTrash = trash;
              await persist();
              await fs.rename(recipe.sourcePath, trash);
              result.candidateBytes += bytes;
            }
            if (state.baseTrash && await exists(state.baseTrash)) {
              const stat = await fs.lstat(state.baseTrash);
              if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe_base_trash");
              const bytes = await allocatedBytes(state.baseTrash, () => { options.signal?.throwIfAborted(); return true; });
              await fs.rm(state.baseTrash, { recursive: true, force: true });
              result.reclaimedBytes += bytes;
              result.baseExpired = true;
            }
          } catch (error) { result.skipReason = skipReason(error); }
        }
        state.completed = recipe.sourceKind !== "isolated_remote" || !options.expireBase || (result.baseExpired || !await exists(recipe.sourcePath)) && (!state.baseTrash || !await exists(state.baseTrash));
        await persist();
        return result;
      })), true);
  } catch (error) {
    options.signal?.throwIfAborted();
    result.skipReason = skipReason(error);
    return result;
  }
}
