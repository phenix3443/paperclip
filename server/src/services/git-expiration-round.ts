import os from "node:os";
import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { createDb, executionWorkspaces, terminateDbConnections, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { createEnvironmentGitRemoteAuthProvider, type GitRemoteAuthProvider } from "./git-credentials.js";
import { withIsolatedRepositorySourceLock, IsolatedRepositorySourceBusy } from "./isolated-remote-workspace-source.js";
import { withWorkspaceLockKeepalive } from "./native-runtime/native-workspace-lock-keepalive.js";
import { GIT_EXPIRATION_BUDGETS, GitExpirationBudgetExceeded, InspectionBudget, isScratchQuotaError, ROW_DRAIN_BOUND_MS,
  type InspectionBudgetHooks, type InspectionBudgetPeaks } from "./git-expiration-budget.js";
import { inspectLockedGitExpirationCandidate, gitExpirationSkipReason, gitExpirationSelectionFilter, isGitExpirationCandidate,
  LIVE_EXECUTION_WORKSPACE_STATUSES, pathExists, withAnonymousGitFallback, type Workspace } from "./git-workspace-expiration-inspection.js";
import { captureAfterIdentity, compareSelection, compareSides, gitExpirationEvidenceContract, missingEvidence, observeAfter, observeBefore,
  observeRowState, unlockedRowEvidence, type GitExpirationEvidenceContract, type GitExpirationRowEvidence, type GitExpirationRowSide,
  type Observation } from "./git-expiration-evidence.js";

export const GIT_EXPIRATION_ROUND_PAGE_SIZE = 50;
export const GIT_EXPIRATION_ROUND_APPLICATION_NAME = "paperclip-git-expiration-round";
export const GIT_EXPIRATION_ROUND_POOL_CONNECTIONS = 2;
export const GIT_EXPIRATION_ROUND_CONNECT_TIMEOUT_SECONDS = 10;
export const GIT_EXPIRATION_ROUND_SESSION_PARAMETERS = {
  default_transaction_read_only: "on",
  client_connection_check_interval: "1000",
  statement_timeout: String(GIT_EXPIRATION_BUDGETS.statementMs),
};
const STATEMENT_TIMEOUT_MESSAGE = "canceling statement due to statement timeout";

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
  evidence: GitExpirationRowEvidence;
};

export type GitExpirationRoundStatus = "complete" | "partial";
export type GitExpirationRoundStopReason = "lock_busy" | "aborted" | "deadline" | "row_budget" | "evidence_lost"
  | "resource_limit" | "database_error" | "protected_state_changed" | "evidence_unavailable" | null;

export type GitExpirationRoundBudgetHit = { budget: string; scope: "row" | "round"; limit: number | null; observed: number | null };

export type GitExpirationRoundPeaks = InspectionBudgetPeaks & { dbClients: number; journalBytes: number };

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
  fullPages: number;
  exhaustionChecked: boolean;
  drainIncomplete: boolean;
  undrainedRow: GitExpirationRoundKey | null;
  budgetHit: GitExpirationRoundBudgetHit | null;
  peaks: GitExpirationRoundPeaks;
  budgets: typeof GIT_EXPIRATION_BUDGETS;
  limits: string[];
  evidenceContract: GitExpirationEvidenceContract;
};

export type GitExpirationRoundEvent =
  | { type: "round_started"; roundId: string; upperBound: string; mode: GitExpirationRoundMode; pageSize: number;
    companyId: string | null; maxRows: number | null; deadline: string | null; budgets: typeof GIT_EXPIRATION_BUDGETS; scratchDir: string;
    evidenceContract: GitExpirationEvidenceContract }
  | { type: "page_selected"; page: number; keys: GitExpirationRoundKey[] }
  | { type: "selection_exhaustion_checked"; more: boolean }
  | ({ type: "row_inspected" } & GitExpirationRoundRow)
  | ({ type: "round_finished" } & Omit<GitExpirationRoundSummary, "status"> & { status: "partial" | "pending_commit" })
  | { type: "round_committed"; roundId: string; status: "complete" };

export type GitExpirationRoundJournal = { append(event: GitExpirationRoundEvent): Promise<void>; bytes?(): number };

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
  onUndrainedRow?: (released: Promise<void>) => void;
  budgetHooks?: InspectionBudgetHooks;
  upperBoundQuery?: SQL;
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

function isStatementTimeout(entry: Error) {
  return entry.name === "PostgresError" && (entry as Error & { code?: unknown }).code === "57014" && entry.message === STATEMENT_TIMEOUT_MESSAGE;
}

export function gitExpirationBudgetHit(error: unknown, scope: GitExpirationRoundBudgetHit["scope"]): GitExpirationRoundBudgetHit | null {
  const chain = errorChain(error);
  const budget = chain.find((entry): entry is GitExpirationBudgetExceeded => entry instanceof GitExpirationBudgetExceeded);
  if (budget) return { budget: budget.budget, scope, limit: budget.limit, observed: budget.observed };
  if (chain.some(isStatementTimeout)) return { budget: "statement_timeout", scope, limit: GIT_EXPIRATION_BUDGETS.statementMs, observed: null };
  return null;
}

export function gitExpirationRoundFailure(error: unknown): { kind: "database" | "resource_limit"; reason: string } | null {
  const chain = errorChain(error);
  const hit = gitExpirationBudgetHit(error, "row");
  if (hit) return { kind: "resource_limit", reason: hit.budget };
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

export function gitExpirationRoundClients(openDedicated: number) {
  const clients = GIT_EXPIRATION_ROUND_POOL_CONNECTIONS + openDedicated + 1;
  if (clients > GIT_EXPIRATION_BUDGETS.dbConnections) {
    throw new GitExpirationBudgetExceeded("db_connections", GIT_EXPIRATION_BUDGETS.dbConnections, clients);
  }
  return clients;
}

export function readOnlyInspectionGitAuth(env: NodeJS.ProcessEnv = process.env): GitRemoteAuthProvider {
  return withAnonymousGitFallback(createEnvironmentGitRemoteAuthProvider(env));
}

type RowInspection = {
  outcome: Promise<GitExpirationRoundRow>;
  released: Promise<void>;
  /** Final row evidence, read once the row chain is released or the drain bound has passed. */
  evidence(row: GitExpirationRoundRow, drained: boolean): GitExpirationRowEvidence;
  budgetHit(): GitExpirationRoundBudgetHit | null;
  peaks(): Readonly<InspectionBudgetPeaks> | null;
};

function inspectRow(db: Db, workspace: Workspace, key: GitExpirationRoundKey, auth: GitRemoteAuthProvider,
  roundSignal: AbortSignal, hooks: InspectionBudgetHooks | undefined): RowInspection {
  let current: GitExpirationRoundCurrentRow = { state: "not_read" };
  const selectedRow = { workspace, updatedAtKey: key.updatedAt };
  const unlocked = unlockedRowEvidence(selectedRow, "row_not_locked");
  const row = (): GitExpirationRoundRow => ({ key, workspaceId: workspace.id, companyId: workspace.companyId, status: workspace.status,
    current, outcome: "rejected", reason: null, pendingExpiration: false, candidateBytes: 0, evidence: unlocked });
  const settled = (value: GitExpirationRoundRow, reason: "not_candidate" | "row_not_locked"): RowInspection => ({ outcome: Promise.resolve(value),
    released: Promise.resolve(), evidence: () => unlockedRowEvidence(selectedRow, reason), budgetHit: () => null, peaks: () => null });
  if (!isGitExpirationCandidate(workspace)) return settled({ ...row(), outcome: "not_candidate", reason: "not_git_expiration_candidate" }, "not_candidate");
  if (!workspace.sourceIssueId) return settled({ ...row(), reason: "missing_source_issue" }, "row_not_locked");
  const sourceIssueId = workspace.sourceIssueId;
  let hit: GitExpirationRoundBudgetHit | null = null;
  const budget = new InspectionBudget(roundSignal, hooks);
  const signal = budget.signal;
  let before: Awaited<ReturnType<typeof observeBefore>> | null = null;
  let after: Observation<GitExpirationRowSide> | null = null;
  // Both locks are held here: the lifecycle lock was just taken inside the source lock.
  const onLocked = async (reread: { workspace: Workspace; updatedAtKey: string } | null) => {
    current = reread ? { state: "read", key: { updatedAt: reread.updatedAtKey, id: reread.workspace.id }, status: reread.workspace.status }
      : { state: "missing" };
    before = await observeBefore(reread, workspace, signal);
    if (!reread || reread.updatedAtKey !== key.updatedAt) throw new Error("workspace_changed");
  };
  const afterPhases = async (tx: Parameters<typeof inspectLockedGitExpirationCandidate>[0]) => {
    const locked = before as Awaited<ReturnType<typeof observeBefore>> | null;
    let identity: Awaited<ReturnType<typeof captureAfterIdentity>> = null;
    // Phase A: children and budgeted reads, tracked by the row budget, before drain.
    if (locked?.locations) identity = await captureAfterIdentity(locked.anchorRow, signal).catch(() => null);
    await budget.drain();
    // Phase B: one select and lstat of the fixed roles, after drain and before the locks unwind.
    if (!locked) return;
    after = await observeAfter(async () => (await tx.select({ workspace: executionWorkspaces, updatedAtKey: sql<string>`${executionWorkspaces.updatedAt}::text` })
      .from(executionWorkspaces).where(and(eq(executionWorkspaces.id, workspace.id), eq(executionWorkspaces.companyId, workspace.companyId))))[0] ?? null,
    locked.anchorRow, locked.locations ?? [], identity);
  };
  const chain = budget.run(() => withIsolatedRepositorySourceLock(db, workspace.companyId, sourceIssueId, () =>
    withDedicatedDbConnection(db, connection => connection.transaction(async tx => {
      const [setting] = await tx.execute<{ idle_timeout_ms: string | null }>(sql`select setting as idle_timeout_ms
        from pg_settings where name = 'idle_in_transaction_session_timeout'`);
      return withWorkspaceLockKeepalive(tx, Number(setting?.idle_timeout_ms), async () => {
        try {
          const inspection = await inspectLockedGitExpirationCandidate(tx, workspace, { now: new Date(), auth, signal, onLocked });
          const live = LIVE_EXECUTION_WORKSPACE_STATUSES.includes(inspection.workspace.status);
          if (!live && !inspection.state) throw new Error("missing_restoration_recipe");
          if (inspection.state && (await pathExists(inspection.state.worktreeTrash)
            || (inspection.state.baseTrash && await pathExists(inspection.state.baseTrash)))) throw new Error("ambiguous_expiration_trash");
          return { ...row(), outcome: "candidate" as const, pendingExpiration: !!inspection.state, candidateBytes: inspection.candidateBytes };
        } finally {
          await afterPhases(tx);
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
    if (failure) {
      hit ??= gitExpirationBudgetHit(error, "row") ?? { budget: failure.reason, scope: "row", limit: null, observed: null };
      return { ...row(), outcome: "resource_limit", reason: failure.reason };
    }
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
  finished.catch(() => undefined);
  stopped.catch(() => undefined);
  const evidence = (value: GitExpirationRoundRow, drained: boolean): GitExpirationRowEvidence => {
    const locked = before as Awaited<ReturnType<typeof observeBefore>> | null;
    if (!locked) return unlockedRowEvidence(selectedRow, value.outcome === "lock_busy" ? "lock_busy"
      : value.outcome === "resource_limit" || signal.aborted ? "row_stopped" : "row_not_locked");
    const afterSide: Observation<GitExpirationRowSide> = drained && after ? after : { state: "unavailable", reason: "undrained" };
    const selected = observeRowState(selectedRow);
    return { selected, before: locked.side, after: afterSide, drift: compareSides(locked.side, afterSide),
      selectionDrift: compareSelection(selected, locked.side) };
  };
  return { outcome, released: chain.then(() => undefined, () => undefined).finally(() => budget.close()), evidence, budgetHit: () => hit,
    peaks: () => budget.peaks };
}

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
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > GIT_EXPIRATION_ROUND_PAGE_SIZE) {
    throw new GitExpirationRoundInvariantError("invalid_page_size");
  }
  if (options.maxRows !== undefined && (!Number.isSafeInteger(options.maxRows) || options.maxRows < 0
    || options.maxRows > GIT_EXPIRATION_BUDGETS.selectedRows)) throw new GitExpirationRoundInvariantError("invalid_row_budget");
  const selectionCap = options.maxRows ?? GIT_EXPIRATION_BUDGETS.selectedRows;
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
    resourceLimited: 0, candidateBytes: 0, lastSelectedKey: null, lastCompletedKey: null, fullPages: 0, exhaustionChecked: false,
    drainIncomplete: false, undrainedRow: null, budgetHit: null,
    peaks: { rowMs: 0, rowEntries: 0, childOutputBytes: 0, dbClients: 0, gitChildren: 0, journalBytes: 0 },
    budgets: GIT_EXPIRATION_BUDGETS, limits: ROUND_LIMITS, evidenceContract: gitExpirationEvidenceContract() };
  const peak = (name: keyof GitExpirationRoundPeaks, value: number) => { summary.peaks[name] = Math.max(summary.peaks[name], value); };
  const rowPeaks = (peaks: Readonly<InspectionBudgetPeaks> | null, rowMs: number) => {
    if (!peaks) return;
    for (const name of ["rowEntries", "childOutputBytes", "gitChildren"] as const) peak(name, peaks[name]);
    peak("rowMs", Math.max(peaks.rowMs, rowMs));
  };
  const classifyRoundError = (error: unknown, scope: GitExpirationRoundBudgetHit["scope"]): GitExpirationRoundStopReason => {
    const cancelled = stopReason();
    if (cancelled) return cancelled;
    const hit = gitExpirationBudgetHit(error, scope);
    if (!hit) return "database_error";
    summary.budgetHit ??= hit;
    return "resource_limit";
  };
  let evidenceLost = false;
  const record = async (event: GitExpirationRoundEvent) => {
    try {
      await options.journal.append(event);
      return true;
    } catch (error) {
      if (error instanceof GitExpirationBudgetExceeded && error.budget === "evidence") {
        summary.budgetHit ??= gitExpirationBudgetHit(error, "round");
        summary.stopReason ??= "resource_limit";
      } else evidenceLost = true;
      return false;
    } finally {
      if (event.type !== "round_finished" && event.type !== "round_committed") peak("journalBytes", options.journal.bytes?.() ?? 0);
    }
  };

  let openDedicated = 0;
  const db = createDb(options.databaseUrl, { applicationName: GIT_EXPIRATION_ROUND_APPLICATION_NAME,
    maxConnections: GIT_EXPIRATION_ROUND_POOL_CONNECTIONS, connectTimeoutSeconds: GIT_EXPIRATION_ROUND_CONNECT_TIMEOUT_SECONDS,
    sessionParameters: GIT_EXPIRATION_ROUND_SESSION_PARAMETERS, dedicatedApplicationName: GIT_EXPIRATION_ROUND_APPLICATION_NAME,
    beforeDedicatedConnection: () => {
      peak("dbClients", gitExpirationRoundClients(openDedicated));
      openDedicated += 1;
      let released = false;
      return () => {
        if (!released) { released = true; openDedicated -= 1; }
      };
    } });
  peak("dbClients", GIT_EXPIRATION_ROUND_POOL_CONNECTIONS);
  const endPool = () => db.$client.end({ timeout: 0 }).catch(() => undefined);
  const cancel = () => { void endPool(); };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  const selectionFilter = (upperBound: string, cursor: GitExpirationRoundKey | null) => and(
    gitExpirationSelectionFilter(),
    options.companyId ? eq(executionWorkspaces.companyId, options.companyId) : undefined,
    sql`${executionWorkspaces.updatedAt} <= ${upperBound}::timestamptz`,
    cursor ? sql`(${executionWorkspaces.updatedAt}, ${executionWorkspaces.id}) > (${cursor.updatedAt}::timestamptz, ${cursor.id}::uuid)` : undefined,
  );
  const selectionOrder = [asc(executionWorkspaces.updatedAt), asc(executionWorkspaces.id)];
  try {
    scan: {
      summary.stopReason = stopReason();
      if (summary.stopReason) break scan;
      let upperBound: string;
      try {
        const [clock] = await db.execute<{ upper_bound: string }>(options.upperBoundQuery ?? sql`select clock_timestamp()::text as upper_bound`);
        upperBound = clock!.upper_bound;
      } catch (error) {
        summary.stopReason = classifyRoundError(error, "round");
        break scan;
      }
      summary.upperBound = upperBound;
      if (!await record({ type: "round_started", roundId: options.roundId, upperBound, mode: options.mode, pageSize,
        companyId: options.companyId ?? null, maxRows: options.maxRows ?? null, deadline: options.deadline?.toISOString() ?? null,
        budgets: GIT_EXPIRATION_BUDGETS, scratchDir: os.tmpdir(), evidenceContract: summary.evidenceContract })) break scan;
      while (true) {
        summary.stopReason = stopReason();
        if (summary.stopReason) break scan;
        const cursor = summary.lastSelectedKey;
        if (summary.selected >= selectionCap || summary.fullPages >= GIT_EXPIRATION_BUDGETS.fullPages) {
          let more: boolean;
          try {
            const next = await db.select({ id: executionWorkspaces.id }).from(executionWorkspaces)
              .where(selectionFilter(upperBound, cursor)).orderBy(...selectionOrder).limit(1);
            more = next.length > 0;
          } catch (error) {
            summary.stopReason = classifyRoundError(error, "round");
            break scan;
          }
          summary.exhaustionChecked = true;
          if (!await record({ type: "selection_exhaustion_checked", more })) break scan;
          if (more) summary.stopReason = "row_budget";
          else summary.exhausted = true;
          break scan;
        }
        const limit = Math.min(pageSize, selectionCap - summary.selected);
        let page: Array<{ workspace: Workspace; updatedAtKey: string }>;
        try {
          page = await db.select({ workspace: executionWorkspaces, updatedAtKey: sql<string>`${executionWorkspaces.updatedAt}::text` })
            .from(executionWorkspaces)
            .where(selectionFilter(upperBound, cursor))
            .orderBy(...selectionOrder)
            .limit(limit);
        } catch (error) {
          summary.stopReason = classifyRoundError(error, "round");
          break scan;
        }
        const keys = page.map(entry => ({ updatedAt: entry.updatedAtKey, id: entry.workspace.id }));
        summary.pages += 1;
        if (page.length === limit) summary.fullPages += 1;
        if (!await record({ type: "page_selected", page: summary.pages, keys })) break scan;
        summary.selected += page.length;
        if (keys.length) summary.lastSelectedKey = keys.at(-1)!;
        for (const [index, entry] of page.entries()) {
          summary.stopReason = stopReason();
          if (summary.stopReason) break scan;
          const rowStartedAt = Date.now();
          const inspection = inspectRow(db, entry.workspace, keys[index]!, auth, signal, options.budgetHooks);
          let row: GitExpirationRoundRow | null = null;
          let failure: unknown;
          try {
            row = await inspection.outcome;
          } catch (error) {
            failure = error;
          }
          const drained = await awaitRelease(inspection.released);
          if (!drained) {
            summary.drainIncomplete = true;
            summary.undrainedRow = keys[index]!;
            options.onUndrainedRow?.(inspection.released);
          }
          rowPeaks(inspection.peaks(), Date.now() - rowStartedAt);
          if (summary.drainIncomplete && !stopReason()) {
            summary.budgetHit ??= inspection.budgetHit()
              ?? { budget: "row_drain", scope: "row", limit: ROW_DRAIN_BOUND_MS, observed: null };
          }
          if (!row) {
            summary.stopReason = classifyRoundError(failure, "row");
            break scan;
          }
          row = { ...row, evidence: inspection.evidence(row, drained) };
          if (!await record({ type: "row_inspected", ...row })) break scan;
          summary.inspected += 1;
          summary.lastCompletedKey = row.key;
          if (row.outcome === "candidate") { summary.candidates += 1; summary.candidateBytes += row.candidateBytes; }
          else if (row.outcome === "rejected") summary.rejected += 1;
          else if (row.outcome === "not_candidate") summary.notCandidates += 1;
          else if (row.outcome === "lock_busy") { summary.lockBusy += 1; summary.stopReason = "lock_busy"; break scan; }
          else {
            summary.resourceLimited += 1;
            summary.budgetHit ??= inspection.budgetHit();
            summary.stopReason = "resource_limit";
            break scan;
          }
          if (summary.drainIncomplete) { summary.stopReason = "resource_limit"; break scan; }
          // Only a row that got both locks has a before side; stopped rows already broke out above.
          if (row.evidence.drift.state === "changed") { summary.stopReason = "protected_state_changed"; break scan; }
          if (row.evidence.before.state !== "unavailable" && missingEvidence(row.evidence).length) {
            summary.stopReason = "evidence_unavailable";
            break scan;
          }
        }
        if (page.length < limit) { summary.exhausted = true; break scan; }
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
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
