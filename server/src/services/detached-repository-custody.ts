import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { resolveDetachedRepositoryRetentionDir, resolvePaperclipInstanceRoot } from "../home-paths.js";
import { readRetentionReceipt } from "./detached-repository-retention.js";
import { readLinkedNestedCheckout, readWorktreePointer, withNestedRepositoryBaseLock } from "./nested-repository-worktrees.js";
import { sanitizeRuntimeServiceBaseEnv } from "./runtime-service-env.js";

const execFile = promisify(execFileCallback);
type State = "pending" | "retained" | "rolled_back" | "aborted" | "in_doubt" | "rollback_failed" | "conflict" | "unknown";
type Facts = { symbolicRef: string | null; commit: string | null; statusDigest: string };
type Receipt = {
  schemaVersion: 1; id: string; companyId: string; executionWorkspaceId: string; entry: string;
  source: string; destination: string; dev: number; ino: number; kind: "linked" | "standalone";
  base: string | null; lockReason: string | null; before: Facts; after?: Facts;
  createdAt: string; updatedAt: string; state: State; error?: string; rollbackStartedAt?: string;
  history: Array<{ state: State; at: string; error?: string }>;
};
export type CustodyScope = {
  companyId: string;
  executionWorkspaceId: string;
  withLifecycleLock: <T>(work: (guard: () => Promise<void>) => Promise<T>) => Promise<T>;
};
type Input = { cwd: string; active: ReadonlySet<string>; retention?: CustodyScope };

async function git(cwd: string, args: string[]) {
  return (await execFile("git", ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${os.devNull}`, "-C", cwd, ...args], {
    timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
    env: { ...sanitizeRuntimeServiceBaseEnv(process.env), GIT_TERMINAL_PROMPT: "0" },
  })).stdout;
}
async function stat(target: string) {
  return fs.lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
}
async function facts(cwd: string): Promise<Facts> {
  const marker = await stat(path.join(cwd, ".git"));
  if (!marker) return { symbolicRef: null, commit: null, statusDigest: createHash("sha256").update("non-git-directory").digest("hex") };
  if (marker.isSymbolicLink()) throw new Error("Symlink Git administration");
  if ((await git(cwd, ["rev-parse", "--show-toplevel"])).trim() !== await fs.realpath(cwd)) throw new Error("Unproven checkout root");
  return {
    symbolicRef: (await git(cwd, ["symbolic-ref", "-q", "HEAD"]).catch(() => "")).trim() || null,
    commit: (await git(cwd, ["rev-parse", "--verify", "HEAD"]).catch(() => "")).trim() || null,
    statusDigest: createHash("sha256").update(await git(cwd, ["status", "--porcelain=v2", "--untracked-files=all", "--ignored"])).digest("hex"),
  };
}
async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function safeDestination(cwd: string, scope: CustodyScope) {
  const instance = await fs.realpath(resolvePaperclipInstanceRoot());
  const requested = resolveDetachedRepositoryRetentionDir(scope);
  const directory = path.join(instance, path.relative(path.resolve(resolvePaperclipInstanceRoot()), requested));
  const task = await fs.realpath(cwd);
  const relative = path.relative(task, directory);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new Error("Retention destination is inside workspace");
  }
  let current = instance;
  for (const segment of path.relative(instance, directory).split(path.sep)) {
    current = path.join(current, segment);
    await fs.mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const entry = await fs.lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Unsafe retention parent: ${current}`);
    if (await fs.realpath(current) !== current) throw new Error(`Unsafe retention parent: ${current}`);
  }
  return directory;
}
async function writeReceipt(file: string, receipt: Receipt, initial = false) {
  const target = initial ? file : `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(receipt, null, 2) + "\n"); await handle.sync(); } finally { await handle.close(); }
  if (!initial) await fs.rename(target, file);
  await syncDirectory(path.dirname(file));
}
async function transition(file: string, receipt: Receipt, state: State, error?: unknown) {
  const at = new Date().toISOString();
  const message = error === undefined ? undefined : error instanceof Error ? error.message : String(error);
  receipt.state = state; receipt.updatedAt = at; receipt.error = message;
  receipt.history.push({ state, at, ...(message ? { error: message } : {}) });
  await writeReceipt(file, receipt);
}
async function registration(base: string, checkout: string) {
  const entries = (await git(base, ["worktree", "list", "--porcelain"])).trim().split("\n\n");
  return entries.find(entry => entry.split("\n")[0] === `worktree ${checkout}`)?.split("\n") ?? null;
}
function lockLine(entry: string[] | null) { return entry?.find(line => line === "locked" || line.startsWith("locked ")) ?? null; }
async function pin(receipt: Receipt) {
  const base = receipt.base!;
  await git(base, ["worktree", "repair", receipt.destination]);
  let entry = await registration(base, receipt.destination);
  if (!entry) throw new Error("Missing retained worktree registration");
  const lock = lockLine(entry);
  if (lock && lock !== `locked ${receipt.lockReason}`) return lock;
  if (!lock) await git(base, ["worktree", "lock", "--reason", receipt.lockReason!, receipt.destination]);
  entry = await registration(base, receipt.destination);
  if (lockLine(entry) !== `locked ${receipt.lockReason}` || !entry?.includes(`HEAD ${receipt.before.commit}`)) {
    throw new Error("Retained worktree registration changed");
  }
  return null;
}
async function verifyOriginal(receipt: Receipt) {
  const original = await stat(receipt.source);
  if (!original?.isDirectory() || original.isSymbolicLink() || original.dev !== receipt.dev || original.ino !== receipt.ino) throw new Error("Original checkout identity changed");
  if (receipt.base) {
    await git(receipt.base, ["worktree", "repair", receipt.source]);
    const lock = lockLine(await registration(receipt.base, receipt.source));
    if (lock === `locked ${receipt.lockReason}`) await git(receipt.base, ["worktree", "unlock", receipt.source]);
    else if (lock) throw new Error("Foreign lock on original checkout");
    if (!(await registration(receipt.base, receipt.source))) throw new Error("Missing original worktree registration");
  }
  const current = await facts(receipt.source);
  if (current.commit !== receipt.before.commit || current.symbolicRef !== receipt.before.symbolicRef) throw new Error("Original HEAD changed");
}
async function rollback(file: string, receipt: Receipt, error: unknown) {
  let state: State = "rolled_back";
  let failure: unknown = error;
  try {
    const destination = await stat(receipt.destination);
    if (!destination?.isDirectory() || destination.isSymbolicLink() || destination.dev !== receipt.dev || destination.ino !== receipt.ino) throw new Error("Rollback destination identity changed");
    if (receipt.base) {
      const lock = lockLine(await registration(receipt.base, receipt.destination));
      if (lock && lock !== `locked ${receipt.lockReason}`) { state = "in_doubt"; failure = lock; }
    }
    if (state !== "in_doubt") {
      if (await stat(receipt.source)) throw new Error("Original path occupied; refusing rollback overwrite");
      receipt.rollbackStartedAt = new Date().toISOString();
      await transition(file, receipt, "pending", error);
      await fs.rename(receipt.destination, receipt.source);
      await syncDirectory(path.dirname(receipt.source));
      await syncDirectory(path.dirname(receipt.destination));
      await verifyOriginal(receipt);
    }
  } catch (cause) { state = "rollback_failed"; failure = cause; }
  await transition(file, receipt, state, failure);
}
async function finalize(file: string, receipt: Receipt, guard: () => Promise<void>) {
  let foreign: string | null = null;
  try { if (receipt.base) foreign = await pin(receipt); }
  catch (error) { await rollback(file, receipt, error); return; }
  if (foreign) { await transition(file, receipt, "in_doubt", foreign); return; }
  try {
    const entry = await stat(receipt.destination);
    if (!entry?.isDirectory() || entry.isSymbolicLink() || entry.dev !== receipt.dev || entry.ino !== receipt.ino) throw new Error("Retained checkout identity changed");
    receipt.after = await facts(receipt.destination);
    if (receipt.after.commit !== receipt.before.commit || receipt.after.symbolicRef !== receipt.before.symbolicRef) throw new Error("Retained HEAD changed");
    await guard();
  } catch (error) { await rollback(file, receipt, error); return; }
  await transition(file, receipt, "retained");
}
const receiptStates: ReadonlySet<unknown> = new Set(["pending", "retained", "rolled_back", "aborted", "in_doubt", "rollback_failed", "conflict", "unknown"]);
function validFacts(value: unknown): value is Facts {
  if (!value || typeof value !== "object") return false;
  const fact = value as Record<string, unknown>;
  return (fact.symbolicRef === null || typeof fact.symbolicRef === "string")
    && (fact.commit === null || typeof fact.commit === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(fact.commit))
    && typeof fact.statusDigest === "string" && /^[a-f0-9]{64}$/.test(fact.statusDigest);
}
function validTime(value: unknown) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function validReceipt(value: Record<string, unknown>, file: string, directory: string, cwd: string, scope: CustodyScope): value is Record<string, unknown> & Receipt {
  if (value.schemaVersion !== 1 || typeof value.id !== "string" || !/^[a-f0-9-]{36}$/.test(value.id)
    || value.companyId !== scope.companyId || value.executionWorkspaceId !== scope.executionWorkspaceId
    || typeof value.entry !== "string" || path.basename(value.entry) !== value.entry || [".", "..", ""].includes(value.entry)
    || value.source !== path.join(cwd, ".paperclip-repositories", value.entry)
    || value.destination !== path.join(directory, value.id) || file !== path.join(directory, `${value.id}.json`)
    || typeof value.dev !== "number" || !Number.isSafeInteger(value.dev) || typeof value.ino !== "number" || !Number.isSafeInteger(value.ino)
    || !validFacts(value.before) || value.after !== undefined && !validFacts(value.after)
    || !receiptStates.has(value.state) || !validTime(value.createdAt) || !validTime(value.updatedAt)
    || value.rollbackStartedAt !== undefined && !validTime(value.rollbackStartedAt)
    || !Array.isArray(value.history) || value.history.length === 0
    || !value.history.every(entry => entry && receiptStates.has(entry.state) && validTime(entry.at))
    || value.history.at(-1).state !== value.state) return false;
  if (value.kind === "linked") return typeof value.base === "string" && path.isAbsolute(value.base) && value.lockReason === `paperclip detached retention ${value.id}`;
  return value.kind === "standalone" && value.base === null && value.lockReason === null;
}
async function proveReceiptLinkedAdministration(receipt: Receipt, checkout: string) {
  const common = (await git(checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  const admin = (await git(checkout, ["rev-parse", "--absolute-git-dir"])).trim();
  const storage = await fs.lstat(common);
  if (!storage.isDirectory() || storage.isSymbolicLink() || await fs.realpath(receipt.base!) !== receipt.base
    || common !== path.join(receipt.base!, ".git") || path.dirname(admin) !== path.join(common, "worktrees")
    || await fs.realpath(admin) !== admin) throw new Error("Unproven retained worktree administration");
  const pointer = await readWorktreePointer(admin);
  if (![path.join(receipt.source, ".git"), path.join(receipt.destination, ".git")].includes(pointer)) throw new Error("Foreign worktree administration");
}
async function reconcile(file: string, receipt: Receipt, guard: () => Promise<void>) {
  const source = await stat(receipt.source), destination = await stat(receipt.destination);
  const ours = (entry: Awaited<ReturnType<typeof stat>>) => entry?.isDirectory() && !entry.isSymbolicLink() && entry.dev === receipt.dev && entry.ino === receipt.ino;
  if (source && destination) return transition(file, receipt, "conflict");
  if (ours(destination)) {
    if (receipt.base) {
      try { await proveReceiptLinkedAdministration(receipt, receipt.destination); }
      catch (error) { return transition(file, receipt, "unknown", error); }
    }
    return finalize(file, receipt, guard);
  }
  if (ours(source)) {
    if (receipt.base) {
      try {
        await proveReceiptLinkedAdministration(receipt, receipt.source);
        const registered = await registration(receipt.base, receipt.source);
        if (registered) {
          await verifyOriginal(receipt);
          return transition(file, receipt, receipt.rollbackStartedAt || lockLine(registered) === `locked ${receipt.lockReason}` ? "rolled_back" : "aborted");
        }
        await verifyOriginal(receipt);
        return transition(file, receipt, "rolled_back");
      } catch (error) { return transition(file, receipt, "rollback_failed", error); }
    }
    return transition(file, receipt, receipt.rollbackStartedAt ? "rolled_back" : "aborted");
  }
  return transition(file, receipt, "unknown");
}

export async function preserveDetachedRepositories(input: Input): Promise<string[]> {
  const warnings: string[] = [];
  const root = path.join(input.cwd, ".paperclip-repositories");
  const scope = input.retention;
  const warn = (location: string, error: unknown) => warnings.push(`Could not preserve detached repository "${location}": ${error instanceof Error ? error.message : String(error)}`);
  const entries = (await fs.readdir(root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; }))
    .filter(name => !input.active.has(name) && !name.startsWith("task-repo-") && !name.includes(".clone-"));
  if (!scope) { for (const entry of entries) warn(path.join(root, entry), "Missing native retention identity"); return warnings; }
  let directory: string;
  try {
    const rootStat = await stat(root);
    if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink()
      || await fs.realpath(root) !== path.join(await fs.realpath(input.cwd), ".paperclip-repositories"))) throw new Error("Unsafe repository root");
    directory = await safeDestination(input.cwd, scope); } catch (error) { warn(root, error); return warnings; }
  const pendingSources = new Set<string>();
  let unreadableHistory = false;
  for (const name of (await fs.readdir(directory)).filter(name => name.endsWith(".json")).sort()) {
    const file = path.join(directory, name);
    try {
      const value = await readRetentionReceipt(file);
      if (!validReceipt(value, file, directory, input.cwd, scope)) throw new Error("Unrecognized custody receipt");
      if (value.state !== "pending") {
        if (!["retained", "rolled_back", "aborted"].includes(value.state)) { pendingSources.add(value.source); warn(file, value.state); }
        continue;
      }
      pendingSources.add(value.source);
      await scope.withLifecycleLock(async guard => {
        await guard();
        const action = () => reconcile(file, value, guard);
        if (value.base) await withNestedRepositoryBaseLock(value.base, action); else await action();
      });
      if (!["retained", "rolled_back", "aborted"].includes(value.state)) warn(file, value.state);
    } catch (error) { unreadableHistory = true; warn(file, error); }
  }
  if (unreadableHistory) return warnings;
  for (const entry of entries) {
    const source = path.join(root, entry);
    if (pendingSources.has(source)) continue;
    try {
      await scope.withLifecycleLock(async guard => {
        await guard();
        const original = await fs.lstat(source);
        if (!original.isDirectory() || original.isSymbolicLink()) throw new Error("Source is not a real directory");
        const linked = await readLinkedNestedCheckout(source);
        const action = async () => {
          if (linked) {
            const registered = await registration(linked.base, source);
            if (!registered) throw new Error("Missing source worktree registration");
            if (lockLine(registered)) throw new Error("Worktree lock belongs to another owner");
          } else if (await stat(path.join(source, ".git"))) {
            const worktrees = (await git(source, ["worktree", "list", "--porcelain"])).split("\n").filter(line => line.startsWith("worktree "));
            if (worktrees.length !== 1 || worktrees[0] !== `worktree ${await fs.realpath(source)}`) throw new Error("Standalone checkout has foreign worktrees");
          }
          const parent = await fs.stat(directory);
          if (parent.dev !== original.dev) throw new Error("Cross-device retention refused");
          const id = randomUUID(), destination = path.join(directory, id), file = path.join(directory, `${id}.json`);
          if (await stat(destination) || await stat(file)) throw new Error("Retention destination collision");
          const at = new Date().toISOString();
          const receipt: Receipt = { schemaVersion: 1, id, companyId: scope.companyId, executionWorkspaceId: scope.executionWorkspaceId,
            entry, source, destination, dev: original.dev, ino: original.ino, kind: linked ? "linked" : "standalone",
            base: linked?.base ?? null, lockReason: linked ? `paperclip detached retention ${id}` : null,
            before: await facts(source), createdAt: at, updatedAt: at, state: "pending", history: [{ state: "pending", at }] };
          await guard();
          await writeReceipt(file, receipt, true);
          try { await fs.rename(source, destination); }
          catch (error) { await transition(file, receipt, "aborted", error); throw error; }
          await syncDirectory(root);
          await syncDirectory(directory);
          await finalize(file, receipt, guard);
          if (receipt.state !== "retained") warn(file, receipt.error ?? receipt.state);
        };
        if (linked) await withNestedRepositoryBaseLock(linked.base, action); else await action();
      });
    } catch (error) { warn(source, error); }
  }
  return warnings;
}
