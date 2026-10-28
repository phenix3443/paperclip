import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { companies, issues, executionWorkspaces, createDb, terminateDbConnections, withDedicatedDbConnection, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { isolatedRemoteSourcePath, materializeIsolatedRemoteWorkspaceSource } from "../services/isolated-remote-workspace-source.js";
import { realizeExecutionWorkspace } from "../services/workspace-runtime.js";
import { inspectGitExpirationRound, assertGitExpirationRoundMode, GIT_EXPIRATION_ROUND_MODE, GIT_EXPIRATION_ROUND_APPLICATION_NAME,
  GitExpirationRoundInvariantError, gitExpirationRoundFailure, readOnlyInspectionGitAuth, GIT_EXPIRATION_ROUND_SESSION_PARAMETERS,
  type GitExpirationRoundEvent, type GitExpirationRoundJournal, type GitExpirationRoundOptions } from "../services/git-expiration-round.js";
import { GitCacheRestorationFailure } from "../services/git-workspace-restoration.js";
import { GIT_EXPIRATION_BUDGETS, probeGitProcessGroup, ROW_DRAIN_BOUND_MS } from "../services/git-expiration-budget.js";
import { createGitRemoteAuthProvider } from "../services/git-credentials.js";
import { parseGitExpirationRoundArgs, runGitExpirationRoundCli, GitExpirationRoundUsageError, fileGitExpirationRoundJournal,
  readGitExpirationRoundJournal, gitExpirationRoundExitCode } from "../git-expiration-round-cli.js";
import { gitExpirationEvidenceContract } from "../services/git-expiration-evidence.js";
import { CHECKOUT_LIMIT } from "../services/git-workspace-contents.js";

const faults = vi.hoisted(() => ({ git: null as ((args: readonly string[]) => Error | null) | null,
  spawn: null as ((args: readonly string[]) => string[] | null) | null, seamWrite: false, secretServices: 0 }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify: promisifyActual } = await import("node:util");
  const run = promisifyActual(actual.execFile);
  const execFile = Object.assign((...args: Parameters<typeof actual.execFile>) => actual.execFile(...args), {
    [promisifyActual.custom]: (file: string, args: readonly string[] = [], options?: object) => {
      const fault = file === "git" ? faults.git?.(args) : null;
      return fault ? Promise.reject(fault) : run(file, args as string[], options as never);
    },
  });
  const spawn = ((file: string, args: readonly string[] = [], options?: object) => {
    const replacement = file === "git" ? faults.spawn?.(args) : null;
    return replacement ? actual.spawn(replacement[0]!, replacement.slice(1), options as never) : actual.spawn(file, args as string[], options as never);
  }) as typeof actual.spawn;
  return { ...actual, execFile, spawn };
});
vi.mock("../services/secrets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/secrets.js")>();
  return { ...actual, secretService: (...args: Parameters<typeof actual.secretService>) => { faults.secretServices += 1; return actual.secretService(...args); } };
});
vi.mock("../services/git-workspace-expiration-inspection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/git-workspace-expiration-inspection.js")>();
  const { executionWorkspaces: table } = await import("@paperclipai/db");
  const { eq: equals } = await import("drizzle-orm");
  return { ...actual, inspectLockedGitExpirationCandidate: async (...args: Parameters<typeof actual.inspectLockedGitExpirationCandidate>) => {
    if (faults.seamWrite) await args[0].update(table).set({ name: "mutated" }).where(equals(table.id, args[1].id));
    return actual.inspectLockedGitExpirationCandidate(...args);
  } };
});
const sqlState = (error: unknown) => {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test", GIT_TERMINAL_PROMPT: "0" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const manualClock = () => {
  let now = 0;
  const timers = new Set<{ at: number; callback: () => void }>();
  return {
    now: () => now,
    schedule(callback: () => void, ms: number) {
      const timer = { at: now + ms, callback };
      timers.add(timer);
      return () => { timers.delete(timer); };
    },
    advance(ms: number) {
      now += ms;
      for (const timer of [...timers]) if (timer.at <= now) { timers.delete(timer); timer.callback(); }
    },
  };
};

const memoryJournal = (onAppend?: (event: GitExpirationRoundEvent) => Promise<void> | void) => {
  const events: GitExpirationRoundEvent[] = [];
  return { events, append: async (event: GitExpirationRoundEvent) => { events.push(event); await onAppend?.(event); } };
};


const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
describeEmbeddedPostgres("native Git expiration row evidence", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let root: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("git-expiration-evidence-");
    db = createDb(database.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-expiration-evidence-"));
    process.env.PAPERCLIP_HOME = path.join(root, "home");
    process.env.PAPERCLIP_INSTANCE_ID = "default";
  });
  afterEach(async () => { faults.git = null; faults.spawn = null; faults.seamWrite = false; await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = previousHome;
    if (previousInstance === undefined) delete process.env.PAPERCLIP_INSTANCE_ID; else process.env.PAPERCLIP_INSTANCE_ID = previousInstance;
    await db.$client.end({ timeout: 1 }); await database.cleanup(); await fs.rm(root, { recursive: true, force: true });
  });

  async function seed(count: number, row: Partial<typeof executionWorkspaces.$inferInsert> = {}) {
    const companyId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Round fixture", issuePrefix: `GR${companyId.slice(0, 6)}` });
    await db.insert(issues).values({ id: issueId, companyId, title: "Finished", status: "done", completedAt: new Date(Date.now() - 48 * 3_600_000) });
    const ids: string[] = [];
    const source = isolatedRemoteSourcePath(companyId, issueId);
    await fs.mkdir(source, { recursive: true });
    git(source, "init", "--initial-branch=main");
    git(source, "commit", "--allow-empty", "-m", "base");
    for (let index = 0; index < count; index += 1) {
      const id = randomUUID();
      ids.push(id);
      const cwd = path.join(root, companyId, "worktrees", id);
      git(source, "worktree", "add", "-q", "-b", `fixture-${index}`, cwd);
      await db.insert(executionWorkspaces).values({ id, companyId, sourceIssueId: issueId, mode: "isolated_workspace", strategyType: "git_worktree",
        name: `Fixture ${index}`, status: "active", providerType: "local_fs", cwd, branchName: `fixture-${index}`,
        repoUrl: "https://example.test/fixture.git", metadata: { isolatedRemoteSource: { schema: "paperclip.isolated-remote-source.v1",
          companyId, issueId, repoUrl: "https://example.test/fixture.git" } },
        updatedAt: new Date(Date.now() - (count - index) * 1000), ...row });
    }
    return { companyId, issueId, ids };
  }

  async function reconstructable(files: Record<string, string> = {}) {
    const companyId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
    const location = path.join(root, companyId), source = path.join(location, "author"), remote = path.join(location, "remote.git");
    await fs.mkdir(source, { recursive: true });
    git(source, "init", "--initial-branch=main");
    await fs.writeFile(path.join(source, "marker.txt"), "commit A\n");
    for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(source, name), content);
    git(source, "add", "."); git(source, "commit", "-m", "A");
    git(location, "clone", "--bare", source, remote);
    await db.insert(companies).values({ id: companyId, name: "Round fixture", issuePrefix: `GV${companyId.slice(0, 6)}` });
    await db.insert(issues).values({ id: issueId, companyId, title: "Finished", status: "done", completedAt: new Date(Date.now() - 48 * 3_600_000) });
    const repoUrl = pathToFileURL(remote).href;
    const baseCwd = await materializeIsolatedRemoteWorkspaceSource({ companyId, issueId, repoUrl, resolveGitAuth: async () => null });
    const base = { baseCwd, source: "task_session" as const, projectId: null, workspaceId: null, repoUrl, repoRef: "origin/main" };
    const workspace = await realizeExecutionWorkspace({ base, issue: { id: issueId, identifier: "GV-1", title: "Fixture" }, agent: { id: null, name: "Fixture", companyId },
      config: { workspaceStrategy: { type: "git_worktree", branchTemplate: "fixture-task", worktreeParentDir: path.join(location, "worktrees"), baseRef: "origin/main" } }, skipHostProvision: true });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId, mode: "isolated_workspace", strategyType: "git_worktree", name: "Fixture", status: "active",
      providerType: "local_fs", cwd: workspace.cwd, providerRef: workspace.cwd, repoUrl, baseRef: "origin/main", branchName: workspace.branchName,
      metadata: { createdByRuntime: workspace.branchCreatedByRuntime, gitBranchOwnershipVersion: 1, baseRefSha: workspace.baseRefSha,
        isolatedRemoteSource: { schema: "paperclip.isolated-remote-source.v1", companyId, issueId, repoUrl } } });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
    return { companyId, workspaceId, cwd: workspace.cwd, baseCwd };
  }

  const round = (journal: GitExpirationRoundJournal = memoryJournal(), options: Partial<GitExpirationRoundOptions> = {}) =>
    inspectGitExpirationRound({ databaseUrl: database.connectionString, mode: GIT_EXPIRATION_ROUND_MODE, roundId: "round-test", journal, ...options });

  const waitFor = async (check: () => Promise<boolean>) => {
    const deadline = Date.now() + 15_000;
    while (!await check()) {
      if (Date.now() > deadline) throw new Error("condition not reached");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  const lockWaiters = async () => Number((await db.execute<{ count: string }>(sql`select count(*)::text as count from pg_stat_activity
    where wait_event_type = 'Lock' and pid <> pg_backend_pid()`))[0]!.count);
  const roundBackends = async () => Number((await db.execute<{ count: string }>(sql`select count(*)::text as count from pg_stat_activity
    where application_name = ${GIT_EXPIRATION_ROUND_APPLICATION_NAME}`))[0]!.count);
  const advisoryLocks = async () => Number((await db.execute<{ count: string }>(sql`select count(*)::text as count from pg_locks
    where locktype = 'advisory'`))[0]!.count);

  async function holdingTableLock(table: string, action: () => Promise<void>) {
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const holder = db.transaction(async tx => {
      await tx.execute(sql.raw(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`));
      locked();
      await new Promise<void>(resolve => { release = resolve; });
    });
    await held;
    try { await action(); } finally { release(); await holder; }
  }

  type Row = Extract<GitExpirationRoundEvent, { type: "row_inspected" }>;
  const rowOf = (journal: { events: GitExpirationRoundEvent[] }) => journal.events.find((event): event is Row => event.type === "row_inspected")!;
  const roles = (side: Row["evidence"]["before"]) => side.state === "observed" ? side.value.paths.map(entry => entry.role) : [];
  const onWalk = (root: string, action: () => Promise<void>) => {
    let done = false;
    return async (directory: string) => { if (done || directory !== root) return; done = true; await action(); };
  };
  const coarseTick = () => new Promise(resolve => setTimeout(resolve, 20));

  it("prints the evidence contract without env, database, child or file", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await runGitExpirationRoundCli(["--print-evidence-contract"], {})).toBe(0);
      expect(JSON.parse(String(write.mock.calls[0]![0]))).toEqual(gitExpirationEvidenceContract());
    } finally { write.mockRestore(); }
    expect(gitExpirationEvidenceContract()).toEqual({ name: "paperclip.git-expiration-evidence", version: 1,
      capabilities: ["row_keys.v1", "row_state.v1", "row_paths.v1", "row_head.v1", "drift_stop.v1"] });
  });

  it("observes every protected role of a live candidate before and after, with no drift", async () => {
    const f = await reconstructable();
    const journal = memoryJournal();
    const summary = await round(journal, { companyId: f.companyId });
    expect(summary).toMatchObject({ status: "complete", candidates: 1, evidenceContract: gitExpirationEvidenceContract() });
    expect(journal.events[0]).toMatchObject({ type: "round_started", evidenceContract: summary.evidenceContract });
    expect(journal.events.find(event => event.type === "round_finished")).toMatchObject({ evidenceContract: summary.evidenceContract });
    const row = rowOf(journal);
    expect(row.evidence).toMatchObject({ selected: { state: "observed" }, before: { state: "observed" }, after: { state: "observed" },
      drift: { state: "none" }, selectionDrift: { state: "none" } });
    expect(new Set(roles(row.evidence.before))).toEqual(new Set(["worktree", "worktree_git_link", "source", "source_git", "worktree_admin",
      "gitdir_head", "gitdir_index", "worktree_trash", "expiration_lock_marker", "expiration_lock_marker_dir", "checkout_container"]));
    expect(roles(row.evidence.after)).toEqual(roles(row.evidence.before));
    const before = row.evidence.before.state === "observed" ? row.evidence.before.value : null;
    expect(before?.head).toMatchObject({ state: "observed", value: { commit: git(f.cwd, "rev-parse", "HEAD") } });
    expect(before?.paths.find(entry => entry.role === "checkout_container")?.observation).toEqual({ state: "observed", value: { present: false } });
    expect(before?.paths.filter(entry => entry.role === "expiration_lock_marker")).toHaveLength(3);
    expect(before?.paths.every(entry => entry.observation.state === "observed")).toBe(true);
  });

  it("reports rows that never took both locks as unavailable instead of zero", async () => {
    const f = await seed(1, { providerType: "plugin" });
    const journal = memoryJournal();
    expect(await round(journal, { companyId: f.companyId })).toMatchObject({ status: "complete", notCandidates: 1 });
    expect(rowOf(journal).evidence).toMatchObject({ selected: { state: "observed" }, before: { state: "unavailable", reason: "not_candidate" },
      after: { state: "unavailable", reason: "not_candidate" } });
  });

  it("stops evidence_unavailable when the native seam cannot name a source", async () => {
    const f = await seed(1, { repoUrl: null, metadata: {} });
    const journal = memoryJournal();
    expect(await round(journal, { companyId: f.companyId })).toMatchObject({ status: "partial", stopReason: "evidence_unavailable", rejected: 1 });
    const before = rowOf(journal).evidence.before;
    expect(before.state === "observed" && before.value.paths.find(entry => entry.role === "source")?.observation)
      .toEqual({ state: "unavailable", reason: "location_unresolved" });
  });

  it("stops evidence_unavailable with a sanitized code when the HEAD identity read fails", async () => {
    const f = await reconstructable();
    faults.spawn = args => args.includes("--absolute-git-dir") && args.includes("--symbolic-full-name") ? ["sh", "-c", "exit 128"] : null;
    const journal = memoryJournal();
    expect(await round(journal, { companyId: f.companyId })).toMatchObject({ status: "partial", stopReason: "evidence_unavailable" });
    const before = rowOf(journal).evidence.before;
    expect(before.state === "observed" && before.value.head).toEqual({ state: "error", code: "git_exit_128" });
    expect(gitExpirationRoundExitCode({ status: "partial" })).toBe(3);
  });

  it("stops protected_state_changed when row metadata changes under the locks", async () => {
    const f = await reconstructable();
    const journal = memoryJournal();
    const summary = await round(journal, { companyId: f.companyId, budgetHooks: { beforeDirectoryRead: onWalk(f.cwd, async () => {
      await db.execute(sql`update execution_workspaces set metadata = metadata || '{"touched":true}'::jsonb where id = ${f.workspaceId}`);
    }) } });
    expect(summary).toMatchObject({ status: "partial", stopReason: "protected_state_changed" });
    const row = rowOf(journal);
    expect(row.outcome).toBe("candidate");
    expect(row.evidence.drift).toMatchObject({ state: "changed", fields: expect.arrayContaining(["row.metadata", "row.protectedColumns"]) });
  });

  it("stops protected_state_changed when a lock marker appears and goes inside the window", async () => {
    const f = await reconstructable();
    const admin = git(f.cwd, "rev-parse", "--absolute-git-dir");
    const journal = memoryJournal();
    const summary = await round(journal, { companyId: f.companyId, budgetHooks: { beforeDirectoryRead: onWalk(f.cwd, async () => {
      await coarseTick();
      await fs.writeFile(path.join(admin, "index.lock"), "");
      await fs.rm(path.join(admin, "index.lock"));
    }) } });
    expect(summary).toMatchObject({ status: "partial", stopReason: "protected_state_changed" });
    expect(rowOf(journal).evidence.drift).toMatchObject({ state: "changed", fields: expect.arrayContaining(["paths.expiration_lock_marker_dir"]) });
  });

  async function pendingWithoutWorktree() {
    const f = await reconstructable();
    const [row] = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
    const admin = git(f.cwd, "rev-parse", "--absolute-git-dir");
    const recipe = { schema: "paperclip.git-cache-restoration.v1", companyId: f.companyId, workspaceId: f.workspaceId, sourceIssueId: row!.sourceIssueId,
      repoUrl: row!.repoUrl, commit: git(f.cwd, "rev-parse", "HEAD"), branchName: row!.branchName, sourceKind: "isolated_remote", projectId: null,
      sourcePath: f.baseCwd, worktreePath: f.cwd, gitBranchOwnershipVersion: 1, verifiedAt: new Date().toISOString() };
    const state = { schema: "paperclip.git-cache-expiration.v1", generation: 1, workspaceRemoved: true,
      worktreeTrash: path.join(path.dirname(f.cwd), `.expired-git-worktree-${f.workspaceId}-1`),
      worktreeAdmin: path.join(f.baseCwd, ".git", "worktrees", path.basename(admin)), baseTrash: null, completed: false };
    await db.update(executionWorkspaces).set({ status: "archived", closedAt: new Date(),
      metadata: { ...row!.metadata, lifecycleGeneration: 1, gitCacheRestoration: recipe, gitCacheExpiration: state } })
      .where(eq(executionWorkspaces.id, f.workspaceId));
    await fs.rm(f.cwd, { recursive: true, force: true });
    return { ...f, admin: state.worktreeAdmin };
  }

  it("observes a pending row whose worktree is gone from its recorded metadata, without an evidence stop", async () => {
    const f = await pendingWithoutWorktree();
    const journal = memoryJournal();
    const summary = await round(journal, { companyId: f.companyId });
    expect(summary.stopReason).not.toBe("evidence_unavailable");
    const evidence = rowOf(journal).evidence;
    expect(evidence.drift).toEqual({ state: "none" });
    const before = evidence.before.state === "observed" ? evidence.before.value : null;
    expect(before?.head).toEqual({ state: "unavailable", reason: "worktree_absent" });
    const role = (name: string) => before?.paths.find(entry => entry.role === name)?.observation;
    expect(role("worktree")).toEqual({ state: "observed", value: { present: false } });
    expect(role("checkout_container")).toEqual({ state: "observed", value: { present: false } });
    for (const name of ["worktree_admin", "source", "gitdir_head", "expiration_lock_marker_dir"]) {
      expect(role(name), name).toMatchObject({ state: "observed", value: { present: true } });
    }
  });

  it("stops protected_state_changed when a pending row's admin dir is removed inside the window", async () => {
    const f = await pendingWithoutWorktree();
    const journal = memoryJournal();
    let running!: ReturnType<typeof round>;
    await holdingTableLock("issue_recovery_actions", async () => {
      running = round(journal, { companyId: f.companyId });
      await waitFor(async () => await lockWaiters() > 0);
      await fs.rm(f.admin, { recursive: true, force: true });
    });
    expect(await running).toMatchObject({ status: "partial", stopReason: "protected_state_changed" });
    expect(rowOf(journal).evidence.drift).toMatchObject({ state: "changed", fields: expect.arrayContaining(["paths.worktree_admin"]) });
  });

  it("keeps the native resource_limit on a proof timeout: after HEAD is row_stopped, after row and paths are read after drain", async () => {
    const f = await reconstructable();
    const identity: number[] = [];
    faults.spawn = args => {
      if (args.includes("--absolute-git-dir") && args.includes("--symbolic-full-name")) identity.push(Date.now());
      return args.includes("ORIG_HEAD") ? ["sleep", "30"] : null;
    };
    const journal = memoryJournal();
    expect(await round(journal, { companyId: f.companyId, budgetHooks: { gitTimeoutMs: 300 } }))
      .toMatchObject({ status: "partial", stopReason: "resource_limit", resourceLimited: 1 });
    const evidence = rowOf(journal).evidence;
    expect(identity).toHaveLength(1);
    expect(evidence.before).toMatchObject({ state: "observed" });
    const after = evidence.after.state === "observed" ? evidence.after.value : null;
    expect(after?.head).toEqual({ state: "unavailable", reason: "row_stopped" });
    expect(after?.locationSet).toEqual({ state: "unavailable", reason: "row_stopped" });
    expect(after?.row).toMatchObject({ state: "observed" });
    expect(after?.paths.length).toBeGreaterThan(0);
    expect(after?.paths.every(entry => entry.observation.state === "observed")).toBe(true);
    expect(after?.head).not.toEqual(evidence.before.state === "observed" ? evidence.before.value.head : null);
  });

  it("starts no identity child after the round aborts during proof", async () => {
    const f = await reconstructable();
    const controller = new AbortController();
    const identity: number[] = [];
    let abortedAt = Number.POSITIVE_INFINITY;
    faults.spawn = args => {
      if (args.includes("--absolute-git-dir") && args.includes("--symbolic-full-name")) identity.push(Date.now());
      if (args.includes("ORIG_HEAD")) { setTimeout(() => { abortedAt = Date.now(); controller.abort(); }, 100); return ["sleep", "30"]; }
      return null;
    };
    expect(await round(memoryJournal(), { companyId: f.companyId, signal: controller.signal })).toMatchObject({ status: "partial", stopReason: "aborted" });
    expect(identity).toHaveLength(1);
    expect(identity.every(at => at < abortedAt)).toBe(true);
    await waitFor(async () => await advisoryLocks() === 0);
  });

  it("stops protected_state_changed when a checkout container appears", async () => {
    const f = await reconstructable();
    const journal = memoryJournal();
    const summary = await round(journal, { companyId: f.companyId, budgetHooks: { beforeDirectoryRead: onWalk(f.cwd, async () => {
      await fs.mkdir(path.join(f.cwd, ".paperclip-repositories", "added"), { recursive: true });
    }) } });
    expect(summary).toMatchObject({ status: "partial", stopReason: "protected_state_changed" });
    expect(rowOf(journal).evidence.drift).toMatchObject({ state: "changed", fields: expect.arrayContaining(["paths.checkout_container"]) });
  });

  it("records selection drift without a stop when metadata changes after selection with the same key", async () => {
    const f = await reconstructable();
    const journal = memoryJournal(async event => {
      if (event.type === "page_selected" && event.keys.length) {
        await db.execute(sql`update execution_workspaces set metadata = metadata || '{"touched":true}'::jsonb, updated_at = updated_at where id = ${f.workspaceId}`);
      }
    });
    const summary = await round(journal, { companyId: f.companyId });
    expect(summary.stopReason).not.toBe("protected_state_changed");
    const evidence = rowOf(journal).evidence;
    expect(evidence.selectionDrift).toMatchObject({ state: "changed", fields: expect.arrayContaining(["row.metadata"]) });
    expect(evidence.drift).toEqual({ state: "none" });
  });

  it("stops evidence_unavailable with invalid_metadata for a pending row whose expiration state fails validation", async () => {
    const f = await pendingWithoutWorktree();
    await db.execute(sql`update execution_workspaces set metadata = jsonb_set(metadata, '{gitCacheExpiration,worktreeTrash}', '"/elsewhere"') where id = ${f.workspaceId}`);
    const journal = memoryJournal();
    expect(await round(journal, { companyId: f.companyId })).toMatchObject({ status: "partial", stopReason: "evidence_unavailable" });
    const before = rowOf(journal).evidence.before;
    const reasons = before.state === "observed" ? new Set(before.value.paths.map(entry => entry.observation.state === "unavailable" ? entry.observation.reason : null)) : null;
    expect(reasons).toEqual(new Set(["invalid_metadata"]));
  });

  it.skipIf(process.getuid?.() === 0)("records an errno code for a denied after lstat and stops on the admin change that denied it", async () => {
    const f = await reconstructable();
    const admin = git(f.cwd, "rev-parse", "--absolute-git-dir");
    const journal = memoryJournal();
    try {
      const summary = await round(journal, { companyId: f.companyId, budgetHooks: { beforeDirectoryRead: async (directory: string) => {
        if (directory === path.join(f.cwd, ".paperclip-repositories")) await fs.chmod(admin, 0o000);
      } } });
      expect(summary).toMatchObject({ status: "partial", stopReason: "protected_state_changed" });
    } finally { await fs.chmod(admin, 0o755); }
    expect(rowOf(journal).evidence.drift).toMatchObject({ state: "changed", fields: expect.arrayContaining(["paths.worktree_admin"]) });
    const after = rowOf(journal).evidence.after;
    expect(after.state === "observed" && after.value.paths.find(entry => entry.role === "gitdir_head")?.observation).toEqual({ state: "error", code: "EACCES" });
  });

  it("lists checkout roles as checkout_budget when the container has more entries than the native limit", async () => {
    const f = await reconstructable();
    for (let index = 0; index <= CHECKOUT_LIMIT; index += 1) await fs.mkdir(path.join(f.cwd, ".paperclip-repositories", `c${index}`), { recursive: true });
    const journal = memoryJournal();
    expect(await round(journal, { companyId: f.companyId })).toMatchObject({ status: "partial", stopReason: "evidence_unavailable" });
    const before = rowOf(journal).evidence.before;
    expect(before.state === "observed" && before.value.paths.filter(entry => entry.role.startsWith("checkout_") && entry.role !== "checkout_container")
      .map(entry => entry.observation)).toEqual(Array(3).fill({ state: "unavailable", reason: "checkout_budget" }));
  });

  it("records lock_busy evidence and takes no observation when the source or lifecycle lock is held", async () => {
    for (const key of ["source", "lifecycle"] as const) {
      const f = await seed(1);
      const lock = key === "source" ? `isolated_repository_source:${f.companyId}:${f.issueId}` : `execution_workspace_lifecycle:${f.ids[0]}`;
      const journal = memoryJournal();
      await db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lock}, 0))`);
        expect(await round(journal, { companyId: f.companyId }), key).toMatchObject({ status: "partial", stopReason: "lock_busy" });
      });
      expect(rowOf(journal).evidence, key).toMatchObject({ selected: { state: "observed" }, before: { state: "unavailable", reason: "lock_busy" },
        after: { state: "unavailable", reason: "lock_busy" } });
    }
  });

  it("lists and observes the roles of a nested checkout of a live row", async () => {
    const f = await reconstructable();
    const checkout = path.join(f.cwd, ".paperclip-repositories", "nested");
    await fs.mkdir(checkout, { recursive: true });
    git(checkout, "init", "--initial-branch=topic");
    await fs.writeFile(path.join(checkout, "file.txt"), "x\n");
    git(checkout, "add", "."); git(checkout, "commit", "-m", "nested");
    const journal = memoryJournal();
    await round(journal, { companyId: f.companyId });
    const before = rowOf(journal).evidence.before;
    const value = before.state === "observed" ? before.value : null;
    for (const role of ["checkout_container", "checkout_root", "checkout_head", "checkout_index"]) {
      expect(value?.paths.find(entry => entry.role === role)?.observation, role).toMatchObject({ state: "observed", value: { present: true } });
    }
    expect(value?.paths.filter(entry => entry.role === "expiration_lock_marker")).toHaveLength(6);
  });

  it("stops protected_state_changed when the worktree .git link is pointed at another admin dir", async () => {
    const f = await reconstructable();
    const admin = git(f.cwd, "rev-parse", "--absolute-git-dir");
    const other = `${admin}-relinked`;
    const journal = memoryJournal();
    const summary = await round(journal, { companyId: f.companyId, budgetHooks: { beforeDirectoryRead: onWalk(f.cwd, async () => {
      await coarseTick();
      await fs.cp(admin, other, { recursive: true });
      await fs.writeFile(path.join(f.cwd, ".git"), `gitdir: ${other}\n`);
    }) } });
    expect(summary).toMatchObject({ status: "partial", stopReason: "protected_state_changed" });
    expect(rowOf(journal).evidence.drift).toMatchObject({ state: "changed",
      fields: expect.arrayContaining(["head.gitDir", "paths.locationSet", "paths.worktree_git_link"]) });
  });

  it("stops protected_state_changed when a nested checkout switches branch before the phase A checkout read", async () => {
    const f = await reconstructable();
    const container = path.join(f.cwd, ".paperclip-repositories");
    const checkout = path.join(container, "nested");
    await fs.mkdir(checkout, { recursive: true });
    git(checkout, "init", "--initial-branch=topic");
    await fs.writeFile(path.join(checkout, "file.txt"), "x\n");
    git(checkout, "add", "."); git(checkout, "commit", "-m", "nested");
    let reads = 0;
    const journal = memoryJournal();
    const summary = await round(journal, { companyId: f.companyId, budgetHooks: { beforeDirectoryRead: async (directory: string) => {
      if (directory !== container || ++reads !== 2) return;
      await coarseTick();
      git(checkout, "checkout", "-q", "-b", "switched");
    } } });
    expect(reads).toBe(2);
    expect(summary).toMatchObject({ status: "partial", stopReason: "protected_state_changed" });
    expect(rowOf(journal).evidence.drift).toMatchObject({ state: "changed", fields: expect.arrayContaining(["paths.locationSet", "paths.checkout_head"]) });
  });
});
