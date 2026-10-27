import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { executionWorkspaces, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { withIsolatedRepositorySourceLock, IsolatedRepositorySourceBusy } from "./isolated-remote-workspace-source.js";
import { inspectLockedGitExpirationCandidate, gitExpirationSkipReason, pathExists, type Workspace } from "./git-workspace-expiration-inspection.js";

// One finite, read-only rotation over Git expiration candidates. It never uses
// the recurring sweep's cursor, never archives, persists, renames or deletes,
// and records every selected page and row result in the caller's journal.

export const GIT_EXPIRATION_ROUND_PAGE_SIZE = 50;

export type GitExpirationRoundMode = { enabled: true; dryRun: true; expireBase: false };
export const GIT_EXPIRATION_ROUND_MODE: GitExpirationRoundMode = { enabled: true, dryRun: true, expireBase: false };

export class GitExpirationRoundInvariantError extends Error {}

/** The round only exists in its fixed mode; anything else is a fatal invariant violation. */
export function assertGitExpirationRoundMode(mode: { enabled?: unknown; dryRun?: unknown; expireBase?: unknown }): asserts mode is GitExpirationRoundMode {
  if (mode.dryRun !== true) throw new GitExpirationRoundInvariantError("dry_run_required");
  if (mode.enabled !== true) throw new GitExpirationRoundInvariantError("expiration_enabled_required");
  if (mode.expireBase !== false) throw new GitExpirationRoundInvariantError("base_expiration_forbidden");
}

/** `updatedAt` is the database's own text form, so microsecond keys compare exactly. */
export type GitExpirationRoundKey = { updatedAt: string; id: string };

export type GitExpirationRoundRow = {
  key: GitExpirationRoundKey;
  workspaceId: string;
  companyId: string;
  status: string;
  outcome: "candidate" | "rejected" | "lock_busy";
  reason: string | null;
  pendingExpiration: boolean;
  candidateBytes: number;
};

export type GitExpirationRoundStatus = "complete" | "partial";
export type GitExpirationRoundStopReason = "lock_busy" | "aborted" | "deadline" | "row_budget" | "evidence_lost" | null;

export type GitExpirationRoundSummary = {
  roundId: string;
  status: GitExpirationRoundStatus;
  stopReason: GitExpirationRoundStopReason;
  upperBound: string;
  exhausted: boolean;
  pages: number;
  selected: number;
  inspected: number;
  candidates: number;
  rejected: number;
  lockBusy: number;
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

/** Durable evidence sink. `append` resolves only after the event is durable. */
export type GitExpirationRoundJournal = { append(event: GitExpirationRoundEvent): Promise<void> };

export type GitExpirationRoundOptions = {
  mode: GitExpirationRoundMode;
  roundId: string;
  journal: GitExpirationRoundJournal;
  companyId?: string;
  signal?: AbortSignal;
  deadline?: Date;
  maxRows?: number;
  pageSize?: number;
  now?: () => Date;
};

// A bounded keyset scan is not a frozen membership snapshot; the report says so.
const ROUND_LIMITS = [
  "rows updated after selection may move beyond upperBound and are not followed",
  "rows written with an updatedAt at or below upperBound after the round started may be missed",
  "settings capture for restoration metadata is not exercised; only reconstruction proof is",
];

const LIVE_STATUSES = ["active", "idle", "in_review"];
const PENDING_EXPIRATION = sql`(${executionWorkspaces.metadata}->'gitCacheExpiration'->>'schema' = 'paperclip.git-cache-expiration.v1'
  AND ${executionWorkspaces.metadata}->'gitCacheExpiration'->>'completed' = 'false')`;

/** The rows the recurring sweep hands to Git expiration, as one SQL predicate. */
export function gitExpirationRoundCandidateFilter() {
  return and(
    isNotNull(executionWorkspaces.sourceIssueId),
    ne(executionWorkspaces.providerType, "plugin"),
    or(
      and(inArray(executionWorkspaces.status, LIVE_STATUSES), isNull(executionWorkspaces.closedAt),
        or(and(eq(executionWorkspaces.mode, "isolated_workspace"), eq(executionWorkspaces.strategyType, "git_worktree")), PENDING_EXPIRATION)),
      and(inArray(executionWorkspaces.status, ["archived", "cleanup_failed"]), PENDING_EXPIRATION),
    ),
  );
}

async function inspectRow(db: Db, workspace: Workspace, key: GitExpirationRoundKey, now: Date, signal: AbortSignal): Promise<GitExpirationRoundRow> {
  const row: GitExpirationRoundRow = { key, workspaceId: workspace.id, companyId: workspace.companyId, status: workspace.status,
    outcome: "rejected", reason: null, pendingExpiration: false, candidateBytes: 0 };
  if (!workspace.sourceIssueId) return { ...row, reason: "missing_source_issue" };
  try {
    return await withIsolatedRepositorySourceLock(db, workspace.companyId, workspace.sourceIssueId, () =>
      withDedicatedDbConnection(db, connection => connection.transaction(async tx => {
        // Any write through the lifecycle transaction fails instead of persisting.
        await tx.execute(sql`set transaction read only`);
        const inspection = await inspectLockedGitExpirationCandidate(db, tx, workspace, { now, signal });
        const live = LIVE_STATUSES.includes(inspection.workspace.status);
        if (!live && !inspection.state) throw new Error("missing_restoration_recipe");
        if (inspection.state) {
          // Pending rows are reported, never resumed; leftover trash is ambiguous.
          if (await pathExists(inspection.state.worktreeTrash)
            || (inspection.state.baseTrash && await pathExists(inspection.state.baseTrash))) throw new Error("ambiguous_expiration_trash");
        }
        return { ...row, outcome: "candidate" as const, pendingExpiration: !!inspection.state, candidateBytes: inspection.candidateBytes };
      })), true);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof IsolatedRepositorySourceBusy || (error instanceof Error && error.message === "lifecycle_busy")) {
      return { ...row, outcome: "lock_busy", reason: "lock_busy" };
    }
    return { ...row, reason: gitExpirationSkipReason(error) };
  }
}

export async function inspectGitExpirationRound(db: Db, options: GitExpirationRoundOptions): Promise<GitExpirationRoundSummary> {
  assertGitExpirationRoundMode(options.mode);
  const pageSize = options.pageSize ?? GIT_EXPIRATION_ROUND_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new GitExpirationRoundInvariantError("invalid_page_size");
  if (options.maxRows !== undefined && (!Number.isSafeInteger(options.maxRows) || options.maxRows < 0)) throw new GitExpirationRoundInvariantError("invalid_row_budget");
  const now = options.now ?? (() => new Date());
  const signals = [options.signal, options.deadline ? AbortSignal.timeout(Math.max(0, options.deadline.getTime() - now().getTime())) : undefined]
    .filter((signal): signal is AbortSignal => !!signal);
  const signal = AbortSignal.any(signals);
  const stopReason = (): GitExpirationRoundStopReason => {
    if (options.signal?.aborted) return "aborted";
    if (signal.aborted || (options.deadline && now().getTime() >= options.deadline.getTime())) return "deadline";
    return null;
  };

  // A journal that cannot record an event ends the round partial instead of continuing unrecorded.
  let evidenceLost = false;
  const record = async (event: GitExpirationRoundEvent) => {
    try { await options.journal.append(event); return true; } catch { evidenceLost = true; return false; }
  };

  const [clock] = await db.execute<{ upper_bound: string }>(sql`select clock_timestamp()::text as upper_bound`);
  const upperBound = clock!.upper_bound;
  const summary: GitExpirationRoundSummary = { roundId: options.roundId, status: "partial", stopReason: null, upperBound,
    exhausted: false, pages: 0, selected: 0, inspected: 0, candidates: 0, rejected: 0, lockBusy: 0, candidateBytes: 0,
    lastSelectedKey: null, lastCompletedKey: null, limits: ROUND_LIMITS };
  const started = await record({ type: "round_started", roundId: options.roundId, upperBound, mode: options.mode, pageSize,
    companyId: options.companyId ?? null, maxRows: options.maxRows ?? null, deadline: options.deadline?.toISOString() ?? null });

  scan: while (started) {
    summary.stopReason = stopReason();
    if (summary.stopReason) break;
    const cursor = summary.lastSelectedKey;
    const page = await db.select({ workspace: executionWorkspaces, updatedAtKey: sql<string>`${executionWorkspaces.updatedAt}::text` })
      .from(executionWorkspaces)
      .where(and(
        gitExpirationRoundCandidateFilter(),
        options.companyId ? eq(executionWorkspaces.companyId, options.companyId) : undefined,
        sql`${executionWorkspaces.updatedAt} <= ${upperBound}::timestamptz`,
        cursor ? sql`(${executionWorkspaces.updatedAt}, ${executionWorkspaces.id}) > (${cursor.updatedAt}::timestamptz, ${cursor.id}::uuid)` : undefined,
      ))
      .orderBy(asc(executionWorkspaces.updatedAt), asc(executionWorkspaces.id))
      .limit(pageSize);
    const keys = page.map(entry => ({ updatedAt: entry.updatedAtKey, id: entry.workspace.id }));
    summary.pages += 1;
    if (!await record({ type: "page_selected", page: summary.pages, keys })) break;
    summary.selected += page.length;
    if (keys.length) summary.lastSelectedKey = keys.at(-1)!;
    // Only an empty or short page proves the bounded set is exhausted.
    const lastPage = page.length < pageSize;
    for (const [index, entry] of page.entries()) {
      summary.stopReason = stopReason();
      if (!summary.stopReason && options.maxRows !== undefined && summary.inspected >= options.maxRows) summary.stopReason = "row_budget";
      if (summary.stopReason) break scan;
      let row: GitExpirationRoundRow;
      try {
        row = await inspectRow(db, entry.workspace, keys[index]!, now(), signal);
      } catch (error) {
        summary.stopReason = stopReason();
        if (summary.stopReason) break scan;
        throw error;
      }
      if (!await record({ type: "row_inspected", ...row })) break scan;
      summary.inspected += 1;
      summary.lastCompletedKey = row.key;
      if (row.outcome === "candidate") { summary.candidates += 1; summary.candidateBytes += row.candidateBytes; }
      else if (row.outcome === "rejected") summary.rejected += 1;
      else {
        summary.lockBusy += 1;
        summary.stopReason = "lock_busy";
        break scan;
      }
    }
    if (lastPage) { summary.exhausted = true; break; }
  }

  if (evidenceLost) summary.stopReason = "evidence_lost";
  summary.status = summary.exhausted && !summary.stopReason && summary.inspected === summary.selected ? "complete" : "partial";
  if (!await record({ type: "round_finished", ...summary }) && summary.status === "complete") {
    summary.stopReason = "evidence_lost";
    summary.status = "partial";
  }
  return summary;
}
