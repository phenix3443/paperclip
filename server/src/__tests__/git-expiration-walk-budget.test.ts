import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GIT_EXPIRATION_BUDGETS, GitExpirationBudgetExceeded, InspectionBudget, probeGitProcessGroup,
  runBoundedGit } from "../services/git-expiration-budget.js";
import { allocatedBytes } from "../services/git-workspace-expiration-inspection.js";
import { findRegenerableWorkspaceDirs } from "../services/workspace-compaction.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;
const LIMIT = GIT_EXPIRATION_BUDGETS.walkerEntries;

describePosix("row walker entry budget and row deadline", () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-expiration-walk-"));
  });
  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function flat(name: string, count: number) {
    const dir = path.join(root, name);
    await fs.mkdir(dir, { recursive: true });
    execFileSync("sh", ["-c", `seq 1 ${count} | xargs touch`], { cwd: dir });
    return dir;
  }

  const walk = (budget: InspectionBudget, dir: string) => budget.run(() => allocatedBytes(dir, () => true));
  const budgetOf = (error: unknown) => (error as GitExpirationBudgetExceeded).budget;

  it("allows exactly the entry budget in one large flat directory and refuses the next entry", async () => {
    const dir = await flat("flat", LIMIT - 1);
    const below = new InspectionBudget(new AbortController().signal);
    await walk(below, dir);
    expect(below.peaks.rowEntries).toBe(LIMIT - 1);
    below.close();

    await fs.writeFile(path.join(dir, "at-limit"), "");
    const at = new InspectionBudget(new AbortController().signal);
    await walk(at, dir);
    expect(at.peaks.rowEntries).toBe(LIMIT);
    expect(at.signal.aborted).toBe(false);
    at.close();

    await fs.writeFile(path.join(dir, "over-limit"), "");
    const over = new InspectionBudget(new AbortController().signal);
    const error = await walk(over, dir).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitExpirationBudgetExceeded);
    expect(error).toMatchObject({ budget: "walker_entries", limit: LIMIT, observed: LIMIT + 1 });
    expect(over.signal.aborted).toBe(true);
    over.close();

    expect(await allocatedBytes(dir, () => true)).toBeGreaterThan(0);
  }, 120_000);

  it("counts every walk of the row against one budget and does not let compaction swallow the hit", async () => {
    const worktree = await flat("split-worktree", LIMIT - 10);
    const other = await flat("split-other", 11);
    const budget = new InspectionBudget(new AbortController().signal);
    await walk(budget, worktree);
    const error = await budget.run(() => findRegenerableWorkspaceDirs(other)).catch((caught: unknown) => caught);
    expect(budgetOf(error)).toBe("walker_entries");
    expect(budget.peaks.rowEntries).toBe(LIMIT + 1);
    budget.close();
    expect(await findRegenerableWorkspaceDirs(other)).toEqual([]);
  }, 120_000);

  it("stops a walk at the row deadline", async () => {
    const dir = await flat("deadline-walk", 10);
    const budget = new InspectionBudget(new AbortController().signal, { rowMs: 50 });
    await expect.poll(() => budget.signal.aborted).toBe(true);
    const error = await walk(budget, dir).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ budget: "row_deadline", limit: 50 });
    budget.close();
  });

  it("cuts a Git command whose own timeout is longer than the time left in the row and reports the row deadline", async () => {
    const dir = path.join(root, "slow-git");
    await fs.mkdir(dir, { recursive: true });
    const pidFile = path.join(root, "slow-git.pid");
    await fs.writeFile(path.join(dir, "git"), `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` };
    const budget = new InspectionBudget(new AbortController().signal, { rowMs: 400 });
    const started = Date.now();
    const error = await budget.run(() => runBoundedGit(["status"], { env, timeout: 120_000, maxBuffer: 1024 }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GitExpirationBudgetExceeded);
    expect(budgetOf(error)).toBe("row_deadline");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(probeGitProcessGroup(Number((await fs.readFile(pidFile, "utf8")).trim()))).toBe(false);
    expect(budget.runningCount).toBe(0);
    budget.close();
  }, 15_000);
});
