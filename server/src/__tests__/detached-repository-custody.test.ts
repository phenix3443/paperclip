import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preserveDetachedRepositories, type CustodyScope } from "../services/detached-repository-custody.js";
import { resolveDetachedRepositoryRetentionDir, resolvePaperclipInstanceRoot } from "../home-paths.js";

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
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
  async function receipt() {
    const directory = resolveDetachedRepositoryRetentionDir(scope);
    const names = (await fs.readdir(directory)).filter(name => name.endsWith(".json"));
    expect(names).toHaveLength(1);
    return { file: path.join(directory, names[0]!), value: JSON.parse(await fs.readFile(path.join(directory, names[0]!), "utf8")) };
  }
  it("preserves dirty, ignored, stashed and private Git data by inode", async () => {
    await fs.writeFile(path.join(source, "tracked"), "stash"); git(source, "stash", "push", "-qm", "private stash");
    git(source, "update-ref", "refs/private/keep", "HEAD");
    await fs.writeFile(path.join(source, "tracked"), "dirty");
    await fs.writeFile(path.join(source, ".git", "info", "exclude"), "ignored\n");
    await fs.writeFile(path.join(source, "ignored"), "ignored bytes"); await fs.writeFile(path.join(source, "untracked"), "untracked bytes");
    const original = await fs.stat(source), stash = git(source, "stash", "list"), refs = git(source, "show-ref");
    expect(await preserveDetachedRepositories({ cwd, active: new Set(), retention: scope })).toEqual([]);
    const { value } = await receipt();
    expect(value.state).toBe("retained"); expect(value.history.map((h: { state: string }) => h.state)).toEqual(["pending", "retained"]);
    expect((await fs.stat(value.destination)).ino).toBe(original.ino);
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

});
