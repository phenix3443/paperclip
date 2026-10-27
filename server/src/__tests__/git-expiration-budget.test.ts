import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GIT_CHILD_KILL_GRACE_MS, GitExpirationBudgetExceeded, InspectionBudget, probeGitProcessGroup,
  runBoundedGit } from "../services/git-expiration-budget.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("bounded Git child runner", () => {
  let root: string;
  let pidFile: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-expiration-budget-"));
    pidFile = path.join(root, "pids");
  });
  afterAll(async () => {
    // Leave nothing behind if an assertion failed before the runner reaped its group.
    for (const pid of (await fs.readFile(pidFile, "utf8").catch(() => "")).split("\n").filter(Boolean)) {
      try { process.kill(Number(pid), "SIGKILL"); } catch { /* already gone */ }
    }
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Puts a fake `git` with the given shell body first on PATH. */
  async function fakeGit(name: string, body: string) {
    const dir = path.join(root, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "git"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`, PIDS: pidFile };
  }

  const run = (budget: InspectionBudget, env: NodeJS.ProcessEnv, timeout = 30_000) =>
    budget.run(() => runBoundedGit(["status"], { env, timeout, maxBuffer: 1024 * 1024 }));

  const groupOf = async () => Number((await fs.readFile(pidFile, "utf8")).trim().split("\n").at(-1));

  it("waits for a group member that outlives the leader and ignores SIGTERM, then reports a survivor", async () => {
    await fs.rm(pidFile, { force: true });
    // The helper keeps the group alive after the leader exits 0, with stdio detached from the runner.
    const env = await fakeGit("survivor", `sh -c 'trap "" TERM; echo $$ >> "$PIDS"; sleep 30' </dev/null >/dev/null 2>&1 &
echo $$ >> "$PIDS"
exit 0`);
    const budget = new InspectionBudget(new AbortController().signal);
    const started = Date.now();
    let settled = false;
    const pending = run(budget, env).finally(() => { settled = true; });
    await expect.poll(async () => (await fs.readFile(pidFile, "utf8").catch(() => "")).split("\n").filter(Boolean).length).toBe(2);
    const pgid = Number((await fs.readFile(pidFile, "utf8")).split("\n")[0]);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(settled).toBe(false);
    expect(probeGitProcessGroup(pgid)).toBe(true);
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitExpirationBudgetExceeded);
    expect((error as GitExpirationBudgetExceeded).budget).toBe("git_group_survivor");
    expect(Date.now() - started).toBeGreaterThanOrEqual(GIT_CHILD_KILL_GRACE_MS);
    expect(probeGitProcessGroup(pgid)).toBe(false);
    expect(budget.signal.aborted).toBe(true);
    expect(budget.runningCount).toBe(0);
  }, 15_000);

  it("settles an aborted child that ignores SIGTERM only after SIGKILL empties its group", async () => {
    await fs.rm(pidFile, { force: true });
    const env = await fakeGit("stubborn", `trap "" TERM
echo $$ >> "$PIDS"
sleep 30`);
    const controller = new AbortController();
    const budget = new InspectionBudget(controller.signal);
    const pending = run(budget, env).catch((caught: unknown) => caught);
    await expect.poll(async () => (await fs.readFile(pidFile, "utf8").catch(() => "")).length).toBeGreaterThan(0);
    const pgid = await groupOf();
    const aborted = Date.now();
    controller.abort();
    const error = await pending;
    expect(error).toMatchObject({ name: "AbortError" });
    expect(Date.now() - aborted).toBeGreaterThanOrEqual(GIT_CHILD_KILL_GRACE_MS);
    expect(probeGitProcessGroup(pgid)).toBe(false);
    await budget.drain();
  }, 15_000);

  it("refuses a second concurrent Git child of the same row", async () => {
    const env = await fakeGit("slow", "sleep 0.3");
    const budget = new InspectionBudget(new AbortController().signal);
    const first = run(budget, env).catch((caught: unknown) => caught);
    const second = await run(budget, env).catch((caught: unknown) => caught);
    expect(second).toBeInstanceOf(GitExpirationBudgetExceeded);
    expect((second as GitExpirationBudgetExceeded).budget).toBe("git_children");
    expect(budget.peaks.gitChildren).toBe(1);
    // The budget hit aborts the row, so the first child is stopped and drained too.
    expect(await first).toMatchObject({ name: "AbortError" });
    await budget.drain();
    expect(budget.runningCount).toBe(0);
  });

  it("classifies a full scratch disk as a budget hit instead of a Git rejection", async () => {
    const env = await fakeGit("full", `echo "fatal: unable to write new index file: No space left on device" >&2
exit 128`);
    const budget = new InspectionBudget(new AbortController().signal);
    const error = await run(budget, env).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitExpirationBudgetExceeded);
    expect((error as GitExpirationBudgetExceeded).budget).toBe("scratch");
    expect(budget.signal.aborted).toBe(true);
  });

  it("runs every child with optional locks, prompts and background maintenance off", async () => {
    const env = await fakeGit("env", `env | grep -E '^(GIT_OPTIONAL_LOCKS|GIT_TERMINAL_PROMPT|GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+))=' | sort`);
    const budget = new InspectionBudget(new AbortController().signal);
    const { stdout } = await budget.run(() => runBoundedGit(["status"], { env: { ...env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*" }, timeout: 30_000, maxBuffer: 1024 * 1024 }));
    const lines = stdout.trim().split("\n");
    expect(lines).toEqual(expect.arrayContaining(["GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_COUNT=4",
      "GIT_CONFIG_KEY_0=safe.directory", "GIT_CONFIG_KEY_1=gc.auto", "GIT_CONFIG_VALUE_1=0", "GIT_CONFIG_KEY_2=maintenance.auto",
      "GIT_CONFIG_VALUE_2=false", "GIT_CONFIG_KEY_3=core.fsmonitor", "GIT_CONFIG_VALUE_3=false"]));
  });
});
