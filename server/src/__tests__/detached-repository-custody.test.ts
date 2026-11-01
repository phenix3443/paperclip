import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectDetachedRepositoryRetention } from "../services/detached-repository-retention.js";
import { preserveDetachedRepositories, type CustodyScope } from "../services/detached-repository-custody.js";
import { resolveDetachedRepositoryRetentionDir, resolvePaperclipInstanceRoot } from "../home-paths.js";

const gitFault = vi.hoisted(() => ({ before: (_args: readonly string[]) => {} }));
vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  function execFile(command: string, args: readonly string[], options: import("node:child_process").ExecFileOptions,
    callback: (error: Error | null, stdout: string, stderr: string) => void) {
    try { if (command === "git") gitFault.before(args); }
    catch (error) { callback(error instanceof Error ? error : new Error(String(error)), "", ""); return; }
    return actual.execFile(command, [...args], { ...options, encoding: "utf8" }, callback);
  }
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), { value: (command: string, args: readonly string[], options: import("node:child_process").ExecFileOptions) =>
    new Promise((resolve, reject) => execFile(command, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }))) });
  return { ...actual, execFile };
});

function git(cwd: string, ...args: string[]) { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim(); }
describe("detached repository custody", () => {
  let root: string, cwd: string, source: string;
  let scope: CustodyScope;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "custody-"));
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "home"));
    await fs.mkdir(resolvePaperclipInstanceRoot(), { recursive: true });
    cwd = path.join(root, "task"); source = path.join(cwd, ".paperclip-repositories", "removed");
    await fs.mkdir(source, { recursive: true });
    git(source, "init", "-q"); git(source, "config", "user.name", "Fixture"); git(source, "config", "user.email", "fixture@example.test");
    await fs.writeFile(path.join(source, "tracked"), "initial"); git(source, "add", "."); git(source, "commit", "-qm", "initial");
    scope = { companyId: "company", executionWorkspaceId: "workspace", withLifecycleLock: async work => work(async () => {}) };
  });
  afterEach(async () => { gitFault.before = () => {}; vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
  async function receipt() {
    const directory = resolveDetachedRepositoryRetentionDir(scope);
    const names = (await fs.readdir(directory)).filter(name => name.endsWith(".json"));
    expect(names).toHaveLength(1);
    return { file: path.join(directory, names[0]!), value: JSON.parse(await fs.readFile(path.join(directory, names[0]!), "utf8")) };
  }
  it("preserves dirty, ignored, stashed and private Git data by inode", async () => {
    git(cwd, "init", "-q");
    await fs.appendFile(path.resolve(cwd, git(cwd, "rev-parse", "--git-path", "info/exclude")), "\n/.paperclip-repositories/\n");
    await fs.writeFile(path.join(source, "tracked"), "private commit"); git(source, "add", "."); git(source, "commit", "-qm", "unpublished work");
    await fs.writeFile(path.join(source, "tracked"), "stash"); git(source, "stash", "push", "-qm", "private stash");
    git(source, "update-ref", "refs/private/keep", "HEAD");
    await fs.writeFile(path.join(source, "tracked"), "dirty");
    await fs.writeFile(path.join(source, ".git", "info", "exclude"), "ignored\n");
    await fs.writeFile(path.join(source, "ignored"), "ignored bytes"); await fs.writeFile(path.join(source, "untracked"), "untracked bytes");
    const original = await fs.stat(source), stash = git(source, "stash", "list"), refs = git(source, "show-ref");
    async function inventory(directory: string): Promise<Record<string, string>> {
      const found: Record<string, string> = {};
      async function walk(relative: string) {
        const target = path.join(directory, relative), stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) found[relative] = `link:${await fs.readlink(target)}`;
        else if (stat.isDirectory()) for (const child of (await fs.readdir(target)).sort()) await walk(path.join(relative, child));
        else found[relative] = `${stat.dev}:${stat.ino}:${stat.mode}:${(await fs.readFile(target)).toString("base64")}`;
      }
      await walk(""); return found;
    }
    const before = await inventory(source);
    expect(await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope })).toEqual([]);
    const { value } = await receipt();
    expect(value.state).toBe("retained"); expect(value.history.map((h: { state: string }) => h.state)).toEqual(["pending", "retained"]);
    expect((await fs.stat(value.destination)).ino).toBe(original.ino);
    expect(await inventory(value.destination)).toEqual(before);
    expect(git(cwd, "status", "--porcelain=v1", "--untracked-files=all", "--ignored")).toBe("");
    expect(git(value.destination, "stash", "list")).toBe(stash); expect(git(value.destination, "show-ref")).toBe(refs);
    for (const [file, bytes] of [["tracked", "dirty"], ["ignored", "ignored bytes"], ["untracked", "untracked bytes"]]) expect(await fs.readFile(path.join(value.destination, file!), "utf8")).toBe(bytes);
    expect(await fs.lstat(source).catch(() => null)).toBeNull();
  });
  it("leaves missing identity in place without a legacy fallback", async () => {
    expect((await preserveDetachedRepositories({ cwd, active: new Set() })).join(" ")).toContain("Missing native retention identity");
    expect(await fs.readFile(path.join(source, "tracked"), "utf8")).toBe("initial");
    expect(await fs.lstat(path.join(cwd, ".paperclip-runtime")).catch(() => null)).toBeNull();
  });
  it("pins a linked worktree and keeps its administration after prune", async () => {
    const base = path.join(root, "base"); await fs.rename(source, base);
    git(base, "worktree", "add", "-qb", "paperclip/123456789abc/private", source);
    await fs.writeFile(path.join(source, "tracked"), "dirty linked");
    expect(await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope })).toEqual([]);
    const { value } = await receipt();
    expect(value.kind).toBe("linked"); expect(value.state).toBe("retained");
    git(base, "worktree", "prune", "--expire=now");
    expect(git(base, "worktree", "list", "--porcelain")).toContain(`locked ${value.lockReason}`);
    expect(git(value.destination, "rev-parse", "HEAD")).toBe(value.before.commit);
  });
  it("rolls back when the second guard refuses", async () => {
    let checks = 0;
    scope.withLifecycleLock = async work => work(async () => { if (++checks === 3) throw new Error("queued run"); });
    const inode = (await fs.stat(source)).ino;
    expect((await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope })).join(" ")).toContain("queued run");
    const { value } = await receipt(); expect(value.state).toBe("rolled_back"); expect((await fs.stat(source)).ino).toBe(inode);
  });
  it("refuses EXDEV without copy/delete fallback and keeps other entries", async () => {
    const second = path.join(cwd, ".paperclip-repositories", "second");
    await fs.mkdir(second); await fs.writeFile(path.join(second, "keep"), "second bytes");
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(from) === source) throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
      return rename(from, to);
    });
    expect((await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope })).join(" ")).toContain("EXDEV");
    expect(await fs.readFile(path.join(source, "tracked"), "utf8")).toBe("initial");
    const directory = resolveDetachedRepositoryRetentionDir(scope);
    const receipts = await Promise.all((await fs.readdir(directory)).filter(name => name.endsWith(".json")).map(async name => JSON.parse(await fs.readFile(path.join(directory, name), "utf8"))));
    expect(receipts.map(value => value.state).sort()).toEqual(["aborted", "retained"]);
    expect(await fs.readFile(path.join(receipts.find(value => value.state === "retained").destination, "keep"), "utf8")).toBe("second bytes");
  });
  it.each(["retained", "rolled_back", "aborted", "in_doubt", "rollback_failed", "conflict", "unknown"])("does not reconcile a %s receipt", async state => {
    await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope });
    const { file, value } = await receipt(); value.state = state;
    const bytes = JSON.stringify(value); await fs.writeFile(file, bytes);
    await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope });
    expect(await fs.readFile(file, "utf8")).toBe(bytes);
    expect(await fs.readFile(path.join(value.destination, "tracked"), "utf8")).toBe("initial");
  });
  it.each(["our_lock", "no_lock", "foreign_lock"])("reconciles a pending linked checkout with %s", async lock => {
    const base = path.join(root, "base"); await fs.rename(source, base);
    git(base, "worktree", "add", "-qb", "paperclip/123456789abc/private", source);
    await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope });
    const { file, value } = await receipt(); value.state = "pending"; value.history = [value.history[0]];
    if (lock !== "our_lock") git(base, "worktree", "unlock", value.destination);
    if (lock === "foreign_lock") git(base, "worktree", "lock", "--reason", "another owner", value.destination);
    await fs.writeFile(file, JSON.stringify(value));
    await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope });
    const next = JSON.parse(await fs.readFile(file, "utf8"));
    expect(next.state).toBe(lock === "foreign_lock" ? "in_doubt" : "retained");
    expect(await fs.lstat(source).catch(() => null)).toBeNull();
    expect(git(base, "worktree", "list", "--porcelain")).toContain(`locked ${lock === "foreign_lock" ? "another owner" : value.lockReason}`);
  });
  it("preserves external cwd/fd writes during rename and later path writes", async () => {
    git(cwd, "init", "-q");
    await fs.appendFile(path.resolve(cwd, git(cwd, "rev-parse", "--git-path", "info/exclude")), "\n/.paperclip-repositories/\n");
    const child = spawn(process.execPath, ["--input-type=commonjs", "-e", String.raw`
      const fs = require("node:fs");
      const source = process.argv[1];
      process.chdir(source);
      const fd = fs.openSync("tracked", "a");
      process.stdout.write("ready\n");
      process.stdin.once("data", () => {
        fs.writeSync(fd, "-fd"); fs.writeFileSync("cwd-write", "cwd bytes");
        fs.mkdirSync(source, { recursive: true }); fs.writeFileSync(source + "/late-unique", "late bytes");
        fs.closeSync(fd); process.stdout.write("written\n");
      });
    `, source], { stdio: ["pipe", "pipe", "pipe"] });
    const lines = createInterface({ input: child.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    try {
      expect((await iterator.next()).value).toBe("ready");
      let checks = 0;
      scope.withLifecycleLock = async work => work(async () => {
        if (++checks === 3) { child.stdin.write("write"); expect((await iterator.next()).value).toBe("written"); }
      });
      expect(await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope })).toEqual([]);
      const { value } = await receipt();
      expect(await fs.readFile(path.join(value.destination, "tracked"), "utf8")).toBe("initial-fd");
      expect(await fs.readFile(path.join(value.destination, "cwd-write"), "utf8")).toBe("cwd bytes");
      expect(await fs.readFile(path.join(source, "late-unique"), "utf8")).toBe("late bytes");
      expect(git(cwd, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
      expect((await inspectDetachedRepositoryRetention({ ...scope, id: scope.executionWorkspaceId, cwd })).join(" ")).toContain("retention history (retained)");
    } finally { child.stdin.end(); child.kill(); lines.close(); }
  });

  it.each(["source", "both", "neither", "different_inode"])("reconciles pending custody by inode (%s)", async location => {
    await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope });
    const { file, value } = await receipt(); value.state = "pending"; value.history = [value.history[0]];
    if (location === "source") await fs.rename(value.destination, source);
    if (location === "both" || location === "different_inode") { await fs.mkdir(source); await fs.writeFile(path.join(source, "other"), "different bytes"); }
    if (location === "neither" || location === "different_inode") await fs.rename(value.destination, path.join(root, "elsewhere"));
    await fs.writeFile(file, JSON.stringify(value));
    await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope });
    expect(JSON.parse(await fs.readFile(file, "utf8")).state).toBe(location === "source" ? "aborted" : location === "both" ? "conflict" : "unknown");
    if (location === "both" || location === "different_inode") expect(await fs.readFile(path.join(source, "other"), "utf8")).toBe("different bytes");
  });
  it("refuses rollback over a path recreated by an unknown writer", async () => {
    let checks = 0;
    scope.withLifecycleLock = async work => work(async () => {
      if (++checks === 3) { await fs.mkdir(source); await fs.writeFile(path.join(source, "late-unique"), "late bytes"); throw new Error("new run"); }
    });
    await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope });
    const { value } = await receipt(); expect(value.state).toBe("rollback_failed");
    expect(await fs.readFile(path.join(source, "late-unique"), "utf8")).toBe("late bytes");
    expect(await fs.readFile(path.join(value.destination, "tracked"), "utf8")).toBe("initial");
  });
  it.each(["source_symlink", "parent_symlink", "inside_workspace", "foreign_worktree", "foreign_lock"])("refuses unsafe retention (%s)", async failure => {
    const original = source;
    if (failure === "source_symlink") { const elsewhere = path.join(root, "elsewhere"); await fs.rename(source, elsewhere); await fs.symlink(elsewhere, source); }
    if (failure === "parent_symlink") {
      const elsewhere = path.join(root, "elsewhere"); await fs.mkdir(elsewhere);
      await fs.symlink(elsewhere, path.join(resolvePaperclipInstanceRoot(), "detached-repositories"));
    }
    if (failure === "inside_workspace") { vi.stubEnv("PAPERCLIP_HOME", path.join(cwd, "home")); await fs.mkdir(resolvePaperclipInstanceRoot(), { recursive: true }); }
    if (failure === "foreign_worktree") git(source, "worktree", "add", "-qb", "other", path.join(root, "foreign"));
    if (failure === "foreign_lock") {
      const base = path.join(root, "base"); await fs.rename(source, base);
      git(base, "worktree", "add", "-qb", "paperclip/123456789abc/private", source);
      git(base, "worktree", "lock", "--reason", "foreign", source);
    }
    expect((await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope })).length).toBeGreaterThan(0);
    expect(await fs.readFile(path.join(original, "tracked"), "utf8")).toBe("initial");
  });

  it("finishes a pending rollback after repair and unlock already completed", async () => {
    const base = path.join(root, "base"); await fs.rename(source, base);
    git(base, "worktree", "add", "-qb", "paperclip/123456789abc/private", source);
    await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope });
    const { file, value } = await receipt();
    await fs.rename(value.destination, source); git(base, "worktree", "repair", source); git(base, "worktree", "unlock", source);
    value.state = "pending"; value.history = [value.history[0]]; value.rollbackStartedAt = new Date().toISOString();
    await fs.writeFile(file, JSON.stringify(value));
    await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope });
    expect(JSON.parse(await fs.readFile(file, "utf8")).state).toBe("rolled_back");
    expect(await fs.readFile(path.join(source, "tracked"), "utf8")).toBe("initial");
  });

  it.each([false, true])("verifies standalone HEAD after an interrupted rollback (changed: %s)", async changed => {
    await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope });
    const { file, value } = await receipt();
    await fs.rename(value.destination, source);
    value.state = "pending"; value.history = value.history.slice(0, 1); value.rollbackStartedAt = new Date().toISOString();
    await fs.writeFile(file, JSON.stringify(value));
    if (changed) {
      await fs.writeFile(path.join(source, "tracked"), "new external commit");
      git(source, "add", "."); git(source, "commit", "-qm", "external writer");
    }
    const head = git(source, "rev-parse", "HEAD"), inode = (await fs.stat(source)).ino;
    const warnings = await preserveDetachedRepositories({ cwd, active: new Set(["removed"]), retention: scope });
    expect((await receipt()).value.state).toBe(changed ? "rollback_failed" : "rolled_back");
    expect(warnings.length).toBe(changed ? 1 : 0);
    expect(git(source, "rev-parse", "HEAD")).toBe(head); expect((await fs.stat(source)).ino).toBe(inode);
  });

  it("leaves corrupt pending custody evidence and both paths unchanged", async () => {
    await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope });
    const { file, value } = await receipt(); value.state = "pending"; value.before = {}; value.history = [value.history[0]];
    const bytes = JSON.stringify(value); await fs.writeFile(file, bytes);
    expect((await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope })).join(" ")).toContain("Unrecognized custody receipt");
    expect(await fs.readFile(file, "utf8")).toBe(bytes);
    expect(await fs.lstat(source).catch(() => null)).toBeNull();
    expect(await fs.readFile(path.join(value.destination, "tracked"), "utf8")).toBe("initial");
  });

  it.each(["repair", "lock", "reverse_rename", "original_repair"])("preserves linked checkout through an injected %s failure", async failure => {
    const base = path.join(root, "base"); await fs.rename(source, base);
    git(base, "worktree", "add", "-qb", "paperclip/123456789abc/private", source);
    await fs.writeFile(path.join(source, "tracked"), "private work");
    const inode = (await fs.stat(source)).ino, head = git(source, "rev-parse", "HEAD");
    let failures = 0;
    gitFault.before = args => {
      if (!args.includes("worktree")) return;
      if (failure === "original_repair" && args.includes("repair")) throw new Error("injected repair failure");
      if (failures === 0 && args.includes(failure === "repair" ? "repair" : "lock")) { failures++; throw new Error("injected Git failure"); }
    };
    if (failure === "reverse_rename") {
      const rename = fs.rename.bind(fs);
      vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (String(to) === source) throw new Error("injected reverse rename failure");
        return rename(from, to);
      });
    }
    expect((await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope })).length).toBeGreaterThan(0);
    gitFault.before = () => {};
    const { value } = await receipt();
    const rolledBack = failure === "repair" || failure === "lock";
    expect(value.state).toBe(rolledBack ? "rolled_back" : "rollback_failed");
    const location = failure === "reverse_rename" ? value.destination : source;
    expect((await fs.stat(location)).ino).toBe(inode);
    expect(git(location, "rev-parse", "HEAD")).toBe(head);
    expect(await fs.readFile(path.join(location, "tracked"), "utf8")).toBe("private work");
    if (rolledBack) expect(git(base, "worktree", "list", "--porcelain")).not.toContain("locked");
  });

  it.each(["before_rename", "after_rename", "after_lock", "during_rollback", "before_reverse_rename"])("recovers a real process crash %s", async crash => {
    const base = path.join(root, "base"); await fs.rename(source, base);
    git(base, "worktree", "add", "-qb", "paperclip/123456789abc/private", source);
    await fs.writeFile(path.join(source, "tracked"), "private work");
    const inode = (await fs.stat(source)).ino;
    const script = `
      import fs from "node:fs/promises";
import { existsSync } from "node:fs";
      const source = ${JSON.stringify(source)}, crash = ${JSON.stringify(crash)};
      const rename = fs.rename.bind(fs), open = fs.open.bind(fs);
      fs.rename = async (from, to) => {
        if (crash === "before_reverse_rename" && to === source) process.kill(process.pid, "SIGKILL");
        if (crash === "before_rename" && from === source) process.kill(process.pid, "SIGKILL");
        await rename(from, to);
        if (crash === "after_rename" && from === source || crash === "during_rollback" && to === source) process.kill(process.pid, "SIGKILL");
      };
      fs.open = async (...args) => {
        if (crash === "after_lock" && String(args[0]).endsWith(".tmp")) process.kill(process.pid, "SIGKILL");
        return open(...args);
      };
      const { preserveDetachedRepositories } = await import(${JSON.stringify(new URL("../services/detached-repository-custody.ts", import.meta.url).href)});
      let checks = 0;
      await preserveDetachedRepositories({ cwd: ${JSON.stringify(cwd)}, active: new Set(), retention: {
        companyId: "company", executionWorkspaceId: "workspace", withLifecycleLock: async work => work(async () => {
          if (["during_rollback", "before_reverse_rename"].includes(crash) && ++checks === 3) throw new Error("queued run");
        }) } });
      process.exitCode = 2;
    `;
    const child = spawnSync(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), "--input-type=module", "-e", script], {
      timeout: 20_000, encoding: "utf8", env: process.env,
    });
    expect(child.signal, child.stderr).toBe("SIGKILL");
    const pending = await receipt(); expect(pending.value.state).toBe("pending");
    const history = pending.value.history;
    const warnings = await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope });
    expect(warnings.length).toBe(crash === "before_reverse_rename" ? 1 : 0);
    const { value } = await receipt();
    expect(value.state).toBe(crash === "before_rename" ? "aborted" : crash === "during_rollback" ? "rolled_back" : crash === "before_reverse_rename" ? "rollback_failed" : "retained");
    expect(value.history.slice(0, history.length)).toEqual(history);
    const location = ["before_rename", "during_rollback"].includes(crash) ? source : value.destination;
    expect((await fs.stat(location)).ino).toBe(inode);
    expect(await fs.readFile(path.join(location, "tracked"), "utf8")).toBe("private work");
    if (value.state === "retained") expect(git(base, "worktree", "list", "--porcelain")).toContain(`locked ${value.lockReason}`);
  }, 30_000);

  it.each(["checkout", "receipt"])("refuses an occupied retention %s path", async collision => {
    const directory = resolveDetachedRepositoryRetentionDir(scope);
    const lstat = fs.lstat.bind(fs);
    let occupied: string | null = null;
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const target = String(args[0]);
      const name = path.basename(target);
      if (!occupied && path.dirname(target) === directory && /^[a-f0-9-]{36}(?:\.json)?$/.test(name)
        && name.endsWith(".json") === (collision === "receipt")) {
        occupied = target;
        if (collision === "checkout") { await fs.mkdir(target); await fs.writeFile(path.join(target, "foreign"), "foreign bytes"); }
        else await fs.writeFile(target, "foreign receipt");
      }
      return lstat(...args);
    });
    expect((await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope })).join(" ")).toContain("collision");
    expect(await fs.readFile(path.join(source, "tracked"), "utf8")).toBe("initial");
    expect(occupied).not.toBeNull();
    expect(await fs.readFile(collision === "checkout" ? path.join(occupied!, "foreign") : occupied!, "utf8"))
      .toBe(collision === "checkout" ? "foreign bytes" : "foreign receipt");
  });

  it.each(["retained", "rolled_back", "in_doubt"])("keeps a published %s state when directory fsync fails", async state => {
    const base = path.join(root, "base"); await fs.rename(source, base);
    git(base, "worktree", "add", "-qb", "paperclip/123456789abc/private", source);
    if (state === "rolled_back") {
      let checks = 0; scope.withLifecycleLock = async work => work(async () => { if (++checks === 3) throw new Error("queued run"); });
    }
    let foreign = false;
    if (state === "in_doubt") gitFault.before = args => {
      if (!foreign && args.includes("list") && !existsSync(source)) {
        const entry = git(base, "worktree", "list", "--porcelain").split("\n").find(line => line.startsWith("worktree ") && line !== `worktree ${base}`)!;
        foreign = true; git(base, "worktree", "lock", "--reason", "foreign", entry.slice(9));
      }
    };
    const directory = resolveDetachedRepositoryRetentionDir(scope), open = fs.open.bind(fs);
    let injected = false;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]) !== directory) return handle;
      return new Proxy(handle, { get(target, key) {
        if (key === "sync") return async () => {
          const names = (await fs.readdir(directory)).filter(name => name.endsWith(".json"));
          const current = names.length ? JSON.parse(await fs.readFile(path.join(directory, names[0]!), "utf8")) : null;
          if (!injected && current?.state === state) { injected = true; throw new Error("injected directory fsync failure"); }
          return target.sync();
        };
        const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
      } });
    });
    expect((await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope })).join(" ")).toContain("injected directory fsync failure");
    expect(injected).toBe(true); gitFault.before = () => {};
    const { file, value } = await receipt(); expect(value.state).toBe(state); const bytes = await fs.readFile(file, "utf8");
    expect(await fs.readFile(path.join(state === "rolled_back" ? source : value.destination, "tracked"), "utf8")).toBe("initial");
    await preserveDetachedRepositories({ cwd, active: new Set(["removed"]), retention: scope });
    expect(await fs.readFile(file, "utf8")).toBe(bytes);
  });

  it("does not allocate custody storage when every repository is active", async () => {
    expect(await preserveDetachedRepositories({ cwd, active: new Set(["removed"]), retention: scope })).toEqual([]);
    expect(await fs.lstat(resolveDetachedRepositoryRetentionDir(scope)).catch(() => null)).toBeNull();
  });

});
