import { and, asc, eq, sql } from "drizzle-orm";
import { createDb, executionWorkspaces, terminateDbConnections, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { createEnvironmentGitRemoteAuthProvider, type GitRemoteAuthProvider } from "./git-credentials.js";
import { withIsolatedRepositorySourceLock, IsolatedRepositorySourceBusy } from "./isolated-remote-workspace-source.js";
import { withWorkspaceLockKeepalive } from "./native-runtime/native-workspace-lock-keepalive.js";
import { GitExpirationBudgetExceeded, InspectionBudget, isScratchQuotaError, ROW_DRAIN_BOUND_MS,
  type InspectionBudgetHooks } from "./git-expiration-budget.js";
import { inspectLockedGitExpirationCandidate, gitExpirationSkipReason, gitExpirationSelectionFilter, isGitExpirationCandidate,
  LIVE_EXECUTION_WORKSPACE_STATUSES, pathExists, withAnonymousGitFallback, type Workspace } from "./git-workspace-expiration-inspection.js";

export const GIT_EXPIRATION_ROUND_PAGE_SIZE = 50;
export const GIT_EXPIRATION_ROUND_APPLICATION_NAME = "paperclip-git-expiration-round";
export const GIT_EXPIRATION_ROUND_SESSION_PARAMETERS = {
  default_transaction_read_only: "on",
  client_connection_check_interval: "1000",
};

export type GitExpirationRoundMode = { enabled: true; dryRun: true; expireBase: false };
export const GIT_EXPIRATION_ROUND_MODE: GitExpirationRoundMode = { enabled: true, dryRun: true, expireBase: false };

export class GitExpirationRoundInvariantError extends Error {}

export function assertGitExpirationRoundMode(mode: { enabled?: unknown; dryRun?: unknown; expireBase?: unknown }): asserts mode is GitExpirationRoundMode {
  if (mode.dryRun !== true) throw new GitExpirationRoundInvariantError("dry_run_required");
  if (mode.enabled !== true) throw new GitExpirationRoundInvariantError("expiration_enabled_required");
  if (mode.expireBase !== false) throw new GitExpirationRoundInvariantError("base_expiration_forbidden");
}

export type GitExpirationRoundKey = { updatedAt: string; id: string };

export type GitExpirationRoundCurrentRow = { state: "read"; key: GitExpirationRoundKey; status: string }
  | { state: "missing" } | { state: "not_read" };

export type GitExpirationRoundRow = {
  key: GitExpirationRoundKey;
  workspaceId: string;
  companyId: string;
  status: string;
  current: GitExpirationRoundCurrentRow;
  outcome: "candidate" | "rejected" | "not_candidate" | "lock_busy" | "resource_limit";
  reason: string | null;
  pendingExpiration: boolean;
  candidateBytes: number;
};

export type GitExpirationRoundStatus = "complete" | "partial";
export type GitExpirationRoundStopReason = "lock_busy" | "aborted" | "deadline" | "row_budget" | "evidence_lost"
  | "resource_limit" | "database_error" | null;

export type GitExpirationRoundSummary = {
  roundId: string;
  status: GitExpirationRoundStatus;
  stopReason: GitExpirationRoundStopReason;
  upperBound: string | null;
  exhausted: boolean;
  pages: number;
  selected: number;
  inspected: number;
  candidates: number;
  rejected: number;
  notCandidates: number;
  lockBusy: number;
  resourceLimited: number;
  candidateBytes: number;
  lastSelectedKey: GitExpirationRoundKey | null;
  lastCompletedKey: GitExpirationRoundKey | null;
  /** True when a row's lock chain had not unwound within the drain bound; its locks stay held. */
  drainIncomplete: boolean;
  undrainedRow: GitExpirationRoundKey | null;
  limits: string[];
};

export type GitExpirationRoundEvent =
  | { type: "round_started"; roundId: string; upperBound: string; mode: GitExpirationRoundMode; pageSize: number;
    companyId: string | null; maxRows: number | null; deadline: string | null }
  | { type: "page_selected"; page: number; keys: GitExpirationRoundKey[] }
  | ({ type: "row_inspected" } & GitExpirationRoundRow)
  | ({ type: "round_finished" } & Omit<GitExpirationRoundSummary, "status"> & { status: "partial" | "pending_commit" })
  | { type: "round_committed"; roundId: string; status: "complete" };

export type GitExpirationRoundJournal = { append(event: GitExpirationRoundEvent): Promise<void> };

export type GitExpirationRoundOptions = {
  databaseUrl: string;
  mode: GitExpirationRoundMode;
  roundId: string;
  journal: GitExpirationRoundJournal;
  companyId?: string;
  signal?: AbortSignal;
  deadline?: Date;
  maxRows?: number;
  pageSize?: number;
  auth?: GitRemoteAuthProvider;
  /**
   * Receives the lock chain of a row that did not drain within the bound. The
   * caller must keep the process alive until it settles, so the locks are never
   * released while the row's Git children or walks still run.
   */
  onUndrainedRow?: (released: Promise<void>) => void;
  /** Test seam for the per-row ledger. */
  budgetHooks?: InspectionBudgetHooks;
};

const ROUND_LIMITS = [
  "rows updated after selection may move beyond upperBound and are not followed",
  "rows written with an updatedAt at or below upperBound after the round started may be missed",
  "settings capture for restoration metadata is not exercised; only reconstruction proof is",
  "remote proof uses only server environment Git credentials; rows that need managed or company-secret credentials are rejected",
];

const RESOURCE_LIMIT_REASONS = new Set(["managed_checkout_budget", "managed_checkout_local_tip_budget",
  "worktree_fetch_head_budget", "base_ref_verification_budget"]);

function errorChain(error: unknown) {
  const chain: Error[] = [];
  for (let current = error; current instanceof Error && chain.length < 8 && !chain.includes(current); current = current.cause) chain.push(current);
  return chain;
}

export function gitExpirationRoundFailure(error: unknown): { kind: "database" | "resource_limit"; reason: string } | null {
  const chain = errorChain(error);
  const budget = chain.find((entry): entry is GitExpirationBudgetExceeded => entry instanceof GitExpirationBudgetExceeded);
  if (budget) return { kind: "resource_limit", reason: budget.budget };
  if (chain.some(isScratchQuotaError)) return { kind: "resource_limit", reason: "scratch" };
  for (const entry of chain) {
    const { code, killed, signal } = entry as Error & { code?: unknown; killed?: unknown; signal?: unknown };
    if (entry.name === "PostgresError" || entry.name === "DrizzleQueryError" || (typeof code === "string" && code.startsWith("CONNECTION_"))) {
      return { kind: "database", reason: "database_error" };
    }
    if (RESOURCE_LIMIT_REASONS.has(entry.message)) return { kind: "resource_limit", reason: entry.message };
    if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return { kind: "resource_limit", reason: "git_output_limit" };
    if (killed === true && signal === "SIGTERM") return { kind: "resource_limit", reason: "git_timeout" };
  }
  return null;
}

export function readOnlyInspectionGitAuth(env: NodeJS.ProcessEnv = process.env): GitRemoteAuthProvider {
  return withAnonymousGitFallback(createEnvironmentGitRemoteAuthProvider(env));
}

type RowInspection = {
  /** Settles when the row result is known: work returned or threw, or the row signal aborted. */
  outcome: Promise<GitExpirationRoundRow>;
  /** Settles when the whole lock chain has unwound, after every Git group of the row is gone. */
  released: Promise<void>;
};

function inspectRow(db: Db, workspace: Workspace, key: GitExpirationRoundKey, auth: GitRemoteAuthProvider,
  roundSignal: AbortSignal, hooks: InspectionBudgetHooks | undefined): RowInspection {
  let current: GitExpirationRoundCurrentRow = { state: "not_read" };
  const row = (): GitExpirationRoundRow => ({ key, workspaceId: workspace.id, companyId: workspace.companyId, status: workspace.status,
    current, outcome: "rejected", reason: null, pendingExpiration: false, candidateBytes: 0 });
  const settled = (value: GitExpirationRoundRow): RowInspection => ({ outcome: Promise.resolve(value), released: Promise.resolve() });
  if (!isGitExpirationCandidate(workspace)) return settled({ ...row(), outcome: "not_candidate", reason: "not_git_expiration_candidate" });
  if (!workspace.sourceIssueId) return settled({ ...row(), reason: "missing_source_issue" });
  const sourceIssueId = workspace.sourceIssueId;
  const observeCurrent = (reread: { workspace: Workspace; updatedAtKey: string } | null) => {
    current = reread ? { state: "read", key: { updatedAt: reread.updatedAtKey, id: reread.workspace.id }, status: reread.workspace.status }
      : { state: "missing" };
    if (!reread || reread.updatedAtKey !== key.updatedAt) throw new Error("workspace_changed");
  };
  const budget = new InspectionBudget(roundSignal, hooks);
  const signal = budget.signal;
  // Lock order: source, then lifecycle. No finalizer of this chain runs before the
  // work and the ledger drain have settled.
  const chain = budget.run(() => withIsolatedRepositorySourceLock(db, workspace.companyId, sourceIssueId, () =>
    withDedicatedDbConnection(db, connection => connection.transaction(async tx => {
      const [setting] = await tx.execute<{ idle_timeout_ms: string | null }>(sql`select setting as idle_timeout_ms
        from pg_settings where name = 'idle_in_transaction_session_timeout'`);
      return withWorkspaceLockKeepalive(tx, Number(setting?.idle_timeout_ms), async () => {
        try {
          const inspection = await inspectLockedGitExpirationCandidate(tx, workspace, { now: new Date(), auth, signal, observeCurrent });
          const live = LIVE_EXECUTION_WORKSPACE_STATUSES.includes(inspection.workspace.status);
          if (!live && !inspection.state) throw new Error("missing_restoration_recipe");
          if (inspection.state && (await pathExists(inspection.state.worktreeTrash)
            || (inspection.state.baseTrash && await pathExists(inspection.state.baseTrash)))) throw new Error("ambiguous_expiration_trash");
          return { ...row(), outcome: "candidate" as const, pendingExpiration: !!inspection.state, candidateBytes: inspection.candidateBytes };
        } finally {
          await budget.drain();
        }
      });
    })), true));
  const classify = (error: unknown): GitExpirationRoundRow => {
    roundSignal.throwIfAborted();
    if (error instanceof IsolatedRepositorySourceBusy || (error instanceof Error && error.message === "lifecycle_busy")) {
      return { ...row(), outcome: "lock_busy", reason: "lock_busy" };
    }
    const failure = gitExpirationRoundFailure(error);
    if (failure?.kind === "database") throw error;
    if (failure) return { ...row(), outcome: "resource_limit", reason: failure.reason };
    return { ...row(), reason: gitExpirationSkipReason(error) };
  };
  const stopped = new Promise<GitExpirationRoundRow>((resolve, reject) => {
    const onAbort = () => {
      try { resolve(classify(signal.reason)); } catch (error) { reject(error); }
    };
    if (signal.aborted) onAbort();
    else {
      signal.addEventListener("abort", onAbort, { once: true });
      chain.then(() => signal.removeEventListener("abort", onAbort), () => signal.removeEventListener("abort", onAbort));
    }
  });
  const finished = chain.then(value => value, classify);
  const outcome = Promise.race([finished, stopped]);
  // The loser of the race must not surface as an unhandled rejection.
  finished.catch(() => undefined);
  stopped.catch(() => undefined);
  return { outcome, released: chain.then(() => undefined, () => undefined) };
}

/** Resolves true when `released` settles within the bound after the outcome, false otherwise. */
async function awaitRelease(released: Promise<void>) {
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ROW_DRAIN_BOUND_MS); });
  try {
    return await Promise.race([released.then(() => true as const), bound]);
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectGitExpirationRound(options: GitExpirationRoundOptions): Promise<GitExpirationRoundSummary> {
  assertGitExpirationRoundMode(options.mode);
  const pageSize = options.pageSize ?? GIT_EXPIRATION_ROUND_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new GitExpirationRoundInvariantError("invalid_page_size");
  if (options.maxRows !== undefined && (!Number.isSafeInteger(options.maxRows) || options.maxRows < 0)) throw new GitExpirationRoundInvariantError("invalid_row_budget");
  const signals = [options.signal, options.deadline ? AbortSignal.timeout(Math.max(0, options.deadline.getTime() - Date.now())) : undefined]
    .filter((signal): signal is AbortSignal => !!signal);
  const signal = AbortSignal.any(signals);
  const stopReason = (): GitExpirationRoundStopReason => {
    if (options.signal?.aborted) return "aborted";
    if (signal.aborted || (options.deadline && Date.now() >= options.deadline.getTime())) return "deadline";
    return null;
  };
  const auth = options.auth ?? readOnlyInspectionGitAuth();
  const summary: GitExpirationRoundSummary = { roundId: options.roundId, status: "partial", stopReason: null, upperBound: null,
    exhausted: false, pages: 0, selected: 0, inspected: 0, candidates: 0, rejected: 0, notCandidates: 0, lockBusy: 0,
    resourceLimited: 0, candidateBytes: 0, lastSelectedKey: null, lastCompletedKey: null, drainIncomplete: false,
    undrainedRow: null, limits: ROUND_LIMITS };
  let evidenceLost = false;
  const record = async (event: GitExpirationRoundEvent) => {
    try { await options.journal.append(event); return true; } catch { evidenceLost = true; return false; }
  };

  const db = createDb(options.databaseUrl, { applicationName: GIT_EXPIRATION_ROUND_APPLICATION_NAME, maxConnections: 2,
    sessionParameters: GIT_EXPIRATION_ROUND_SESSION_PARAMETERS });
  // The pool holds no advisory lock, so an abort may end it at once. Dedicated
  // clients hold the row locks and end only through their own lock chain.
  const endPool = () => db.$client.end({ timeout: 0 }).catch(() => undefined);
  const cancel = () => { void endPool(); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    scan: {
      summary.stopReason = stopReason();
      if (summary.stopReason) break scan;
      let upperBound: string;
      try {
        const [clock] = await db.execute<{ upper_bound: string }>(sql`select clock_timestamp()::text as upper_bound`);
        upperBound = clock!.upper_bound;
      } catch {
        summary.stopReason = stopReason() ?? "database_error";
        break scan;
      }
      summary.upperBound = upperBound;
      if (!await record({ type: "round_started", roundId: options.roundId, upperBound, mode: options.mode, pageSize,
        companyId: options.companyId ?? null, maxRows: options.maxRows ?? null, deadline: options.deadline?.toISOString() ?? null })) break scan;
      while (true) {
        summary.stopReason = stopReason();
        if (summary.stopReason) break scan;
        const cursor = summary.lastSelectedKey;
        let page: Array<{ workspace: Workspace; updatedAtKey: string }>;
        try {
          page = await db.select({ workspace: executionWorkspaces, updatedAtKey: sql<string>`${executionWorkspaces.updatedAt}::text` })
            .from(executionWorkspaces)
            .where(and(
              gitExpirationSelectionFilter(),
              options.companyId ? eq(executionWorkspaces.companyId, options.companyId) : undefined,
              sql`${executionWorkspaces.updatedAt} <= ${upperBound}::timestamptz`,
              cursor ? sql`(${executionWorkspaces.updatedAt}, ${executionWorkspaces.id}) > (${cursor.updatedAt}::timestamptz, ${cursor.id}::uuid)` : undefined,
            ))
            .orderBy(asc(executionWorkspaces.updatedAt), asc(executionWorkspaces.id))
            .limit(pageSize);
        } catch {
          summary.stopReason = stopReason() ?? "database_error";
          break scan;
        }
        const keys = page.map(entry => ({ updatedAt: entry.updatedAtKey, id: entry.workspace.id }));
        summary.pages += 1;
        if (!await record({ type: "page_selected", page: summary.pages, keys })) break scan;
        summary.selected += page.length;
        if (keys.length) summary.lastSelectedKey = keys.at(-1)!;
        for (const [index, entry] of page.entries()) {
          summary.stopReason = stopReason();
          if (!summary.stopReason && options.maxRows !== undefined && summary.inspected >= options.maxRows) summary.stopReason = "row_budget";
          if (summary.stopReason) break scan;
          const inspection = inspectRow(db, entry.workspace, keys[index]!, auth, signal, options.budgetHooks);
          let row: GitExpirationRoundRow | null = null;
          try {
            row = await inspection.outcome;
          } catch {
            // Classified after the drain wait below.
          }
          if (!await awaitRelease(inspection.released)) {
            summary.drainIncomplete = true;
            summary.undrainedRow = keys[index]!;
            options.onUndrainedRow?.(inspection.released);
          }
          if (!row) {
            summary.stopReason = stopReason() ?? "database_error";
            break scan;
          }
          if (!await record({ type: "row_inspected", ...row })) break scan;
          summary.inspected += 1;
          summary.lastCompletedKey = row.key;
          if (row.outcome === "candidate") { summary.candidates += 1; summary.candidateBytes += row.candidateBytes; }
          else if (row.outcome === "rejected") summary.rejected += 1;
          else if (row.outcome === "not_candidate") summary.notCandidates += 1;
          else if (row.outcome === "lock_busy") { summary.lockBusy += 1; summary.stopReason = "lock_busy"; break scan; }
          else { summary.resourceLimited += 1; summary.stopReason = "resource_limit"; break scan; }
          if (summary.drainIncomplete) { summary.stopReason = "resource_limit"; break scan; }
        }
        if (page.length < pageSize) { summary.exhausted = true; break scan; }
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    // An undrained row keeps its dedicated clients and locks until its chain unwinds.
    if (summary.drainIncomplete) await endPool();
    else await terminateDbConnections(db);
  }

  summary.stopReason ??= stopReason() ?? (evidenceLost ? "evidence_lost" : null);
  const complete = summary.exhausted && !summary.stopReason && summary.inspected === summary.selected;
  if (!complete) {
    if (!await record({ type: "round_finished", ...summary, status: "partial" })) summary.stopReason = "evidence_lost";
    return summary;
  }
  if (!await record({ type: "round_finished", ...summary, status: "pending_commit" })) {
    summary.stopReason = "evidence_lost";
    return summary;
  }
  summary.stopReason = stopReason();
  if (summary.stopReason) {
    if (!await record({ type: "round_finished", ...summary, status: "partial" })) summary.stopReason = "evidence_lost";
    return summary;
  }
  if (!await record({ type: "round_committed", roundId: options.roundId, status: "complete" })) {
    summary.stopReason = "evidence_lost";
    return summary;
  }
  summary.status = "complete";
  return summary;
}
