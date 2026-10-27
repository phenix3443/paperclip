import { and, asc, eq, sql } from "drizzle-orm";
import { createDb, executionWorkspaces, terminateDbConnections, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { createGitRemoteAuthProvider, type GitRemoteAuthProvider } from "./git-credentials.js";
import { withIsolatedRepositorySourceLock, IsolatedRepositorySourceBusy } from "./isolated-remote-workspace-source.js";
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

export type GitExpirationRoundRow = {
  key: GitExpirationRoundKey;
  workspaceId: string;
  companyId: string;
  status: string;
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
  limits: string[];
};

export type GitExpirationRoundEvent =
  | { type: "round_started"; roundId: string; upperBound: string; mode: GitExpirationRoundMode; pageSize: number;
    companyId: string | null; maxRows: number | null; deadline: string | null }
  | { type: "page_selected"; page: number; keys: GitExpirationRoundKey[] }
  | ({ type: "row_inspected" } & GitExpirationRoundRow)
  | ({ type: "round_finished" } & GitExpirationRoundSummary);

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
  for (const entry of errorChain(error)) {
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
  return withAnonymousGitFallback(createGitRemoteAuthProvider(null as unknown as Db, "", undefined, {
    env,
    secretNames: [],
    secrets: {
      getByName: async () => null,
      resolveSecretValue: async () => { throw new Error("secret_resolution_disabled"); },
    },
  }));
}

async function inspectRow(db: Db, workspace: Workspace, key: GitExpirationRoundKey, auth: GitRemoteAuthProvider,
  signal: AbortSignal): Promise<GitExpirationRoundRow> {
  const row: GitExpirationRoundRow = { key, workspaceId: workspace.id, companyId: workspace.companyId, status: workspace.status,
    outcome: "rejected", reason: null, pendingExpiration: false, candidateBytes: 0 };
  if (!isGitExpirationCandidate(workspace)) return { ...row, outcome: "not_candidate", reason: "not_git_expiration_candidate" };
  if (!workspace.sourceIssueId) return { ...row, reason: "missing_source_issue" };
  try {
    return await withIsolatedRepositorySourceLock(db, workspace.companyId, workspace.sourceIssueId, () =>
      withDedicatedDbConnection(db, connection => connection.transaction(async tx => {
        const inspection = await inspectLockedGitExpirationCandidate(tx, workspace, { now: new Date(), auth, signal });
        const live = LIVE_EXECUTION_WORKSPACE_STATUSES.includes(inspection.workspace.status);
        if (!live && !inspection.state) throw new Error("missing_restoration_recipe");
        if (inspection.state && (await pathExists(inspection.state.worktreeTrash)
          || (inspection.state.baseTrash && await pathExists(inspection.state.baseTrash)))) throw new Error("ambiguous_expiration_trash");
        return { ...row, outcome: "candidate" as const, pendingExpiration: !!inspection.state, candidateBytes: inspection.candidateBytes };
      })), true);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof IsolatedRepositorySourceBusy || (error instanceof Error && error.message === "lifecycle_busy")) {
      return { ...row, outcome: "lock_busy", reason: "lock_busy" };
    }
    const failure = gitExpirationRoundFailure(error);
    if (failure?.kind === "database") throw error;
    if (failure) return { ...row, outcome: "resource_limit", reason: failure.reason };
    return { ...row, reason: gitExpirationSkipReason(error) };
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
    resourceLimited: 0, candidateBytes: 0, lastSelectedKey: null, lastCompletedKey: null, limits: ROUND_LIMITS };
  let evidenceLost = false;
  const record = async (event: GitExpirationRoundEvent) => {
    try { await options.journal.append(event); return true; } catch { evidenceLost = true; return false; }
  };

  const db = createDb(options.databaseUrl, { applicationName: GIT_EXPIRATION_ROUND_APPLICATION_NAME, maxConnections: 2,
    sessionParameters: GIT_EXPIRATION_ROUND_SESSION_PARAMETERS });
  const cancel = () => { void terminateDbConnections(db); };
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
          let row: GitExpirationRoundRow;
          try {
            row = await inspectRow(db, entry.workspace, keys[index]!, auth, signal);
          } catch {
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
        }
        if (page.length < pageSize) { summary.exhausted = true; break scan; }
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await terminateDbConnections(db);
  }

  summary.stopReason ??= stopReason() ?? (evidenceLost ? "evidence_lost" : null);
  summary.status = summary.exhausted && !summary.stopReason && summary.inspected === summary.selected ? "complete" : "partial";
  if (!await record({ type: "round_finished", ...summary }) && summary.status === "complete") {
    summary.stopReason = "evidence_lost";
    summary.status = "partial";
  }
  return summary;
}
