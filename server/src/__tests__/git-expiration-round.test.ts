import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { companies, issues, executionWorkspaces, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { inspectGitExpirationRound, assertGitExpirationRoundMode, GIT_EXPIRATION_ROUND_MODE, GitExpirationRoundInvariantError,
  type GitExpirationRoundEvent } from "../services/git-expiration-round.js";
import { parseGitExpirationRoundArgs, runGitExpirationRoundCli, GitExpirationRoundUsageError } from "../git-expiration-round-cli.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const memoryJournal = (onAppend?: (event: GitExpirationRoundEvent) => Promise<void>) => {
  const events: GitExpirationRoundEvent[] = [];
  return { events, append: async (event: GitExpirationRoundEvent) => { events.push(event); await onAppend?.(event); } };
};

describe("one-round Git expiration inspection boundaries", () => {
  it("keeps the inspection seam and round away from every mutating adapter", async () => {
    const forbidden = [/git-workspace-expiration-locks/, /acquireGitExpirationLocks/, /recoverGit\w*ExpirationLocks/, /finishGitCacheTrash/,
      /captureGitWorkspaceContents/, /\brename\b/, /\bunlink\b/, /fs\.rm\b/, /\.update\(/, /\.insert\(/, /\.delete\(/,
      /clearReopenPending/, /sweepTerminalWorkspaces/, /execution-workspaces\.js/, /GIT_CACHE_EXPIRATION_REASON/, /status: "archived"/];
    for (const file of ["../services/git-workspace-expiration-inspection.ts", "../services/git-expiration-round.ts"]) {
      const source = (await fs.readFile(path.join(here, file), "utf8")).replace(/^\s*\/\/.*$/gm, "");
      for (const pattern of forbidden) expect(source, `${file} must not reference ${pattern}`).not.toMatch(pattern);
    }
  });

  it("treats any mode other than the fixed dry run as a fatal invariant violation", async () => {
    expect(() => assertGitExpirationRoundMode({ enabled: true, dryRun: false, expireBase: false })).toThrow("dry_run_required");
    expect(() => assertGitExpirationRoundMode({ enabled: false, dryRun: true, expireBase: false })).toThrow("expiration_enabled_required");
    expect(() => assertGitExpirationRoundMode({ enabled: true, dryRun: true, expireBase: true })).toThrow("base_expiration_forbidden");
    const untouchable = new Proxy({}, { get: () => { throw new Error("database accessed"); } }) as never;
    await expect(inspectGitExpirationRound(untouchable, { mode: { enabled: true, dryRun: false, expireBase: false } as never,
      roundId: "r1", journal: memoryJournal() })).rejects.toBeInstanceOf(GitExpirationRoundInvariantError);
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
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
describeEmbeddedPostgres("one-round Git expiration inspection", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("git-expiration-round-");
    db = createDb(database.connectionString);
  });
  afterEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterAll(async () => { await db.$client.end({ timeout: 1 }); await database.cleanup(); });

  async function seed(count: number) {
    const companyId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Round fixture", issuePrefix: `GR${companyId.slice(0, 6)}` });
    await db.insert(issues).values({ id: issueId, companyId, title: "Finished", status: "done", completedAt: new Date(Date.now() - 48 * 3_600_000) });
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = randomUUID();
      ids.push(id);
      // No runtime-owned branch marker, so native reconstruction proof rejects the row.
      await db.insert(executionWorkspaces).values({ id, companyId, sourceIssueId: issueId, mode: "isolated_workspace", strategyType: "git_worktree",
        name: `Fixture ${index}`, status: "active", providerType: "local_fs", cwd: path.join(os.tmpdir(), `paperclip-round-missing-${id}`),
        updatedAt: new Date(Date.now() - (count - index) * 1000) });
    }
    return { companyId, issueId, ids };
  }

  const round = (journal = memoryJournal(), options: { pageSize?: number; companyId?: string; maxRows?: number } = {}) =>
    inspectGitExpirationRound(db, { mode: GIT_EXPIRATION_ROUND_MODE, roundId: "round-test", journal, ...options });

  it("completes an empty inventory with zero rows after one empty page", async () => {
    const journal = memoryJournal();
    const summary = await round(journal);
    expect(summary).toMatchObject({ status: "complete", exhausted: true, pages: 1, selected: 0, inspected: 0,
      lastSelectedKey: null, lastCompletedKey: null, stopReason: null });
    expect(journal.events.map(event => event.type)).toEqual(["round_started", "page_selected", "round_finished"]);
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
    // Each page's keys are journaled before any of its rows.
    expect(journal.events.map(event => event.type)).toEqual(["round_started", "page_selected", "row_inspected", "row_inspected", "page_selected", "round_finished"]);
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.companyId, f.companyId))).toEqual(before);
  });

  it("reports a row changed after selection as a native rejection", async () => {
    const f = await seed(1);
    const journal = memoryJournal(async event => {
      if (event.type === "page_selected" && event.keys.length) {
        await db.update(executionWorkspaces).set({ updatedAt: new Date() }).where(eq(executionWorkspaces.id, f.ids[0]!));
      }
    });
    const summary = await round(journal, { companyId: f.companyId });
    expect(summary).toMatchObject({ status: "complete", rejected: 1 });
    expect(journal.events.find(event => event.type === "row_inspected")).toMatchObject({ outcome: "rejected", reason: "workspace_changed" });
  });

  it("stops partial on a busy source lock without waiting", async () => {
    const f = await seed(2);
    // A separate connection holds the source lock for the whole round.
    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`isolated_repository_source:${f.companyId}:${f.issueId}`}, 0))`);
      const summary = await round(memoryJournal(), { companyId: f.companyId });
      expect(summary).toMatchObject({ status: "partial", stopReason: "lock_busy", lockBusy: 1, inspected: 1, selected: 2 });
      expect(summary.lastCompletedKey?.id).toBe(f.ids[0]);
      expect(summary.lastSelectedKey?.id).toBe(f.ids[1]);
    });
  });

  it("ends partial when the row budget is spent", async () => {
    const f = await seed(3);
    const summary = await round(memoryJournal(), { companyId: f.companyId, maxRows: 1 });
    expect(summary).toMatchObject({ status: "partial", stopReason: "row_budget", inspected: 1, selected: 3 });
  });
});
