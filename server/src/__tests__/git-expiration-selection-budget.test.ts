import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { companies, issues, executionWorkspaces, createDb, withDedicatedDbConnection } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { inspectGitExpirationRound, GIT_EXPIRATION_ROUND_MODE, GIT_EXPIRATION_ROUND_APPLICATION_NAME, GitExpirationRoundInvariantError,
  gitExpirationRoundFailure, gitExpirationRoundClients, type GitExpirationRoundEvent, type GitExpirationRoundOptions } from "../services/git-expiration-round.js";
import { GIT_EXPIRATION_BUDGETS, GitExpirationBudgetExceeded } from "../services/git-expiration-budget.js";
import { parseGitExpirationRoundArgs, runGitExpirationRoundCli, fileGitExpirationRoundJournal,
  GIT_EXPIRATION_JOURNAL_TERMINAL_RESERVE_BYTES } from "../git-expiration-round-cli.js";

const memoryJournal = (onAppend?: (event: GitExpirationRoundEvent) => Promise<void> | void) => {
  const events: GitExpirationRoundEvent[] = [];
  return { events, append: async (event: GitExpirationRoundEvent) => { events.push(event); await onAppend?.(event); } };
};
const selectedKeys = (events: GitExpirationRoundEvent[]) => events.flatMap(event => event.type === "page_selected" ? event.keys : []);
const exhaustionChecks = (events: GitExpirationRoundEvent[]) => events.filter(event => event.type === "selection_exhaustion_checked");
const postgresError = (code: string, message: string) => Object.assign(new Error(message), { name: "PostgresError", code });

describe("Git expiration selection and DB budgets without a database", () => {
  it("classifies only a server statement timeout as the statement budget", () => {
    const timeout = postgresError("57014", "canceling statement due to statement timeout");
    expect(gitExpirationRoundFailure(Object.assign(new Error("Failed query", { cause: timeout }), { name: "DrizzleQueryError" })))
      .toEqual({ kind: "resource_limit", reason: "statement_timeout" });
    expect(gitExpirationRoundFailure(postgresError("57014", "canceling statement due to user request")))
      .toEqual({ kind: "database", reason: "database_error" });
    expect(gitExpirationRoundFailure(new Error("wrapped", { cause: new GitExpirationBudgetExceeded("db_connections", 4, 5) })))
      .toEqual({ kind: "resource_limit", reason: "db_connections" });
  });

  it("allows two dedicated clients beside the pool and refuses a third", () => {
    expect(gitExpirationRoundClients(0)).toBe(3);
    expect(gitExpirationRoundClients(1)).toBe(GIT_EXPIRATION_BUDGETS.dbConnections);
    expect(() => gitExpirationRoundClients(2)).toThrow(expect.objectContaining({ budget: "db_connections", limit: 4, observed: 5 }));
  });

  it("refuses selection and page budgets above the approved values before opening the database", async () => {
    const options = { databaseUrl: "postgres://127.0.0.1:1/never", mode: GIT_EXPIRATION_ROUND_MODE, roundId: "r1", journal: memoryJournal() };
    await expect(inspectGitExpirationRound({ ...options, maxRows: 10_001 })).rejects.toThrow(GitExpirationRoundInvariantError);
    await expect(inspectGitExpirationRound({ ...options, pageSize: 51 })).rejects.toThrow(GitExpirationRoundInvariantError);
  });

  it("caps the fixed CLI flags and defaults the deadline to the round budget", async () => {
    const base = ["--round-id", "r1", "--evidence-dir", "/srv/evidence/r1"];
    const env = { DATABASE_URL: "postgres://127.0.0.1:1/never" };
    expect(parseGitExpirationRoundArgs(base, env)).toMatchObject({ maxRows: undefined, deadlineSeconds: 600 });
    expect(parseGitExpirationRoundArgs([...base, "--max-rows", "10000", "--deadline-seconds", "600"], env))
      .toMatchObject({ maxRows: 10_000, deadlineSeconds: 600 });
    const evidenceDir = path.join(os.tmpdir(), `paperclip-round-cli-${randomUUID()}`);
    for (const flag of [["--max-rows", "10001"], ["--deadline-seconds", "601"]]) {
      expect(await runGitExpirationRoundCli(["--round-id", "r1", "--evidence-dir", evidenceDir, ...flag], env), flag.join(" ")).toBe(2);
    }
  });

  it("refuses a non-terminal journal event that would cut into the terminal reserve", async () => {
    let written = 0;
    const journal = fileGitExpirationRoundJournal({
      write: async (_buffer, _offset, length) => { written += length; return { bytesWritten: length }; },
      datasync: async () => undefined, truncate: async () => undefined, close: async () => undefined,
    }, GIT_EXPIRATION_JOURNAL_TERMINAL_RESERVE_BYTES + 200);
    await journal.append({ type: "page_selected", page: 1, keys: [] });
    const before = written;
    await expect(journal.append({ type: "page_selected", page: 2, keys: Array.from({ length: 10 }, () => ({ updatedAt: "t", id: randomUUID() })) }))
      .rejects.toMatchObject({ budget: "evidence" });
    expect(written).toBe(before);
    await journal.append({ type: "round_committed", roundId: "r1", status: "complete" });
    expect(journal.bytes()).toBe(written);
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;
describeEmbeddedPostgres("Git expiration selection and DB budgets", () => {
  let db: ReturnType<typeof createDb>;
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("git-expiration-selection-");
    db = createDb(database.connectionString);
  }, 60_000);
  afterEach(async () => { await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterAll(async () => { await db.$client.end({ timeout: 1 }); await database.cleanup(); });

  async function seed(count: number, row: Partial<typeof executionWorkspaces.$inferInsert> = {}) {
    const companyId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Selection fixture", issuePrefix: `GS${companyId.slice(0, 6)}` });
    await db.insert(issues).values({ id: issueId, companyId, title: "Finished", status: "done", completedAt: new Date(Date.now() - 48 * 3_600_000) });
    const at = Date.now() - 3_600_000;
    for (let start = 0; start < count; start += 1000) {
      await db.insert(executionWorkspaces).values(Array.from({ length: Math.min(1000, count - start) }, (_, offset) => ({
        id: randomUUID(), companyId, sourceIssueId: issueId, mode: "isolated_workspace", strategyType: "git_worktree", name: `Fixture ${start + offset}`,
        status: "active", providerType: "plugin", cwd: path.join(os.tmpdir(), "paperclip-selection-missing"),
        updatedAt: new Date(at + start + offset), ...row })));
    }
    return { companyId };
  }

  const round = (journal = memoryJournal(), options: Partial<GitExpirationRoundOptions> = {}) =>
    inspectGitExpirationRound({ databaseUrl: database.connectionString, mode: GIT_EXPIRATION_ROUND_MODE, roundId: "round-selection", journal, ...options });

  async function holdTableLock() {
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const holder = db.transaction(async tx => {
      await tx.execute(sql`LOCK TABLE execution_workspaces IN ACCESS EXCLUSIVE MODE`);
      locked();
      await new Promise<void>(resolve => { release = resolve; });
    });
    await held;
    return async () => { release(); await holder; };
  }

  it.each([0, 1, 49, 50, 51])("selects all %i rows under the cap without an exhaustion query", async count => {
    const { companyId } = await seed(count);
    const journal = memoryJournal();
    expect(await round(journal, { companyId })).toMatchObject({ status: "complete", selected: count, inspected: count,
      fullPages: Math.floor(count / 50), exhaustionChecked: false, budgetHit: null });
    expect(selectedKeys(journal.events)).toHaveLength(count);
    expect(exhaustionChecks(journal.events)).toEqual([]);
  });

  it.each([[1, 1, "complete"], [1, 2, "partial"], [50, 50, "complete"], [50, 60, "partial"], [51, 51, "complete"], [51, 60, "partial"]] as const)(
    "with maxRows %i and %i rows never selects a key beyond the cap and ends %s", async (maxRows, count, status) => {
      const { companyId } = await seed(count);
      const journal = memoryJournal();
      expect(await round(journal, { companyId, maxRows })).toMatchObject({ status, selected: maxRows, inspected: maxRows,
        exhaustionChecked: true, exhausted: status === "complete", stopReason: status === "complete" ? null : "row_budget" });
      expect(selectedKeys(journal.events)).toHaveLength(maxRows);
      expect(exhaustionChecks(journal.events)).toEqual([{ type: "selection_exhaustion_checked", more: status === "partial" }]);
    });

  it("follows tied timestamps one key at a time without repeating or skipping a row", async () => {
    const { companyId } = await seed(7, { updatedAt: new Date(Date.now() - 3_600_000) });
    const journal = memoryJournal();
    expect(await round(journal, { companyId, pageSize: 1 })).toMatchObject({ status: "complete", selected: 7, inspected: 7 });
    expect(new Set(selectedKeys(journal.events).map(key => key.id)).size).toBe(7);
  });

  it.each([[200, "complete"], [201, "partial"]] as const)("stops after 200 full pages with %i rows and checks exhaustion once", async (count, status) => {
    const { companyId } = await seed(count);
    const journal = memoryJournal();
    expect(await round(journal, { companyId, pageSize: 1 })).toMatchObject({ status, fullPages: 200, pages: 200, selected: 200,
      exhaustionChecked: true, stopReason: status === "complete" ? null : "row_budget" });
    expect(exhaustionChecks(journal.events)).toEqual([{ type: "selection_exhaustion_checked", more: status === "partial" }]);
  }, 60_000);

  it.each([[10_000, "complete"], [10_001, "partial"]] as const)("selects at most 10,000 rows with %i rows", async (count, status) => {
    const { companyId } = await seed(count);
    const journal = memoryJournal();
    expect(await round(journal, { companyId })).toMatchObject({ status, selected: 10_000, inspected: 10_000, fullPages: 200,
      exhaustionChecked: true, stopReason: status === "complete" ? null : "row_budget" });
    expect(selectedKeys(journal.events)).toHaveLength(10_000);
    expect(exhaustionChecks(journal.events)).toHaveLength(1);
  }, 120_000);

  it("ends a clock query at the statement budget as a round resource limit", async () => {
    const started = Date.now();
    expect(await round(memoryJournal(), { upperBoundQuery: sql`select pg_sleep(11)::text as upper_bound` })).toMatchObject({
      status: "partial", stopReason: "resource_limit", budgetHit: { budget: "statement_timeout", scope: "round", limit: 10_000 } });
    expect(Date.now() - started).toBeLessThan(10_000 + 3_000);
  }, 30_000);

  it("ends a blocked page query at the statement budget", async () => {
    await seed(1);
    const release = await holdTableLock();
    try {
      expect(await round()).toMatchObject({ status: "partial", stopReason: "resource_limit", selected: 0,
        budgetHit: { budget: "statement_timeout", scope: "round" } });
    } finally { await release(); }
  }, 30_000);

  it("ends a blocked exhaustion query at the statement budget", async () => {
    const { companyId } = await seed(2);
    let release: (() => Promise<void>) | undefined;
    const journal = memoryJournal(async event => { if (event.type === "row_inspected") release = await holdTableLock(); });
    try {
      expect(await round(journal, { companyId, maxRows: 1 })).toMatchObject({ status: "partial", stopReason: "resource_limit", selected: 1,
        exhaustionChecked: false, exhausted: false, budgetHit: { budget: "statement_timeout", scope: "round" } });
    } finally { await release?.(); }
  }, 30_000);

  it("records a row whose eligibility reread hits the statement budget", async () => {
    const { companyId } = await seed(1, { providerType: "local_fs" });
    let release: (() => Promise<void>) | undefined;
    const journal = memoryJournal(async event => { if (event.type === "page_selected") release = await holdTableLock(); });
    try {
      expect(await round(journal, { companyId })).toMatchObject({ status: "partial", stopReason: "resource_limit", resourceLimited: 1,
        budgetHit: { budget: "statement_timeout", scope: "row" } });
      expect(journal.events.find(event => event.type === "row_inspected")).toMatchObject({ outcome: "resource_limit", reason: "statement_timeout" });
    } finally { await release?.(); }
  }, 30_000);

  it("keeps a user cancel of the round statement a database error", async () => {
    const pending = round(memoryJournal(), { upperBoundQuery: sql`select pg_sleep(5)::text as upper_bound` });
    const deadline = Date.now() + 4_000;
    let cancelled = false;
    while (!cancelled && Date.now() < deadline) {
      const [row] = await db.execute<{ cancelled: boolean }>(sql`select bool_or(pg_cancel_backend(pid)) as cancelled from pg_stat_activity
        where application_name = ${GIT_EXPIRATION_ROUND_APPLICATION_NAME} and query like '%pg_sleep%'`);
      cancelled = !!row?.cancelled;
      if (!cancelled) await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(cancelled).toBe(true);
    expect(await pending).toMatchObject({ status: "partial", stopReason: "database_error", budgetHit: null });
  }, 30_000);

  it("reports an abort during a blocked page query as aborted", async () => {
    await seed(1);
    const release = await holdTableLock();
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 500);
      expect(await round(memoryJournal(), { signal: controller.signal })).toMatchObject({ status: "partial", stopReason: "aborted" });
    } finally { await release(); }
  }, 30_000);

  it("refuses a dedicated client over the guard before it connects", async () => {
    const guarded = createDb(database.connectionString, { applicationName: "selection-guard", maxConnections: 1,
      dedicatedApplicationName: "selection-guard", beforeDedicatedConnection: open => { gitExpirationRoundClients(open + 1); } });
    const backends = async () => Number((await db.execute<{ count: string }>(sql`select count(*)::text as count from pg_stat_activity
      where application_name = 'selection-guard'`))[0]!.count);
    try {
      await expect(withDedicatedDbConnection(guarded, async outer => {
        await outer.execute(sql`select 1`);
        const before = await backends();
        await expect(withDedicatedDbConnection(guarded, async () => undefined)).rejects.toMatchObject({ budget: "db_connections" });
        expect(await backends()).toBe(before);
        throw new Error("done");
      })).rejects.toThrow("done");
    } finally { await guarded.$client.end({ timeout: 1 }); }
  });

  it("stops the round at the evidence budget and still writes the terminal record", async () => {
    const { companyId } = await seed(3);
    const lines: string[] = [];
    const journal = fileGitExpirationRoundJournal({
      write: async (buffer, offset, length) => { lines.push(buffer.subarray(offset, offset + length).toString()); return { bytesWritten: length }; },
      datasync: async () => undefined, truncate: async () => undefined, close: async () => undefined,
    }, GIT_EXPIRATION_JOURNAL_TERMINAL_RESERVE_BYTES + 2_000);
    const summary = await round(journal, { companyId, pageSize: 1 });
    expect(summary).toMatchObject({ status: "partial", stopReason: "resource_limit", budgetHit: { budget: "evidence", scope: "round" } });
    const last = JSON.parse(lines.at(-1)!) as GitExpirationRoundEvent;
    expect(last).toMatchObject({ type: "round_finished", status: "partial", budgetHit: { budget: "evidence" } });
    expect(summary.peaks.journalBytes).toBeGreaterThan(0);
  });

  it("reports budgets, scratch, peaks and selection evidence for a complete round", async () => {
    const { companyId } = await seed(2);
    const journal = memoryJournal();
    const summary = await round(journal, { companyId });
    expect(journal.events[0]).toMatchObject({ type: "round_started", budgets: GIT_EXPIRATION_BUDGETS, scratchDir: os.tmpdir() });
    expect(summary).toMatchObject({ status: "complete", fullPages: 0, exhaustionChecked: false, budgetHit: null, drainIncomplete: false,
      undrainedRow: null, peaks: { dbClients: 2 } });
    expect(journal.events.find(event => event.type === "round_finished")).toMatchObject({ peaks: summary.peaks, budgetHit: null, fullPages: 0 });
  });
});
