import { captureGitWorkspaceContents, assertGitWorkspaceContentsUnchanged, readManagedCheckoutContents } from "./git-workspace-contents.js";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { acquireGitExpirationLocks } from "./git-workspace-expiration-locks.js";
import { and, eq, ne, sql } from "drizzle-orm";
import { executionWorkspaces, workspaceRuntimeServices, projectWorkspaces, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import type { StorageService } from "../storage/types.js";
import { currentRestorePointSnapshot, RestorePointSkip, type RestorePointLimits } from "./git-restore-point.js";
import { abandonGitRestorePoint, abandonGitRestorePointsByKey, activateGitRestorePoints, restorePointHistoryUnchanged, restorePointSnapshotMatches, storeGitRestorePoint } from "./git-restore-point-storage.js";
import { withIsolatedRepositorySourceLock, verifiedRecordedIsolatedRemoteSource } from "./isolated-remote-workspace-source.js";
import type { GitRemoteAuthProvider } from "./git-credentials.js";
import { assertReproducibleGitFiles, assertReproducibleBaseGitStorage, provenManagedCheckoutHistory, readGitCacheRestoration, GIT_CACHE_RESTORATION_SCHEMA_V2,
  verifyRemoteGitCommit, gitCacheExpirationLockLocations, recoverGitCacheExpirationLocks, gitCacheCommand, readGitCacheExpiration, finishGitCacheTrash, type GitCacheExpiration, GIT_CACHE_RESTORATION_KEY, GIT_CACHE_EXPIRATION_REASON } from "./git-workspace-restoration.js";
import { allocatedBytes, pathExists, gitExpirationSkipReason, expirationGitAuth, isGitWorkspaceExpirationEligible, inspectLockedGitExpirationCandidate, managedCheckoutProver,
  GIT_CACHE_EXPIRATION_KEY, type CheckoutRestorePointNeed, type Workspace } from "./git-workspace-expiration-inspection.js";

export { allocatedBytes, expirationScope, gitExpirationSkipReason, gitWorkspaceLastActivityAt, listIssuesUsingGitWorkspace, withAnonymousGitFallback, isGitWorkspaceExpirationEligible, hasPendingGitExpiration } from "./git-workspace-expiration-inspection.js";
const skipReason = gitExpirationSkipReason;
const exists = pathExists;
const EXPIRATION_KEY = GIT_CACHE_EXPIRATION_KEY;
type Expiration = GitCacheExpiration;
export type GitExpirationFailure = { name: string; code: string | null; at: string | null; stderr: string | null };

export type GitExpirationResult = { candidate: boolean; expired: boolean; reclaimedBytes: number;
  candidateBytes: number; baseExpired: boolean; skipReason: string | null; restorePoint: boolean; failure?: GitExpirationFailure };

function redactGitOutput(text: string) {
  return text.replace(/:\/\/[^@\s/]+@/g, "://<redacted>@")
    .replace(/(authorization|token|password|secret)(\s*[:=]\s*)[^\n]*/gi, "$1$2<redacted>");
}

function recordSkip(result: GitExpirationResult, error: unknown) {
  result.skipReason = error instanceof RestorePointSkip ? error.reason : skipReason(error);
  if (result.skipReason === "inspection_failed") result.failure = describeGitExpirationFailure(error);
}

export function describeGitExpirationFailure(error: unknown): GitExpirationFailure {
  if (!(error instanceof Error)) return { name: typeof error, code: null, at: null, stderr: null };
  const details = error as Error & { code?: unknown; stderr?: unknown };
  const frame = error.stack?.split("\n").slice(1).map(line => line.trim()).find(line => line.startsWith("at ")) ?? null;
  const stderr = typeof details.stderr === "string" ? details.stderr : Buffer.isBuffer(details.stderr) ? details.stderr.toString("utf8") : "";
  return {
    name: error.name,
    code: details.code === undefined || details.code === null ? null : String(details.code),
    at: frame ? frame.slice(0, 300) : null,
    stderr: stderr.trim() ? redactGitOutput(stderr.trim()).slice(0, 500) : null,
  };
}

export type GitRestorePointExpirationOptions = {
  storage: StorageService;
  notBefore: Date;
  keyDurable: boolean;
  limits?: Partial<RestorePointLimits>;
};

async function restorePointBoundary(cwd: string, repoUrl: string, headOnRemote: boolean, auth: GitRemoteAuthProvider, signal?: AbortSignal) {
  const head = (await gitCacheCommand(cwd, ["rev-parse", "--verify", "HEAD^{commit}"], signal)).trim();
  if (headOnRemote) return [head];
  const upstream = await gitCacheCommand(cwd, ["rev-parse", "--verify", "-q", "refs/remotes/origin/HEAD"], signal)
    .catch(() => "");
  const tip = upstream.trim();
  if (!tip) return [];
  const base = (await gitCacheCommand(cwd, ["merge-base", "HEAD", tip], signal).catch(() => "")).trim();
  if (!/^[a-f0-9]{40}$/.test(base)) return [];
  try { await verifyRemoteGitCommit(repoUrl, base, auth, signal); return [base]; }
  catch (error) { if (signal?.aborted) throw error; return []; }
}

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
  restorePoint?: GitRestorePointExpirationOptions;
  idleCutoff?: Date;
}): Promise<GitExpirationResult> {
  const result: GitExpirationResult = { candidate: false, expired: false, reclaimedBytes: 0,
    candidateBytes: 0, baseExpired: false, skipReason: null, restorePoint: false };
  let pendingRestorePoints: string[] = [];
  if (!snapshot.sourceIssueId) return { ...result, skipReason: "missing_source_issue" };
  try {
    return await withIsolatedRepositorySourceLock(db, snapshot.companyId, snapshot.sourceIssueId, () =>
      withDedicatedDbConnection(db, connection => connection.transaction(async tx => {
        const inspection = await inspectLockedGitExpirationCandidate(tx, snapshot, { now: options.now, signal: options.signal,
          auth: expirationGitAuth(db, snapshot), idleCutoff: options.idleCutoff, restorePoint: options.restorePoint });
        let { workspace, state } = inspection as { workspace: Workspace | undefined; state: Expiration | null };
        if (!workspace) throw new Error("workspace_changed");
        const { present, auth, checkouts, proveManagedCheckout, headOnRemote, needsRestorePoint, checkoutRestorePoints } = inspection;
        let { recipe } = inspection;
        if (needsRestorePoint) result.restorePoint = true;
        const identity = { companyId: workspace.companyId, workspaceId: workspace.id };
        if (!state) recipe.contents = await captureGitWorkspaceContents(recipe.worktreePath, identity, [...checkouts.values()]);
        result.candidate = true;
        result.candidateBytes = inspection.candidateBytes;
        if (options.dryRun) {
          if (options.expireBase) {
            try { result.candidateBytes += await inspectBase(db, { ...workspace,
              metadata: { ...workspace.metadata, [GIT_CACHE_RESTORATION_KEY]: recipe } }, options.signal, present); }
            catch (error) { recordSkip(result, error); }
          }
          return result;
        }
        if (!state) {
          const generation = Number(workspace.metadata?.lifecycleGeneration ?? 0) + 1;
          const rawAdmin = (await gitCacheCommand(recipe.worktreePath, ["rev-parse", "--absolute-git-dir"], options.signal)).trim();
          const worktreeAdmin = path.join(recipe.sourcePath, ".git", "worktrees", path.basename(rawAdmin));
          const canonicalAdmin = path.join(await fs.realpath(recipe.sourcePath), ".git", "worktrees", path.basename(rawAdmin));
          if (await fs.realpath(worktreeAdmin) !== canonicalAdmin || await fs.realpath(rawAdmin) !== canonicalAdmin) {
            throw new Error("unproven_worktree_admin");
          }
          if (needsRestorePoint) {
            const owner = { companyId: workspace.companyId, id: workspace.id, sourceIssueId: workspace.sourceIssueId };
            const stored = await storeGitRestorePoint({ db, storage: options.restorePoint!.storage, workspace: owner,
              cwd: recipe.worktreePath, generation, headOnRemote, limits: options.restorePoint!.limits, signal: options.signal,
              upstreamCommits: await restorePointBoundary(recipe.worktreePath, recipe.repoUrl, headOnRemote, auth, options.signal) });
            if (stored) {
              pendingRestorePoints.push(stored.ledgerId);
              recipe = { ...recipe, restorePoint: stored.ref };
            } else if (!headOnRemote) throw new Error("upstream_commit_unverified");
            for (const [name, need] of [...checkoutRestorePoints.entries()].sort(([a], [b]) => a.localeCompare(b))) {
              const storedCheckout = await storeGitRestorePoint({ db, storage: options.restorePoint!.storage, workspace: owner,
                cwd: need.path, checkout: name, generation, headOnRemote: need.headOnRemote,
                resolvePreserveCommits: async () => (await provenManagedCheckoutHistory(need.path, need.repoUrl, auth, options.signal)).preserve,
                limits: options.restorePoint!.limits,
                signal: options.signal, upstreamCommits: await restorePointBoundary(need.path, need.repoUrl, need.headOnRemote, auth, options.signal) });
              if (!storedCheckout) {
                if (!need.headOnRemote) throw new Error("unpushed_managed_checkout");
                continue;
              }
              pendingRestorePoints.push(storedCheckout.ledgerId);
              recipe = { ...recipe, contents: { ...recipe.contents!, checkouts: recipe.contents!.checkouts.map(checkout =>
                checkout.name === name ? { ...checkout, restorePoint: storedCheckout.ref } : checkout) } };
            }
            if (pendingRestorePoints.length > 0) recipe = { ...recipe, schema: GIT_CACHE_RESTORATION_SCHEMA_V2 };
          }
          state = { schema: "paperclip.git-cache-expiration.v1", generation, workspaceRemoved: false,
            worktreeTrash: path.join(path.dirname(recipe.worktreePath), `.expired-git-worktree-${workspace.id}-${generation}`),
            worktreeAdmin, baseTrash: null, completed: false, lockToken: randomBytes(32).toString("hex") };
          if (await exists(state.worktreeTrash)) throw new Error("unknown_worktree_trash");
          // Commit the immutable restoration recipe BEFORE touching disk. The separate
          // lifecycle-lock connection remains held through deletion and final state.
          const archive = { status: "archived", closedAt: options.now,
            cleanupEligibleAt: options.now, cleanupReason: GIT_CACHE_EXPIRATION_REASON, updatedAt: options.now,
            metadata: { ...workspace.metadata, lifecycleGeneration: generation, [GIT_CACHE_RESTORATION_KEY]: recipe, [EXPIRATION_KEY]: state },
          };
          [workspace] = await db.transaction(async (archiveTx) => {
            const rows = await archiveTx.update(executionWorkspaces).set(archive).where(eq(executionWorkspaces.id, workspace!.id)).returning();
            await activateGitRestorePoints(archiveTx, { ledgerIds: pendingRestorePoints, workspaceId: workspace!.id, at: options.now });
            return rows;
          });
          pendingRestorePoints = [];
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
        const lockLocations = await gitCacheExpirationLockLocations(workspace!);
        await options.beforeDelete?.(workspace!);
        if (!await isGitWorkspaceExpirationEligible(tx, workspace, options.now, options.idleCutoff)) throw new Error("live_or_unresolved_consumer");
        if (!state.workspaceRemoved && present) {
          const locks = [await acquireGitExpirationLocks(lockLocations.filter(location => location.checkout === null), state.lockToken)];
          try {
            try {
              checkouts.clear();
              const savedCheckoutRestorePoints = new Map((recipe.contents?.checkouts ?? []).filter(checkout => checkout.restorePoint)
                .map(checkout => [checkout.name, checkout.restorePoint!]));
              const relaxedChecks = new Map<string, CheckoutRestorePointNeed>();
              const relaxedProver = managedCheckoutProver(db, workspace, auth, checkouts, relaxedChecks);
              await assertReproducibleGitFiles(recipe.worktreePath, options.signal, { preserveSettings: true,
                proveManagedCheckout: async (checkoutPath, name, signal) => {
                  if (!savedCheckoutRestorePoints.has(name)) return proveManagedCheckout(checkoutPath, name, signal);
                  await relaxedProver(checkoutPath, name, signal);
                  if (!await restorePointHistoryUnchanged(savedCheckoutRestorePoints.get(name)!, checkoutPath, signal)) {
                    throw new Error("restore_point_contents_changed");
                  }
                },
                restorePoint: Boolean(recipe.restorePoint),
                verifyFetchedCommit: (commit, signal) => verifyRemoteGitCommit(recipe.repoUrl, commit, auth, signal) });
              if (recipe.restorePoint && (!restorePointSnapshotMatches(recipe.restorePoint,
                await currentRestorePointSnapshot(recipe.worktreePath, options.signal))
                || !await restorePointHistoryUnchanged(recipe.restorePoint, recipe.worktreePath, options.signal))) throw new Error("restore_point_contents_changed");
              for (const checkout of checkouts.values()) {
                const cwd = path.join(recipe.worktreePath, ".paperclip-repositories", checkout.name);
                locks.push(await acquireGitExpirationLocks(lockLocations.filter(location => location.checkout === checkout.name), state.lockToken));
                const savedCheckout = savedCheckoutRestorePoints.get(checkout.name);
                if (savedCheckout) {
                  if (!restorePointSnapshotMatches(savedCheckout, await currentRestorePointSnapshot(cwd, options.signal))) throw new Error("restore_point_contents_changed");
                } else if ((await gitCacheCommand(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "-z"], options.signal)).length) throw new Error("managed_checkouts_changed");
                checkouts.set(checkout.name, await readManagedCheckoutContents(cwd, checkout.name, checkout.source, options.signal));
              }
              await assertGitWorkspaceContentsUnchanged(recipe.worktreePath, identity, recipe.contents, [...checkouts.values()]);
              if ((await gitCacheCommand(recipe.worktreePath, ["symbolic-ref", "--short", "HEAD"], options.signal)).trim() !== recipe.branchName) throw new Error("branch_identity_changed");
              if ((await gitCacheCommand(recipe.worktreePath, ["rev-parse", "HEAD"], options.signal)).trim() !== recipe.commit) throw new Error("head_changed");
            } catch (error) {
              for (const lock of [...locks].reverse()) await lock.release();
              const { restorePoint: _abandoned, ...reproducible } = recipe;
              const strippedContents = reproducible.contents && { ...reproducible.contents,
                checkouts: reproducible.contents.checkouts.map(({ restorePoint: _checkoutRestorePoint, ...checkout }) => checkout) };
              const metadata: Record<string, unknown> = { ...workspace.metadata, lifecycleGeneration: state.generation + 1,
                [GIT_CACHE_RESTORATION_KEY]: { ...reproducible, ...(strippedContents ? { contents: strippedContents } : {}),
                  schema: "paperclip.git-cache-restoration.v1", restoredAt: new Date().toISOString() } };
              delete metadata[EXPIRATION_KEY];
              await db.update(executionWorkspaces).set({ status: "active", closedAt: null, cleanupEligibleAt: null,
                cleanupReason: null, metadata, updatedAt: new Date() }).where(eq(executionWorkspaces.id, workspace.id));
              await abandonGitRestorePointsByKey(db, workspace.id, [recipe.restorePoint?.objectKey,
                ...(recipe.contents?.checkouts ?? []).map(checkout => checkout.restorePoint?.objectKey)].filter((key): key is string => Boolean(key)));
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
              if (!await isGitWorkspaceExpirationEligible(tx, workspace!, options.now, options.idleCutoff)) throw new Error("live_or_unresolved_consumer");
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
          } catch (error) { recordSkip(result, error); }
        }
        state.completed = recipe.sourceKind !== "isolated_remote" || !options.expireBase || (result.baseExpired || !await exists(recipe.sourcePath)) && (!state.baseTrash || !await exists(state.baseTrash));
        await persist();
        return result;
      })), true);
  } catch (error) {
    for (const ledgerId of pendingRestorePoints) await abandonGitRestorePoint(db, ledgerId).catch(() => undefined);
    options.signal?.throwIfAborted();
    recordSkip(result, error);
    return result;
  }
}
