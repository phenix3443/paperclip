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
import { materializeIsolatedRemoteWorkspaceSource } from "../services/isolated-remote-workspace-source.js";
import { realizeExecutionWorkspace } from "../services/workspace-runtime.js";
import { inspectGitExpirationRound, assertGitExpirationRoundMode, GIT_EXPIRATION_ROUND_MODE, GIT_EXPIRATION_ROUND_APPLICATION_NAME,
  GitExpirationRoundInvariantError, gitExpirationRoundFailure, readOnlyInspectionGitAuth, GIT_EXPIRATION_ROUND_SESSION_PARAMETERS,
  type GitExpirationRoundEvent, type GitExpirationRoundJournal, type GitExpirationRoundOptions } from "../services/git-expiration-round.js";
import { GitCacheRestorationFailure } from "../services/git-workspace-restoration.js";
import { probeGitProcessGroup, ROW_DRAIN_BOUND_MS } from "../services/git-expiration-budget.js";
import { createGitRemoteAuthProvider } from "../services/git-credentials.js";
import { parseGitExpirationRoundArgs, runGitExpirationRoundCli, GitExpirationRoundUsageError, fileGitExpirationRoundJournal,
  readGitExpirationRoundJournal, gitExpirationRoundExitCode } from "../git-expiration-round-cli.js";

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
const memoryJournal = (onAppend?: (event: GitExpirationRoundEvent) => Promise<void> | void) => {
  const events: GitExpirationRoundEvent[] = [];
  return { events, append: async (event: GitExpirationRoundEvent) => { events.push(event); await onAppend?.(event); } };
};

describe("one-round Git expiration inspection boundaries", () => {
  it("keeps the inspection seam and round away from every mutating adapter", async () => {
    const forbidden = [/git-workspace-expiration-locks/, /acquireGitExpirationLocks/, /recoverGit\w*ExpirationLocks/, /finishGitCacheTrash/,
      /captureGitWorkspaceContents/, /\brename\b/, /\bunlink\b/, /fs\.rm\b/, /\.update\(/, /\.insert\(/, /\.delete\(/,
      /clearReopenPending/, /sweepTerminalWorkspaces/, /execution-workspaces\.js/, /GIT_CACHE_EXPIRATION_REASON/, /secretService/,
      /refreshOAuthGrantCredentials/, /toolAccessService/];
    for (const file of ["../services/git-workspace-expiration-inspection.ts", "../services/git-expiration-round.ts"]) {
      const source = (await fs.readFile(path.join(here, file), "utf8")).replace(/^\s*\/\/.*$/gm, "").replace(/\/\*\*[^]*?\*\//g, "");
      for (const pattern of forbidden) expect(source, `${file} must not reference ${pattern}`).not.toMatch(pattern);
    }
  });

  it("treats any mode other than the fixed dry run as a fatal invariant violation", async () => {
    expect(() => assertGitExpirationRoundMode({ enabled: true, dryRun: false, expireBase: false })).toThrow("dry_run_required");
    expect(() => assertGitExpirationRoundMode({ enabled: false, dryRun: true, expireBase: false })).toThrow("expiration_enabled_required");
    expect(() => assertGitExpirationRoundMode({ enabled: true, dryRun: true, expireBase: true })).toThrow("base_expiration_forbidden");
    await expect(inspectGitExpirationRound({ databaseUrl: "postgres://127.0.0.1:1/never", mode: { enabled: true, dryRun: false, expireBase: false } as never,
      roundId: "r1", journal: memoryJournal() })).rejects.toBeInstanceOf(GitExpirationRoundInvariantError);
  });

  it("classifies wrapped database and resource failures instead of treating them as rejections", () => {
    const readOnly = Object.assign(new Error("cannot execute UPDATE in a read-only transaction"), { name: "PostgresError", code: "25006" });
    const wrapped = Object.assign(new Error("Failed query: update ...", { cause: readOnly }), { name: "DrizzleQueryError" });
    expect(gitExpirationRoundFailure(wrapped)).toEqual({ kind: "database", reason: "database_error" });
    const timeout = Object.assign(new Error("Command failed: git fetch"), { killed: true, signal: "SIGTERM" });
    expect(gitExpirationRoundFailure(new GitCacheRestorationFailure(timeout))).toEqual({ kind: "resource_limit", reason: "git_timeout" });
    const output = Object.assign(new Error("stdout maxBuffer length exceeded"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    expect(gitExpirationRoundFailure(new Error("managed_checkout_upstream_unavailable", { cause: output }))).toEqual({ kind: "resource_limit", reason: "git_output_limit" });
    expect(gitExpirationRoundFailure(new GitCacheRestorationFailure())).toBeNull();
    expect(gitExpirationRoundFailure(new Error("unproven_workspace_ownership"))).toBeNull();
  });

  it("resolves remote proof credentials from the server environment without a secret or database path", async () => {
    faults.secretServices = 0;
    const auth = readOnlyInspectionGitAuth({ GITHUB_TOKEN: " env-token " });
    for (const url of ["https://github.com/fixture/repo.git", "git@github.com:fixture/repo.git"]) {
      expect(await auth(url)).toMatchObject({ env: { GITHUB_TOKEN: "env-token", GH_TOKEN: "env-token" } });
    }
    expect(await auth("https://gitlab.example.test/fixture/repo.git")).toBeNull();
    expect(await readOnlyInspectionGitAuth({})("https://github.com/fixture/repo.git")).toBeNull();
    expect(faults.secretServices).toBe(0);
    try { createGitRemoteAuthProvider({} as Db, "company"); } catch (error) { expect(error).toBeInstanceOf(Error); }
    expect(faults.secretServices).toBe(1);
  });

  it("rejects conflicting flags and environment before opening the database", async () => {
    const base = ["--round-id", "r1", "--evidence-dir", "/srv/evidence/r1"];
    const env = { DATABASE_URL: "postgres://127.0.0.1:1/never" };
    expect(parseGitExpirationRoundArgs([...base, "--enabled=true", "--dry-run=true", "--expire-base=false"], env))
      .toMatchObject({ roundId: "r1", evidenceDir: "/srv/evidence/r1" });
    for (const argv of [[...base, "--dry-run=false"], [...base, "--expire-base=true"], [...base, "--enabled=false"], [...base, "--dry-run"],
      [...base, "--live"], ["--round-id", "r1", "--evidence-dir", "relative"], ["--evidence-dir", "/srv/evidence/r1"], [...base, "--max-rows", "0"]]) {
      expect(() => parseGitExpirationRoundArgs(argv, env), argv.join(" ")).toThrow(GitExpirationRoundUsageError);
    }
    for (const conflict of [{ PAPERCLIP_GIT_CACHE_EXPIRATION_DRY_RUN: "false" }, { PAPERCLIP_GIT_CACHE_EXPIRATION_ENABLED: "false" },
      { PAPERCLIP_GIT_BASE_EXPIRATION_ENABLED: "true" }]) {
      expect(() => parseGitExpirationRoundArgs(base, { ...env, ...conflict })).toThrow(GitExpirationRoundUsageError);
    }
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-round-cli-"));
    try {
      const evidenceDir = path.join(root, "evidence");
      expect(await runGitExpirationRoundCli(["--round-id", "r1", "--evidence-dir", evidenceDir, "--dry-run=false"], env)).toBe(2);
      await expect(fs.lstat(evidenceDir)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("reads a journal as complete only when it ends with the commit record of its round", () => {
    const lines = (...events: object[]) => events.map(event => `${JSON.stringify(event)}\n`).join("");
    const started = { type: "round_started", roundId: "r1" };
    const pending = { type: "round_finished", roundId: "r1", status: "pending_commit", stopReason: null };
    const committed = { type: "round_committed", roundId: "r1", status: "complete" };
    expect(readGitExpirationRoundJournal(lines(started, pending, committed))).toEqual({ status: "complete", stopReason: null });
    expect(readGitExpirationRoundJournal(lines(started, pending))).toEqual({ status: "partial", stopReason: "evidence_lost" });
    expect(readGitExpirationRoundJournal(lines(started, pending, { ...committed, roundId: "r2" }))).toEqual({ status: "partial", stopReason: "evidence_lost" });
    expect(readGitExpirationRoundJournal(lines(started, committed))).toEqual({ status: "partial", stopReason: "evidence_lost" });
    expect(readGitExpirationRoundJournal(`${lines(started, pending)}{"type":"round_committed","roundId":"r1"`)).toEqual({ status: "partial", stopReason: "evidence_lost" });
    expect(readGitExpirationRoundJournal(lines(started, pending, { ...pending, status: "partial", stopReason: "aborted" })))
      .toEqual({ status: "partial", stopReason: "aborted" });
    expect(readGitExpirationRoundJournal("")).toEqual({ status: "partial", stopReason: "evidence_lost" });
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
describeEmbeddedPostgres("one-round Git expiration inspection", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let root: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousInstance = process.env.PAPERCLIP_INSTANCE_ID;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("git-expiration-round-");
    db = createDb(database.connectionString);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-git-expiration-round-"));
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
    for (let index = 0; index < count; index += 1) {
      const id = randomUUID();
      ids.push(id);
      await db.insert(executionWorkspaces).values({ id, companyId, sourceIssueId: issueId, mode: "isolated_workspace", strategyType: "git_worktree",
        name: `Fixture ${index}`, status: "active", providerType: "local_fs", cwd: path.join(os.tmpdir(), `paperclip-round-missing-${id}`),
        updatedAt: new Date(Date.now() - (count - index) * 1000), ...row });
    }
    return { companyId, issueId, ids };
  }

  async function reconstructable() {
    const companyId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID();
    const location = path.join(root, companyId), source = path.join(location, "author"), remote = path.join(location, "remote.git");
    await fs.mkdir(source, { recursive: true });
    git(source, "init", "--initial-branch=main");
    await fs.writeFile(path.join(source, "marker.txt"), "commit A\n");
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
    return { companyId, workspaceId, cwd: workspace.cwd };
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

  it("completes an empty inventory with zero rows after one empty page", async () => {
    const journal = memoryJournal();
    const summary = await round(journal);
    expect(summary).toMatchObject({ status: "complete", exhausted: true, pages: 1, selected: 0, inspected: 0,
      lastSelectedKey: null, lastCompletedKey: null, stopReason: null });
    expect(journal.events.map(event => event.type)).toEqual(["round_started", "page_selected", "round_finished", "round_committed"]);
  });

  it("queries again after a full final page and records every row without mutating it", async () => {
    const f = await seed(2);
    const before = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.companyId, f.companyId));
    const journal = memoryJournal();
    const summary = await round(journal, { pageSize: 2, companyId: f.companyId });
    expect(summary).toMatchObject({ status: "complete", exhausted: true, pages: 2, selected: 2, inspected: 2, rejected: 2, candidates: 0 });
    expect(summary.lastCompletedKey?.id).toBe(f.ids[1]);
    expect(summary.lastSelectedKey).toEqual(summary.lastCompletedKey);
    const pages = journal.events.filter(event => event.type === "page_selected");
    expect(pages.map(page => page.type === "page_selected" && page.keys.map(key => key.id))).toEqual([f.ids, []]);
    expect(journal.events.map(event => event.type)).toEqual(["round_started", "page_selected", "row_inspected", "row_inspected", "page_selected", "round_finished", "round_committed"]);
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.companyId, f.companyId))).toEqual(before);
  });

  it("proves a reconstructable workspace through a read-only session without changing it", async () => {
    const f = await reconstructable();
    const head = git(f.cwd, "rev-parse", "HEAD");
    const before = await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId));
    const journal = memoryJournal();
    const summary = await round(journal, { companyId: f.companyId });
    expect(summary).toMatchObject({ status: "complete", candidates: 1, rejected: 0 });
    expect(journal.events.find(event => event.type === "row_inspected")).toMatchObject({ outcome: "candidate", candidateBytes: expect.any(Number) });
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.workspaceId))).toEqual(before);
    expect(git(f.cwd, "rev-parse", "HEAD")).toBe(head);
    const [{ count }] = await db.execute<{ count: string }>(sql`select count(*)::text as count from secret_access_events`) as Array<{ count: string }>;
    expect(count).toBe("0");
  });

  it("selects the rows the sweep hands to Git expiration and inspects only expiration candidates", async () => {
    const f = await seed(1);
    const [plugin, shared, foreignPending, completed] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const common = { companyId: f.companyId, sourceIssueId: (await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, f.ids[0]!)))[0]!.sourceIssueId,
      name: "Parity", cwd: "/nonexistent", updatedAt: new Date(Date.now() - 500) };
    await db.insert(executionWorkspaces).values([
      { ...common, id: plugin, mode: "isolated_workspace", strategyType: "git_worktree", status: "active", providerType: "plugin" },
      { ...common, id: shared, mode: "shared_workspace", strategyType: "project_primary", status: "idle", providerType: "local_fs" },
      { ...common, id: foreignPending, mode: "shared_workspace", strategyType: "project_primary", status: "archived", providerType: "local_fs",
        metadata: { gitCacheExpiration: { schema: "other", completed: false } } },
      { ...common, id: completed, mode: "isolated_workspace", strategyType: "git_worktree", status: "archived", providerType: "local_fs",
        metadata: { gitCacheExpiration: { schema: "paperclip.git-cache-expiration.v1", completed: true } } },
    ]);
    const journal = memoryJournal();
    const summary = await round(journal, { companyId: f.companyId });
    const rows = new Map(journal.events.flatMap(event => event.type === "row_inspected" ? [[event.workspaceId, event.outcome] as const] : []));
    expect(rows.get(f.ids[0]!)).toBe("rejected");
    expect(rows.get(plugin)).toBe("not_candidate");
    expect(rows.get(shared)).toBe("not_candidate");
    expect(rows.get(foreignPending)).toBe("not_candidate");
    expect(rows.has(completed)).toBe(false);
    expect(summary).toMatchObject({ status: "complete", selected: 4, notCandidates: 3, rejected: 1 });
  });

  it("reports a row changed after selection as a native rejection with its selected and current keys", async () => {
    const f = await seed(1);
    const journal = memoryJournal(async event => {
      if (event.type === "page_selected" && event.keys.length) {
        await db.update(executionWorkspaces).set({ updatedAt: new Date(), status: "idle" }).where(eq(executionWorkspaces.id, f.ids[0]!));
      }
    });
    const summary = await round(journal, { companyId: f.companyId });
    expect(summary).toMatchObject({ status: "complete", rejected: 1, selected: 1, pages: 1 });
    const [current] = await db.execute<{ key: string }>(sql`select updated_at::text as key from execution_workspaces where id = ${f.ids[0]}`);
    const selected = journal.events.find(event => event.type === "page_selected");
    const row = journal.events.find(event => event.type === "row_inspected");
    expect(row).toMatchObject({ outcome: "rejected", reason: "workspace_changed", status: "active",
      key: selected?.type === "page_selected" ? selected.keys[0] : null,
      current: { state: "read", key: { updatedAt: current!.key, id: f.ids[0] }, status: "idle" } });
    if (row?.type !== "row_inspected" || row.current.state !== "read") throw new Error("missing current row");
    expect(row.current.key.updatedAt).not.toBe(row.key.updatedAt);
  });

  it("records a row deleted after selection as missing", async () => {
    const f = await seed(1);
    const journal = memoryJournal(async event => {
      if (event.type === "page_selected" && event.keys.length) await db.delete(executionWorkspaces).where(eq(executionWorkspaces.id, f.ids[0]!));
    });
    expect(await round(journal, { companyId: f.companyId })).toMatchObject({ status: "complete", rejected: 1 });
    expect(journal.events.find(event => event.type === "row_inspected")).toMatchObject({ reason: "workspace_changed", current: { state: "missing" } });
  });

  it("stops partial on a busy source lock without waiting", async () => {
    const f = await seed(2);
    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`isolated_repository_source:${f.companyId}:${f.issueId}`}, 0))`);
      const summary = await round(memoryJournal(), { companyId: f.companyId });
      expect(summary).toMatchObject({ status: "partial", stopReason: "lock_busy", lockBusy: 1, inspected: 1, selected: 2 });
      expect(summary.lastCompletedKey?.id).toBe(f.ids[0]);
      expect(summary.lastSelectedKey?.id).toBe(f.ids[1]);
    });
  });

  it("stops partial when a native helper budget is hit during a real inspection", async () => {
    const f = await reconstructable();
    const gitDir = git(f.cwd, "rev-parse", "--absolute-git-dir");
    const lines = Array.from({ length: 33 }, (_, index) => `${index.toString(16).padStart(40, "a")}\t\tbranch 'b${index}' of origin\n`);
    await fs.writeFile(path.join(gitDir, "FETCH_HEAD"), lines.join(""));
    const journal = memoryJournal();
    expect(await round(journal, { companyId: f.companyId })).toMatchObject({ status: "partial", stopReason: "resource_limit", resourceLimited: 1 });
    expect(journal.events.find(event => event.type === "row_inspected")).toMatchObject({ outcome: "resource_limit", reason: "worktree_fetch_head_budget" });
  });

  it("stops partial when Git times out in a proof step that tolerates a normal Git failure", async () => {
    const f = await reconstructable();
    faults.spawn = args => args.includes("ORIG_HEAD") ? ["sleep", "30"] : null;
    const journal = memoryJournal();
    expect(await round(journal, { companyId: f.companyId, budgetHooks: { gitTimeoutMs: 300 } })).toMatchObject({ status: "partial", stopReason: "resource_limit", resourceLimited: 1, candidates: 0 });
    expect(journal.events.find(event => event.type === "row_inspected")).toMatchObject({ outcome: "resource_limit", reason: "git_timeout",
      current: { state: "read" } });
  });

  it("stops partial when Git output is too large in an ancestry proof", async () => {
    const f = await reconstructable();
    await fs.writeFile(path.join(git(f.cwd, "rev-parse", "--absolute-git-dir"), "ORIG_HEAD"), `${git(f.cwd, "rev-parse", "HEAD")}\n`);
    faults.spawn = args => args.includes("merge-base") && args.includes("--is-ancestor")
      ? ["sh", "-c", "head -c 8388608 /dev/zero; head -c 8388609 /dev/zero >&2"] : null;
    const journal = memoryJournal();
    const summary = await round(journal, { companyId: f.companyId });
    expect(summary).toMatchObject({ status: "partial", stopReason: "resource_limit", candidates: 0, drainIncomplete: false });
    expect(journal.events.find(event => event.type === "row_inspected")).toMatchObject({ outcome: "resource_limit", reason: "git_output" });
  });

  it("returns within the drain bound after a budget hit whose Git group is never proven empty, holding both locks", async () => {
    const f = await reconstructable();
    let hold = true;
    const undrained: Promise<void>[] = [];
    const journal = memoryJournal();
    const started = Date.now();
    try {
      const summary = await round(journal, { companyId: f.companyId, onUndrainedRow: released => undrained.push(released),
        budgetHooks: { probeGroup: pgid => hold || probeGitProcessGroup(pgid) } });
      expect(Date.now() - started).toBeLessThan(ROW_DRAIN_BOUND_MS + 5_000);
      expect(summary).toMatchObject({ status: "partial", stopReason: "resource_limit", resourceLimited: 1, drainIncomplete: true,
        undrainedRow: { id: f.workspaceId } });
      expect(journal.events.find(event => event.type === "row_inspected")).toMatchObject({ outcome: "resource_limit", reason: "git_group_survivor" });
      expect(journal.events.at(-1)).toMatchObject({ type: "round_finished", status: "partial", drainIncomplete: true });
      expect(undrained).toHaveLength(1);
      expect(await advisoryLocks()).toBe(2);
      expect(Number((await db.execute<{ count: string }>(sql`select count(distinct pid)::text as count from pg_locks
        where locktype = 'advisory' and granted`))[0]!.count)).toBe(2);
    } finally {
      hold = false;
    }
    await undrained[0];
    await waitFor(async () => await advisoryLocks() === 0 && await roundBackends() === 0);
  }, 30_000);

  it("refuses writes on the round's root and dedicated sessions", async () => {
    const f = await seed(1);
    const readOnly = createDb(database.connectionString, { applicationName: GIT_EXPIRATION_ROUND_APPLICATION_NAME, maxConnections: 2,
      sessionParameters: GIT_EXPIRATION_ROUND_SESSION_PARAMETERS });
    try {
      const root = await readOnly.update(companies).set({ name: "mutated" }).where(eq(companies.id, f.companyId)).then(() => null, error => error);
      expect(sqlState(root)).toBe("25006");
      const dedicated = await withDedicatedDbConnection(readOnly, connection => connection.transaction(tx =>
        tx.update(companies).set({ name: "mutated" }).where(eq(companies.id, f.companyId)))).then(() => null, error => error);
      expect(sqlState(dedicated)).toBe("25006");
    } finally { await terminateDbConnections(readOnly); }
    expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0]?.name).toBe("Round fixture");
  });

  it("ends partial with a database error when the inspection writes through the read-only session", async () => {
    const f = await seed(2);
    faults.seamWrite = true;
    const journal = memoryJournal();
    expect(await round(journal, { companyId: f.companyId })).toMatchObject({ status: "partial", stopReason: "database_error", inspected: 0, selected: 2 });
    expect(journal.events.some(event => event.type === "row_inspected")).toBe(false);
    expect((await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.companyId, f.companyId))).map(row => row.name)).not.toContain("mutated");
  });

  it("ends partial when the row budget is spent", async () => {
    const f = await seed(3);
    expect(await round(memoryJournal(), { companyId: f.companyId, maxRows: 1 }))
      .toMatchObject({ status: "partial", stopReason: "row_budget", inspected: 1, selected: 3 });
  });

  it("ends partial on abort or an expired deadline before selecting", async () => {
    await seed(1);
    const aborted = new AbortController();
    aborted.abort();
    expect(await round(memoryJournal(), { signal: aborted.signal })).toMatchObject({ status: "partial", stopReason: "aborted", pages: 0, selected: 0 });
    expect(await round(memoryJournal(), { deadline: new Date(Date.now() - 1000) })).toMatchObject({ status: "partial", stopReason: "deadline", pages: 0, selected: 0 });
  });

  it("does not report complete when the abort arrives while the final evidence is written", async () => {
    const f = await seed(1);
    const lastRow = new AbortController();
    expect(await round(memoryJournal(event => { if (event.type === "row_inspected") lastRow.abort(); }), { companyId: f.companyId, signal: lastRow.signal }))
      .toMatchObject({ status: "partial", stopReason: "aborted", exhausted: true, inspected: 1 });
    const emptyPage = new AbortController();
    expect(await round(memoryJournal(event => { if (event.type === "page_selected") emptyPage.abort(); }), { companyId: randomUUID(), signal: emptyPage.signal }))
      .toMatchObject({ status: "partial", stopReason: "aborted", exhausted: true, selected: 0 });
  });

  type JournalFault = "write" | "sync" | "sync_and_truncate" | null;
  async function fileJournal(fault: (line: string) => JournalFault = () => null, after?: (event: GitExpirationRoundEvent) => void,
    duringSync?: (line: string) => void) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-round-journal-"));
    journalRoots.push(root);
    const file = path.join(root, "events.jsonl");
    const handle = await fs.open(file, "wx", 0o600);
    let current: { line: string; kind: JournalFault } = { line: "", kind: null };
    const journal = fileGitExpirationRoundJournal({
      write: async (buffer, offset, length, position) => {
        const line = buffer.toString("utf8");
        current = { line, kind: fault(line) };
        if (current.kind === "write") { current = { line: "", kind: null }; throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" }); }
        return handle.write(buffer, offset, length, position);
      },
      datasync: async () => {
        const { line, kind } = current;
        current = { line: "", kind: kind === "sync_and_truncate" ? "sync_and_truncate" : null };
        if (line) duringSync?.(line);
        await handle.datasync();
        if (kind === "sync" || (kind === "sync_and_truncate" && line)) throw Object.assign(new Error("i/o error"), { code: "EIO" });
      },
      truncate: async length => {
        if (current.kind === "sync_and_truncate") throw Object.assign(new Error("i/o error"), { code: "EIO" });
        await handle.truncate(length);
      },
      close: () => handle.close(),
    });
    return {
      append: async (event: GitExpirationRoundEvent) => { await journal.append(event); after?.(event); },
      persisted: async () => {
        await journal.close();
        const content = await fs.readFile(file, "utf8");
        return { content, outcome: readGitExpirationRoundJournal(content),
          finished: content.split("\n").filter(Boolean).map(line => JSON.parse(line) as { type: string; status?: string })
            .filter(event => event.type === "round_finished" || event.type === "round_committed").map(event => `${event.type}:${event.status}`) };
      },
    };
  }
  const journalRoots: string[] = [];
  afterEach(async () => { for (const root of journalRoots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
  const commitLine = (line: string) => line.includes('"type":"round_committed"');
  const correctionLine = (line: string) => line.includes('"type":"round_finished"') && line.includes('"status":"partial"');

  it("persists complete only through the commit record after the pending terminal record", async () => {
    const f = await seed(1);
    const journal = await fileJournal();
    expect(await round(journal, { companyId: f.companyId })).toMatchObject({ status: "complete", stopReason: null });
    const persisted = await journal.persisted();
    expect(persisted.finished).toEqual(["round_finished:pending_commit", "round_committed:complete"]);
    expect(persisted.outcome).toEqual({ status: "complete", stopReason: null });
  });

  it("keeps the persisted outcome partial when the commit record fails before any byte is written", async () => {
    const f = await seed(1);
    const journal = await fileJournal(line => commitLine(line) ? "write" : null);
    expect(await round(journal, { companyId: f.companyId })).toMatchObject({ status: "partial", stopReason: "evidence_lost" });
    const persisted = await journal.persisted();
    expect(persisted.content).not.toContain("round_committed");
    expect(persisted.finished).toEqual(["round_finished:pending_commit"]);
    expect(persisted.outcome).toEqual({ status: "partial", stopReason: "evidence_lost" });
  });

  it("removes a commit record whose sync fails", async () => {
    const f = await seed(1);
    const journal = await fileJournal(line => commitLine(line) ? "sync" : null);
    expect(await round(journal, { companyId: f.companyId })).toMatchObject({ status: "partial", stopReason: "evidence_lost" });
    const persisted = await journal.persisted();
    expect(persisted.content).not.toContain("round_committed");
    expect(persisted.outcome).toEqual({ status: "partial", stopReason: "evidence_lost" });
  });

  it("keeps complete when the abort or deadline arrives while the commit record is written and synced", async () => {
    const f = await seed(1);
    const controller = new AbortController();
    const aborted = await fileJournal(undefined, undefined, line => { if (commitLine(line)) controller.abort(); });
    expect(await round(aborted, { companyId: f.companyId, signal: controller.signal })).toMatchObject({ status: "complete", stopReason: null });
    expect(controller.signal.aborted).toBe(true);
    const abortedEvidence = await aborted.persisted();
    expect(abortedEvidence.finished).toEqual(["round_finished:pending_commit", "round_committed:complete"]);
    expect(abortedEvidence.outcome).toEqual({ status: "complete", stopReason: null });

    const deadline = new Date(Date.now() + 10_000);
    const late = await fileJournal(undefined, undefined, line => { if (commitLine(line)) vi.setSystemTime(deadline.getTime() + 1); });
    try {
      expect(await round(late, { companyId: f.companyId, deadline })).toMatchObject({ status: "complete", stopReason: null });
    } finally { vi.useRealTimers(); }
    const lateEvidence = await late.persisted();
    expect(lateEvidence.finished).toEqual(["round_finished:pending_commit", "round_committed:complete"]);
    expect(lateEvidence.outcome).toEqual({ status: "complete", stopReason: null });

    const synced = new AbortController();
    const afterSync = await fileJournal(undefined, event => { if (event.type === "round_committed") synced.abort(); });
    expect(await round(afterSync, { companyId: f.companyId, signal: synced.signal })).toMatchObject({ status: "complete", stopReason: null });
    expect(synced.signal.aborted).toBe(true);
    expect((await afterSync.persisted()).outcome).toEqual({ status: "complete", stopReason: null });
  });

  it("ends partial when the abort arrives while the pending terminal record is synced, before the commit record starts", async () => {
    const f = await seed(1);
    const controller = new AbortController();
    const journal = await fileJournal(undefined, undefined, line => { if (line.includes('"status":"pending_commit"')) controller.abort(); });
    expect(await round(journal, { companyId: f.companyId, signal: controller.signal })).toMatchObject({ status: "partial", stopReason: "aborted" });
    const persisted = await journal.persisted();
    expect(persisted.finished).toEqual(["round_finished:pending_commit", "round_finished:partial"]);
    expect(persisted.outcome).toEqual({ status: "partial", stopReason: "aborted" });
  });

  it("gives exit code 3 with evidence_lost when a commit record that failed its sync cannot be truncated", async () => {
    const f = await seed(1);
    const journal = await fileJournal(line => commitLine(line) ? "sync_and_truncate" : null);
    const summary = await round(journal, { companyId: f.companyId });
    expect(summary).toMatchObject({ status: "partial", stopReason: "evidence_lost" });
    expect(gitExpirationRoundExitCode(summary)).toBe(3);
    const persisted = await journal.persisted();
    expect(persisted.finished).toEqual(["round_finished:pending_commit", "round_committed:complete"]);
    expect(persisted.outcome).toEqual({ status: "complete", stopReason: null });
  });

  it("does not persist complete when the abort or deadline arrives while the pending terminal record is written", async () => {
    const f = await seed(1);
    const controller = new AbortController();
    const aborted = await fileJournal(undefined, event => { if (event.type === "round_finished") controller.abort(); });
    expect(await round(aborted, { companyId: f.companyId, signal: controller.signal })).toMatchObject({ status: "partial", stopReason: "aborted" });
    const abortedEvidence = await aborted.persisted();
    expect(abortedEvidence.finished).toEqual(["round_finished:pending_commit", "round_finished:partial"]);
    expect(abortedEvidence.outcome).toEqual({ status: "partial", stopReason: "aborted" });

    const deadline = new Date(Date.now() + 10_000);
    const late = await fileJournal(undefined, event => { if (event.type === "round_finished") vi.setSystemTime(deadline.getTime() + 1); });
    try {
      expect(await round(late, { companyId: f.companyId, deadline })).toMatchObject({ status: "partial", stopReason: "deadline" });
    } finally { vi.useRealTimers(); }
    const lateEvidence = await late.persisted();
    expect(lateEvidence.content).not.toContain("round_committed");
    expect(lateEvidence.outcome).toEqual({ status: "partial", stopReason: "deadline" });
  });

  it("keeps the persisted outcome partial when the correction record fails before any byte is written", async () => {
    const f = await seed(1);
    const controller = new AbortController();
    const aborted = await fileJournal(line => correctionLine(line) ? "write" : null,
      event => { if (event.type === "round_finished") controller.abort(); });
    expect(await round(aborted, { companyId: f.companyId, signal: controller.signal })).toMatchObject({ status: "partial", stopReason: "evidence_lost" });
    const abortedEvidence = await aborted.persisted();
    expect(abortedEvidence.content).not.toContain("round_committed");
    expect(abortedEvidence.finished).toEqual(["round_finished:pending_commit"]);
    expect(abortedEvidence.outcome).toEqual({ status: "partial", stopReason: "evidence_lost" });

    const deadline = new Date(Date.now() + 10_000);
    const late = await fileJournal(line => correctionLine(line) ? "write" : null,
      event => { if (event.type === "round_finished") vi.setSystemTime(deadline.getTime() + 1); });
    try {
      expect(await round(late, { companyId: f.companyId, deadline })).toMatchObject({ status: "partial", stopReason: "evidence_lost" });
    } finally { vi.useRealTimers(); }
    const lateEvidence = await late.persisted();
    expect(lateEvidence.finished).toEqual(["round_finished:pending_commit"]);
    expect(lateEvidence.outcome).toEqual({ status: "partial", stopReason: "evidence_lost" });
  });

  it("keeps the persisted outcome partial when the pending terminal record or a partial terminal record cannot be written", async () => {
    const f = await seed(1);
    const pending = await fileJournal(line => line.includes('"status":"pending_commit"') ? "sync" : null);
    expect(await round(pending, { companyId: f.companyId })).toMatchObject({ status: "partial", stopReason: "evidence_lost" });
    const pendingEvidence = await pending.persisted();
    expect(pendingEvidence.finished).toEqual([]);
    expect(pendingEvidence.outcome).toEqual({ status: "partial", stopReason: "evidence_lost" });

    const partial = await fileJournal(line => correctionLine(line) ? "write" : null);
    expect(await round(partial, { companyId: f.companyId, maxRows: 0 })).toMatchObject({ status: "partial", stopReason: "evidence_lost" });
    const partialEvidence = await partial.persisted();
    expect(partialEvidence.finished).toEqual([]);
    expect(partialEvidence.outcome).toEqual({ status: "partial", stopReason: "evidence_lost" });
  });

  it("cancels a blocked page query and releases its connections", async () => {
    await seed(1);
    const controller = new AbortController();
    await holdingTableLock("execution_workspaces", async () => {
      const pending = round(memoryJournal(), { signal: controller.signal });
      await waitFor(async () => await lockWaiters() > 0);
      controller.abort();
      expect(await pending).toMatchObject({ status: "partial", stopReason: "aborted", inspected: 0 });
      await waitFor(async () => await roundBackends() === 0 && await lockWaiters() === 0);
    });
  });

  it("records git_timeout within the drain bound when the timed-out group is never proven empty, holding both locks", async () => {
    const f = await reconstructable();
    let hold = false;
    faults.spawn = args => args.includes("ORIG_HEAD") ? (hold = true, ["sleep", "30"]) : null;
    const undrained: Promise<void>[] = [];
    const journal = memoryJournal();
    const started = Date.now();
    try {
      const summary = await round(journal, { companyId: f.companyId, onUndrainedRow: released => undrained.push(released),
        budgetHooks: { gitTimeoutMs: 300, probeGroup: pgid => hold || probeGitProcessGroup(pgid) } });
      expect(Date.now() - started).toBeLessThan(ROW_DRAIN_BOUND_MS + 5_000);
      expect(summary).toMatchObject({ status: "partial", stopReason: "resource_limit", resourceLimited: 1, drainIncomplete: true,
        undrainedRow: { id: f.workspaceId } });
      expect(journal.events.find(event => event.type === "row_inspected")).toMatchObject({ outcome: "resource_limit", reason: "git_timeout" });
      expect(journal.events.at(-1)).toMatchObject({ type: "round_finished", status: "partial", drainIncomplete: true });
      expect(undrained).toHaveLength(1);
      expect(await advisoryLocks()).toBe(2);
    } finally {
      hold = false;
    }
    await undrained[0];
    await waitFor(async () => await advisoryLocks() === 0 && await roundBackends() === 0);
  }, 30_000);

  it("keeps the source and lifecycle sessions alive past a 2 s idle transaction timeout while a row drain is held for 6 s", async () => {
    const f = await reconstructable();
    const [{ name }] = await db.execute<{ name: string }>(sql`select current_database() as name`);
    const ident = `"${name!.replace(/"/g, '""')}"`;
    await db.execute(sql.raw(`ALTER DATABASE ${ident} SET idle_in_transaction_session_timeout = '2s'`));
    let hold = false;
    faults.spawn = args => args.includes("ORIG_HEAD") ? (hold = true, ["sleep", "30"]) : null;
    const undrained: Promise<void>[] = [];
    try {
      const pending = round(memoryJournal(), { companyId: f.companyId, onUndrainedRow: released => undrained.push(released),
        budgetHooks: { gitTimeoutMs: 300, probeGroup: pgid => hold || probeGitProcessGroup(pgid) } });
      expect(await pending).toMatchObject({ drainIncomplete: true });
      await new Promise(resolve => setTimeout(resolve, 6_000));
      expect(Number((await db.execute<{ count: string }>(sql`select count(*)::text as count from pg_stat_activity
        where state like 'idle in transaction%' and pid in (select pid from pg_locks where locktype = 'advisory' and granted)`))[0]!.count)).toBe(2);
    } finally {
      faults.spawn = null;
      hold = false;
      await db.execute(sql.raw(`ALTER DATABASE ${ident} RESET idle_in_transaction_session_timeout`));
    }
    await undrained[0];
    await waitFor(async () => await advisoryLocks() === 0 && await roundBackends() === 0);
  }, 30_000);

  it("holds both locks while a real group survivor writes scratch, then releases them only after its group is gone", async () => {
    const f = await reconstructable();
    const scratch = path.join(root, `survivor-${randomUUID()}`);
    const pidFile = `${scratch}.pid`;
    faults.spawn = args => args.includes("ORIG_HEAD")
      ? ["sh", "-c", `sh -c 'trap "" TERM; echo $$ > "${pidFile}"; while :; do echo x >> "${scratch}"; sleep 0.05; done' </dev/null >/dev/null 2>&1 & while [ ! -s "${pidFile}" ]; do sleep 0.01; done; exit 0`]
      : null;
    const journal = memoryJournal();
    const pending = round(journal, { companyId: f.companyId });
    await waitFor(async () => (await fs.readFile(pidFile, "utf8").catch(() => "")).trim() !== "");
    const member = Number((await fs.readFile(pidFile, "utf8")).trim());
    expect(await advisoryLocks()).toBe(2);
    const summary = await pending;
    expect(summary).toMatchObject({ status: "partial", stopReason: "resource_limit", resourceLimited: 1, drainIncomplete: false });
    expect(journal.events.find(event => event.type === "row_inspected")).toMatchObject({ outcome: "resource_limit", reason: "git_group_survivor" });
    expect(() => process.kill(member, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    const size = (await fs.stat(scratch)).size;
    await new Promise(resolve => setTimeout(resolve, 300));
    expect((await fs.stat(scratch)).size).toBe(size);
    await waitFor(async () => await advisoryLocks() === 0 && await roundBackends() === 0);
  }, 30_000);

  it("keeps the advisory locks of an aborted row until its blocked statement drains", async () => {
    const f = await seed(1);
    const controller = new AbortController();
    const undrained: Promise<void>[] = [];
    const journal = memoryJournal();
    await holdingTableLock("issues", async () => {
      const pending = round(journal, { companyId: f.companyId, signal: controller.signal, onUndrainedRow: released => undrained.push(released) });
      await waitFor(async () => await lockWaiters() > 0 && await advisoryLocks() > 0);
      const aborted = Date.now();
      controller.abort();
      const summary = await pending;
      expect(Date.now() - aborted).toBeLessThan(ROW_DRAIN_BOUND_MS + 2_000);
      expect(summary).toMatchObject({ status: "partial", stopReason: "aborted", inspected: 0, lastCompletedKey: null,
        drainIncomplete: true, undrainedRow: { id: f.ids[0] } });
      expect(journal.events.at(-1)).toMatchObject({ type: "round_finished", status: "partial", drainIncomplete: true });
      expect(journal.events.some(event => event.type === "row_inspected")).toBe(false);
      expect(undrained).toHaveLength(1);
      expect(await advisoryLocks()).toBe(2);
    });
    await undrained[0];
    await waitFor(async () => await lockWaiters() === 0 && await advisoryLocks() === 0 && await roundBackends() === 0);
  }, 30_000);

  it("keeps a real CLI process and its locks alive across SIGTERM until SIGKILL ends it", async () => {
    const f = await seed(1);
    const evidenceDir = path.join(root, `cli-undrained-${randomUUID()}`);
    const loader = path.resolve(here, "../../node_modules/tsx/dist/loader.mjs");
    const entry = path.resolve(here, "../git-expiration-round-cli.ts");
    let stdout = "";
    let exited!: Promise<NodeJS.Signals | number | null>;
    await holdingTableLock("issues", async () => {
      const cli = spawn(process.execPath, ["--import", pathToFileURL(loader).href, entry, "--round-id", "cli-undrained", "--evidence-dir", evidenceDir,
        "--company-id", f.companyId], { env: { ...process.env, DATABASE_URL: database.connectionString }, stdio: ["ignore", "pipe", "inherit"] });
      exited = new Promise(resolve => cli.once("exit", (code, signal) => resolve(signal ?? code)));
      cli.stdout.on("data", chunk => { stdout += String(chunk); });
      try {
        await waitFor(async () => await lockWaiters() > 0 && await advisoryLocks() === 2);
        cli.kill("SIGTERM");
        await waitFor(async () => stdout.includes("\n"));
        expect(JSON.parse(stdout)).toMatchObject({ status: "partial", stopReason: "aborted", drainIncomplete: true, undrainedRow: { id: f.ids[0] } });
        const events = (await fs.readFile(path.join(evidenceDir, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { type: string });
        expect(events.at(-1)).toMatchObject({ type: "round_finished", status: "partial", drainIncomplete: true });
        cli.kill("SIGTERM");
        await new Promise(resolve => setTimeout(resolve, 500));
        expect(cli.exitCode).toBeNull();
        expect(cli.signalCode).toBeNull();
        expect(await advisoryLocks()).toBe(2);
      } finally {
        cli.kill("SIGKILL");
      }
      expect(await exited).toBe("SIGKILL");
    });
    await waitFor(async () => await lockWaiters() === 0 && await advisoryLocks() === 0 && await roundBackends() === 0);
  }, 60_000);

  it("ends partial when evidence cannot be recorded", async () => {
    const f = await seed(2);
    const journal = memoryJournal(async event => { if (event.type === "row_inspected") throw new Error("disk full"); });
    const summary = await round(journal, { companyId: f.companyId });
    expect(summary).toMatchObject({ status: "partial", stopReason: "evidence_lost", inspected: 0, lastCompletedKey: null });
    expect(summary.lastSelectedKey?.id).toBe(f.ids[1]);
  });

  it("leaves rows updated after the upper bound to a later round", async () => {
    const f = await seed(1);
    await db.update(executionWorkspaces).set({ updatedAt: new Date(Date.now() + 3_600_000) }).where(eq(executionWorkspaces.id, f.ids[0]!));
    expect(await round(memoryJournal(), { companyId: f.companyId })).toMatchObject({ status: "complete", selected: 0 });
  });
});
