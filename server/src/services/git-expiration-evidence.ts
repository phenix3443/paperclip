import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PROJECT_REPOSITORIES_DIR } from "@paperclipai/adapter-utils/git-workspace-sync";
import { readBoundedDirectory, isInspectionStop } from "./git-expiration-budget.js";
import { CHECKOUT_LIMIT } from "./git-workspace-contents.js";
import { recordedIsolatedRemoteSource } from "./isolated-remote-workspace-source.js";
import { gitCacheCommand, gitExpirationMarkerLocations, managedSourcePaths, readGitCacheExpiration, readGitCacheRestoration,
  type GitExpirationMarkerAnchor } from "./git-workspace-restoration.js";
import { gitWorktreeTrashPath, LIVE_EXECUTION_WORKSPACE_STATUSES, verifiedWorktreeAdmin, type Workspace } from "./git-workspace-expiration-inspection.js";

export const GIT_EXPIRATION_EVIDENCE_CONTRACT_NAME = "paperclip.git-expiration-evidence";
export const GIT_EXPIRATION_EVIDENCE_CONTRACT_VERSION = 1;
/** Capabilities this native artifact produces; a later slice appends its own. */
export const GIT_EXPIRATION_EVIDENCE_CAPABILITIES = ["row_keys.v1", "row_state.v1", "row_paths.v1", "row_head.v1", "drift_stop.v1"] as const;

export type GitExpirationEvidenceContract = { name: string; version: number; capabilities: string[] };

export function gitExpirationEvidenceContract(): GitExpirationEvidenceContract {
  return { name: GIT_EXPIRATION_EVIDENCE_CONTRACT_NAME, version: GIT_EXPIRATION_EVIDENCE_CONTRACT_VERSION,
    capabilities: [...GIT_EXPIRATION_EVIDENCE_CAPABILITIES] };
}

export type UnavailableReason = "row_not_locked" | "not_candidate" | "lock_busy" | "row_stopped" | "undrained" | "worktree_absent"
  | "rejected_before_walk" | "sentinel_not_installed" | "location_unresolved" | "invalid_metadata" | "checkout_budget" | "incomplete_measurement";

export type Observation<T> =
  | { state: "observed"; value: T }
  | { state: "unavailable"; reason: UnavailableReason }
  | { state: "error"; code: string };

const observed = <T>(value: T): Observation<T> => ({ state: "observed", value });
const unavailable = <T>(reason: UnavailableReason): Observation<T> => ({ state: "unavailable", reason });
const failed = <T>(code: string): Observation<T> => ({ state: "error", code });

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function evidenceDigest(field: string, value: unknown) {
  return createHash("sha256").update(`paperclip.git-expiration-evidence.v1\0${field}\0${canonicalJson(value)}`).digest("hex");
}

const optionalDigest = (field: string, value: unknown) => value === undefined
  ? { present: false as const } : { present: true as const, digest: evidenceDigest(field, value) };

/** Sanitized failure code: an errno name, a Git exit, or a fixed fallback. Messages and argv never enter evidence. */
export function evidenceErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "number") return `git_exit_${code}`;
  if (typeof code === "string" && /^E[A-Z0-9]+$/.test(code)) return code;
  if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "git_output";
  if ((error as Error | null)?.name === "PostgresError" && code === "57014") return "statement_timeout";
  return "invalid_output";
}

export type RowStateValue = {
  present: true;
  key: { updatedAt: string; id: string };
  status: string;
  closedAtPresent: boolean;
  lifecycleGeneration: { present: boolean; value: number | null };
  digests: { status: string; protectedColumns: string; metadata: string;
    gitCacheExpiration: { present: boolean; digest?: string }; gitCacheRestoration: { present: boolean; digest?: string } };
} | { present: false };

export function observeRowState(row: { workspace: Workspace; updatedAtKey: string } | null): Observation<RowStateValue> {
  if (!row) return observed({ present: false });
  const { workspace, updatedAtKey } = row;
  const metadata = workspace.metadata ?? null;
  const generation = metadata?.lifecycleGeneration;
  return observed({
    present: true,
    key: { updatedAt: updatedAtKey, id: workspace.id },
    status: workspace.status,
    closedAtPresent: workspace.closedAt !== null,
    lifecycleGeneration: { present: generation !== undefined, value: typeof generation === "number" ? generation : null },
    digests: {
      status: evidenceDigest("status", workspace.status),
      protectedColumns: evidenceDigest("protectedColumns", { status: workspace.status, closedAt: workspace.closedAt,
        cleanupEligibleAt: workspace.cleanupEligibleAt, cwd: workspace.cwd, providerRef: workspace.providerRef, updatedAt: updatedAtKey, metadata }),
      metadata: evidenceDigest("metadata", metadata),
      gitCacheExpiration: optionalDigest("gitCacheExpiration", metadata?.gitCacheExpiration),
      gitCacheRestoration: optionalDigest("gitCacheRestoration", metadata?.gitCacheRestoration),
    },
  });
}

export type HeadValue = { commit: string; refDigest: string; gitDirDigest: string };
type HeadRead = { observation: Observation<HeadValue>; gitDir: string | null };

async function lstatAbsent(target: string) {
  return fs.lstat(target).then(() => false, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return true; throw error; });
}

function stopped(signal: AbortSignal | undefined, error?: unknown) {
  return !!signal?.aborted || (error !== undefined && isInspectionStop(error, signal));
}

/** One bounded Git child that reads identity only; it is not a proof step. */
export async function observeHead(worktree: string | null, signal?: AbortSignal): Promise<HeadRead> {
  if (!worktree) return { observation: unavailable("location_unresolved"), gitDir: null };
  if (signal?.aborted) return { observation: unavailable("row_stopped"), gitDir: null };
  try {
    if (await lstatAbsent(worktree)) return { observation: unavailable("worktree_absent"), gitDir: null };
    if (signal?.aborted) return { observation: unavailable("row_stopped"), gitDir: null };
    const lines = (await gitCacheCommand(worktree, ["rev-parse", "--absolute-git-dir", "HEAD", "--symbolic-full-name", "HEAD"], signal))
      .split("\n").filter(Boolean);
    const [gitDir, commit, ref] = lines;
    if (lines.length !== 3 || !gitDir || !path.isAbsolute(gitDir) || !/^[a-f0-9]{40,64}$/.test(commit ?? "") || !ref) {
      return { observation: failed("invalid_output"), gitDir: null };
    }
    return { observation: observed({ commit: commit!, refDigest: evidenceDigest("head.ref", ref), gitDirDigest: evidenceDigest("head.gitDir", gitDir) }), gitDir };
  } catch (error) {
    if (stopped(signal, error)) return { observation: unavailable("row_stopped"), gitDir: null };
    return { observation: failed(evidenceErrorCode(error)), gitDir: null };
  }
}

export type CheckoutIdentity = { name: string; branchName: string | null; gitDir: string | null };
/** Identity of a live row that needs a child, a budgeted directory read or a realpath. Captured before drain only. */
export type LiveIdentity = {
  head: Observation<HeadValue>;
  sourcePath: string | null;
  worktreeAdmin: Observation<string>;
  checkouts: Observation<CheckoutIdentity[]>;
};

type Location = { role: string; path: Observation<string> };

type Anchor = {
  sourcePaths: string[] | null;
  worktreePath: Observation<string>;
  markerSource: Observation<string>;
  worktreeAdmin: Observation<string>;
  branchName: string | null;
  checkouts: Observation<CheckoutIdentity[]>;
  worktreeTrash: Observation<string>;
  baseTrash: string | null;
};

function isLive(workspace: Workspace) {
  return LIVE_EXECUTION_WORKSPACE_STATUSES.includes(workspace.status);
}

/** Source candidates of a live row; `null` when a native validator rejects the recorded identity. */
function liveSourcePaths(workspace: Workspace): string[] | null {
  let recorded: string | null;
  try { recorded = recordedIsolatedRemoteSource(workspace); } catch { return null; }
  const sources = recorded ? [recorded] : managedSourcePaths(workspace);
  let restoration: ReturnType<typeof readGitCacheRestoration> = null;
  try { restoration = readGitCacheRestoration(workspace); } catch { restoration = null; }
  if (restoration?.sourcePath && !sources.includes(restoration.sourcePath)) sources.push(restoration.sourcePath);
  return sources;
}

function pendingAnchor(workspace: Workspace): Anchor | null {
  if (isLive(workspace)) return null;
  let state;
  let recipe;
  try {
    state = readGitCacheExpiration(workspace);
    recipe = readGitCacheRestoration(workspace);
  } catch {
    const bad = unavailable<string>("invalid_metadata");
    return { sourcePaths: [], worktreePath: bad, markerSource: bad, worktreeAdmin: bad, branchName: null,
      checkouts: unavailable("invalid_metadata"), worktreeTrash: bad, baseTrash: null };
  }
  if (!state || !recipe) return null;
  const worktree = recipe.worktreePath;
  return { sourcePaths: [recipe.sourcePath], worktreePath: observed(worktree), markerSource: observed(recipe.sourcePath),
    worktreeAdmin: observed(state.worktreeAdmin), branchName: recipe.branchName,
    checkouts: observed((recipe.contents?.checkouts ?? []).map(checkout => ({ name: checkout.name, branchName: checkout.branchName,
      gitDir: path.join(worktree, PROJECT_REPOSITORIES_DIR, checkout.name, ".git") }))),
    worktreeTrash: observed(state.worktreeTrash), baseTrash: state.baseTrash };
}

function liveAnchor(workspace: Workspace, identity: LiveIdentity): Anchor {
  const worktree = workspace.cwd && (!workspace.providerRef || workspace.providerRef === workspace.cwd) ? workspace.cwd : null;
  const generation = Number(workspace.metadata?.lifecycleGeneration ?? 0) + 1;
  return {
    sourcePaths: liveSourcePaths(workspace),
    worktreePath: worktree ? observed(worktree) : unavailable("location_unresolved"),
    markerSource: identity.sourcePath ? observed(identity.sourcePath)
      : identity.worktreeAdmin.state === "unavailable" && identity.worktreeAdmin.reason === "worktree_absent" ? identity.worktreeAdmin : unavailable("location_unresolved"),
    worktreeAdmin: identity.worktreeAdmin,
    branchName: workspace.branchName,
    checkouts: identity.checkouts,
    worktreeTrash: worktree && Number.isSafeInteger(generation) ? observed(gitWorktreeTrashPath(worktree, workspace.id, generation))
      : unavailable(worktree ? "invalid_metadata" : "location_unresolved"),
    baseTrash: null,
  };
}

/** Reads every live-row anchor input that needs a child, a directory read or a realpath. */
export async function captureLiveIdentity(workspace: Workspace, signal?: AbortSignal): Promise<LiveIdentity> {
  const worktree = workspace.cwd && (!workspace.providerRef || workspace.providerRef === workspace.cwd) ? workspace.cwd : null;
  const head = await observeHead(worktree, signal);
  const stop = (): LiveIdentity => ({ head: head.observation, sourcePath: null, worktreeAdmin: unavailable("row_stopped"), checkouts: unavailable("row_stopped") });
  let sourcePath: string | null = null;
  let worktreeAdmin: Observation<string> = unavailable("location_unresolved");
  if (head.observation.state === "unavailable" && head.observation.reason === "worktree_absent") worktreeAdmin = unavailable("worktree_absent");
  if (head.gitDir) {
    for (const candidate of liveSourcePaths(workspace) ?? []) {
      if (signal?.aborted) return stop();
      try {
        worktreeAdmin = observed(await verifiedWorktreeAdmin(candidate, head.gitDir));
        sourcePath = candidate;
        break;
      } catch {
        // The admin dir does not resolve under this candidate; try the next one.
      }
    }
  } else if (head.observation.state === "unavailable" && head.observation.reason === "row_stopped") return stop();
  if (!worktree) return { head: head.observation, sourcePath, worktreeAdmin, checkouts: unavailable("location_unresolved") };
  const container = path.join(worktree, PROJECT_REPOSITORIES_DIR);
  let names: string[];
  try {
    if (signal?.aborted) return stop();
    names = (await readBoundedDirectory(container, signal)).map(entry => entry.name).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") names = [];
    else if (stopped(signal, error)) return stop();
    else return { head: head.observation, sourcePath, worktreeAdmin, checkouts: failed(evidenceErrorCode(error)) };
  }
  if (names.length > CHECKOUT_LIMIT) return { head: head.observation, sourcePath, worktreeAdmin, checkouts: unavailable("checkout_budget") };
  const checkouts: CheckoutIdentity[] = [];
  for (const name of names) {
    if (signal?.aborted) return stop();
    try {
      const [gitDir, ref] = (await gitCacheCommand(path.join(container, name), ["rev-parse", "--absolute-git-dir", "--symbolic-full-name", "HEAD"], signal))
        .split("\n").filter(Boolean);
      checkouts.push({ name, gitDir: gitDir && path.isAbsolute(gitDir) ? gitDir : null,
        branchName: ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null });
    } catch (error) {
      if (stopped(signal, error)) return stop();
      checkouts.push({ name, gitDir: null, branchName: null });
    }
  }
  return { head: head.observation, sourcePath, worktreeAdmin, checkouts: observed(checkouts) };
}

function anchorFor(workspace: Workspace, identity: LiveIdentity | null): Anchor {
  const pending = pendingAnchor(workspace);
  if (pending) return pending;
  if (identity) return liveAnchor(workspace, identity);
  const stop = unavailable<string>("row_stopped");
  return { sourcePaths: liveSourcePaths(workspace), worktreePath: workspace.cwd ? observed(workspace.cwd) : unavailable("location_unresolved"),
    markerSource: stop, worktreeAdmin: stop, branchName: workspace.branchName, checkouts: unavailable("row_stopped"), worktreeTrash: stop, baseTrash: null };
}

function locationSet(anchor: Anchor): Observation<string> {
  for (const part of [anchor.worktreePath, anchor.worktreeAdmin, anchor.checkouts]) {
    if (part.state !== "observed") return part.state === "unavailable" ? unavailable(part.reason) : failed(part.code);
  }
  return observed(evidenceDigest("locationSet", { sourcePaths: anchor.sourcePaths, worktreePath: anchor.worktreePath.state === "observed" ? anchor.worktreePath.value : null,
    worktreeAdmin: anchor.worktreeAdmin.state === "observed" ? anchor.worktreeAdmin.value : null, branchName: anchor.branchName,
    checkouts: anchor.checkouts.state === "observed" ? anchor.checkouts.value : null }));
}

function under(base: Observation<string>, ...parts: string[]): Observation<string> {
  return base.state === "observed" ? observed(path.join(base.value, ...parts)) : base;
}

function protectedLocations(anchor: Anchor): Location[] {
  const locations: Location[] = [
    { role: "worktree", path: anchor.worktreePath },
    { role: "worktree_git_link", path: under(anchor.worktreePath, ".git") },
  ];
  if (!anchor.sourcePaths?.length) {
    const reason = unavailable<string>(anchor.sourcePaths ? "location_unresolved" : "invalid_metadata");
    locations.push({ role: "source", path: reason }, { role: "source_git", path: reason });
  }
  for (const source of anchor.sourcePaths ?? []) locations.push({ role: "source", path: observed(source) }, { role: "source_git", path: observed(path.join(source, ".git")) });
  locations.push({ role: "worktree_admin", path: anchor.worktreeAdmin }, { role: "gitdir_head", path: under(anchor.worktreeAdmin, "HEAD") },
    { role: "gitdir_index", path: under(anchor.worktreeAdmin, "index") }, { role: "worktree_trash", path: anchor.worktreeTrash });
  if (anchor.baseTrash) locations.push({ role: "base_trash", path: observed(anchor.baseTrash) });
  const markerInputs = [anchor.markerSource, anchor.worktreePath, anchor.worktreeAdmin, anchor.checkouts];
  const missing = markerInputs.find(part => part.state !== "observed");
  if (missing || !anchor.branchName) {
    const reason: Observation<string> = missing ? (missing.state === "unavailable" ? unavailable(missing.reason) : failed(missing.code)) : unavailable("location_unresolved");
    locations.push({ role: "expiration_lock_marker", path: reason }, { role: "expiration_lock_marker_dir", path: reason });
  } else {
    let markers: string[] | null = null;
    try {
      const value = (part: Observation<string>) => (part as { value: string }).value;
      const markerAnchor: GitExpirationMarkerAnchor = { sourcePath: value(anchor.markerSource), worktreePath: value(anchor.worktreePath),
        worktreeAdmin: value(anchor.worktreeAdmin), branchName: anchor.branchName,
        checkouts: (anchor.checkouts as { value: CheckoutIdentity[] }).value };
      markers = gitExpirationMarkerLocations(markerAnchor).map(location => path.join(location.root, location.relativePath));
    } catch {
      locations.push({ role: "expiration_lock_marker", path: unavailable("invalid_metadata") }, { role: "expiration_lock_marker_dir", path: unavailable("invalid_metadata") });
    }
    if (markers) {
      for (const marker of markers) locations.push({ role: "expiration_lock_marker", path: observed(marker) });
      for (const dir of [...new Set(markers.map(marker => path.dirname(marker)))]) locations.push({ role: "expiration_lock_marker_dir", path: observed(dir) });
    }
  }
  locations.push({ role: "checkout_container", path: under(anchor.worktreePath, PROJECT_REPOSITORIES_DIR) });
  if (anchor.checkouts.state !== "observed") {
    const reason = anchor.checkouts.state === "unavailable" ? unavailable<string>(anchor.checkouts.reason) : failed<string>(anchor.checkouts.code);
    locations.push({ role: "checkout_root", path: reason }, { role: "checkout_head", path: reason }, { role: "checkout_index", path: reason });
  } else {
    for (const checkout of anchor.checkouts.value) {
      const gitDir = checkout.gitDir ? observed(checkout.gitDir) : unavailable<string>("location_unresolved");
      locations.push({ role: "checkout_root", path: under(anchor.worktreePath, PROJECT_REPOSITORIES_DIR, checkout.name) },
        { role: "checkout_head", path: under(gitDir, "HEAD") }, { role: "checkout_index", path: under(gitDir, "index") });
    }
  }
  return locations;
}

export type PathValue = { present: false } | { present: true; type: string; statDigest: string };
export type PathEntry = { role: string; pathDigest: string | null; observation: Observation<PathValue> };

function entryType(stat: import("node:fs").BigIntStats) {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  if (stat.isSymbolicLink()) return "symlink";
  return "other";
}

/** `lstat` only: no child, no directory read and no budget, so it is safe after drain. */
export async function observeProtectedPaths(locations: ReadonlyArray<Location>): Promise<PathEntry[]> {
  const entries: PathEntry[] = [];
  for (const location of locations) {
    if (location.path.state !== "observed") {
      entries.push({ role: location.role, pathDigest: null, observation: location.path as Observation<never> });
      continue;
    }
    const target = location.path.value;
    const pathDigest = evidenceDigest("path", target);
    try {
      const stat = await fs.lstat(target, { bigint: true });
      entries.push({ role: location.role, pathDigest, observation: observed({ present: true, type: entryType(stat),
        statDigest: evidenceDigest("stat", { dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid,
          nlink: stat.nlink, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }) }) });
    } catch (error) {
      entries.push({ role: location.role, pathDigest, observation: (error as NodeJS.ErrnoException).code === "ENOENT"
        ? observed({ present: false }) : failed(evidenceErrorCode(error)) });
    }
  }
  return entries;
}

export type GitExpirationRowSide = {
  row: Observation<RowStateValue>;
  head: Observation<HeadValue>;
  locationSet: Observation<string>;
  paths: PathEntry[];
};

export type GitExpirationDrift = { state: "none" } | { state: "changed"; fields: string[] } | { state: "unknown"; missing: string[] };
export type GitExpirationSelectionDrift = { state: "none" } | { state: "changed"; fields: string[] };

export type GitExpirationRowEvidence = {
  selected: Observation<RowStateValue>;
  before: Observation<GitExpirationRowSide>;
  after: Observation<GitExpirationRowSide>;
  drift: GitExpirationDrift;
  selectionDrift: GitExpirationSelectionDrift;
};

type ReadRow = { workspace: Workspace; updatedAtKey: string } | null;

/** The before side, read in one pass right after both locks. Its location list is fixed and reused for after. */
export async function observeBefore(current: ReadRow, snapshot: Workspace, signal?: AbortSignal) {
  if (signal?.aborted) return { side: unavailable<GitExpirationRowSide>("row_stopped"), locations: null, anchorRow: current?.workspace ?? snapshot };
  const workspace = current?.workspace ?? snapshot;
  const row = observeRowState(current);
  const pending = pendingAnchor(workspace);
  let head: Observation<HeadValue>;
  let identity: LiveIdentity | null = null;
  if (pending) {
    head = (await observeHead(pending.worktreePath.state === "observed" ? pending.worktreePath.value : null, signal)).observation;
  } else {
    identity = await captureLiveIdentity(workspace, signal);
    head = identity.head;
  }
  const anchor = anchorFor(workspace, identity);
  const locations = protectedLocations(anchor);
  const paths = await observeProtectedPaths(locations);
  return { side: observed<GitExpirationRowSide>({ row, head, locationSet: locationSet(anchor), paths }), locations, anchorRow: workspace };
}

/** Phase A: every after step that needs a child or a budgeted read. Runs before drain and only while the row signal is live. */
export async function captureAfterIdentity(anchorRow: Workspace, signal: AbortSignal): Promise<{ head: Observation<HeadValue>; identity: LiveIdentity | null } | null> {
  if (signal.aborted) return null;
  const pending = pendingAnchor(anchorRow);
  if (pending) {
    const head = (await observeHead(pending.worktreePath.state === "observed" ? pending.worktreePath.value : null, signal)).observation;
    return { head, identity: null };
  }
  const identity = await captureLiveIdentity(anchorRow, signal);
  return { head: identity.head, identity };
}

/** Phase B: the fixed reads after drain. `reread` is the one select in the lifecycle transaction. */
export async function observeAfter(reread: () => Promise<ReadRow>, locations: ReadonlyArray<Location>,
  phaseA: { head: Observation<HeadValue>; identity: LiveIdentity | null } | null): Promise<Observation<GitExpirationRowSide>> {
  let current: ReadRow;
  let row: Observation<RowStateValue>;
  try {
    current = await reread();
    row = observeRowState(current);
  } catch (error) {
    current = null;
    row = failed(evidenceErrorCode(error));
  }
  const paths = await observeProtectedPaths(locations);
  const stoppedPart = unavailable<never>("row_stopped");
  let set: Observation<string>;
  if (row.state !== "observed" || !current) set = row.state === "observed" ? unavailable("location_unresolved") : failed((row as { code: string }).code);
  else {
    const pending = pendingAnchor(current.workspace);
    if (pending) set = locationSet(pending);
    else if (!phaseA?.identity) set = stoppedPart;
    else set = locationSet(liveAnchor(current.workspace, phaseA.identity));
  }
  return observed({ row, head: phaseA ? phaseA.head : stoppedPart, locationSet: set, paths });
}

function sideMissing(prefix: string, side: GitExpirationRowSide, missing: string[]) {
  const check = (field: string, value: Observation<unknown>) => {
    if (value.state === "observed") return;
    if (value.state === "unavailable" && value.reason === "worktree_absent") return;
    missing.push(`${prefix}.${field}`);
  };
  check("row", side.row);
  check("head", side.head);
  check("locationSet", side.locationSet);
  for (const entry of side.paths) check(`paths.${entry.role}`, entry.observation);
}

function rowFields(before: RowStateValue, after: RowStateValue, fields: string[], prefix = "row") {
  if (before.present !== after.present) { fields.push(`${prefix}.present`); return; }
  if (!before.present || !after.present) return;
  if (canonicalJson(before.key) !== canonicalJson(after.key)) fields.push(`${prefix}.key`);
  for (const name of ["status", "protectedColumns", "metadata", "gitCacheExpiration", "gitCacheRestoration"] as const) {
    if (canonicalJson(before.digests[name]) !== canonicalJson(after.digests[name])) fields.push(`${prefix}.${name}`);
  }
  if (canonicalJson(before.lifecycleGeneration) !== canonicalJson(after.lifecycleGeneration)) fields.push(`${prefix}.lifecycleGeneration`);
}

export function compareSides(before: Observation<GitExpirationRowSide>, after: Observation<GitExpirationRowSide>): GitExpirationDrift {
  if (before.state !== "observed" || after.state !== "observed") {
    return { state: "unknown", missing: [...(before.state !== "observed" ? ["before"] : []), ...(after.state !== "observed" ? ["after"] : [])] };
  }
  const fields: string[] = [];
  const missing: string[] = [];
  const b = before.value;
  const a = after.value;
  if (b.row.state === "observed" && a.row.state === "observed") rowFields(b.row.value, a.row.value, fields);
  else missing.push("row");
  if (b.head.state === "observed" && a.head.state === "observed") {
    if (b.head.value.commit !== a.head.value.commit) fields.push("head.commit");
    if (b.head.value.refDigest !== a.head.value.refDigest) fields.push("head.ref");
    if (b.head.value.gitDirDigest !== a.head.value.gitDirDigest) fields.push("head.gitDir");
  } else if (canonicalJson(b.head) !== canonicalJson(a.head)) missing.push("head");
  if (b.locationSet.state === "observed" && a.locationSet.state === "observed") {
    if (b.locationSet.value !== a.locationSet.value) fields.push("paths.locationSet");
  } else missing.push("paths.locationSet");
  for (const [index, entry] of b.paths.entries()) {
    const other = a.paths[index];
    if (!other || other.role !== entry.role) { missing.push(`paths.${entry.role}`); continue; }
    if (entry.observation.state === "observed" && other.observation.state === "observed") {
      if (canonicalJson(entry.observation.value) !== canonicalJson(other.observation.value) && !fields.includes(`paths.${entry.role}`)) fields.push(`paths.${entry.role}`);
    } else if (!missing.includes(`paths.${entry.role}`)) missing.push(`paths.${entry.role}`);
  }
  if (fields.length) return { state: "changed", fields };
  if (missing.length) return { state: "unknown", missing };
  return { state: "none" };
}

export function compareSelection(selected: Observation<RowStateValue>, before: Observation<GitExpirationRowSide>): GitExpirationSelectionDrift {
  if (selected.state !== "observed" || before.state !== "observed" || before.value.row.state !== "observed") return { state: "none" };
  const fields: string[] = [];
  rowFields(selected.value, before.value.row.value, fields);
  return fields.length ? { state: "changed", fields } : { state: "none" };
}

/** Not-observed parts of a locked row, except a legitimately absent worktree. */
export function missingEvidence(evidence: GitExpirationRowEvidence): string[] {
  const missing: string[] = [];
  for (const [name, side] of [["before", evidence.before], ["after", evidence.after]] as const) {
    if (side.state !== "observed") missing.push(name);
    else sideMissing(name, side.value, missing);
  }
  return missing;
}

export function unlockedRowEvidence(snapshot: { workspace: Workspace; updatedAtKey: string }, reason: UnavailableReason): GitExpirationRowEvidence {
  return { selected: observeRowState(snapshot), before: unavailable(reason), after: unavailable(reason), drift: { state: "unknown", missing: ["before", "after"] },
    selectionDrift: { state: "none" } };
}
