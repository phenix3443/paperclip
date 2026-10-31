import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { approvals, companies, createDb, issueApprovals, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { writeApprovalChange } from "../services/approval-work-notifications.js";
import { approvalRecords } from "../services/approvals.js";
import { insertIssueApprovalLinks, issueApprovalService } from "../services/issue-approvals.js";
import { lockIssuesForGateWrite } from "../services/execution-reconciliation-locks.js";

const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;

suite("approval gate concurrency", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-approval-gate-concurrency-");
    db = createDb(database.connectionString);
  });
  afterAll(async () => { await database?.cleanup(); });

  it("requests revision while a batch links an existing and a new issue without a deadlock", async () => {
    const [company] = await db.insert(companies).values({ name: "Approval concurrency", issuePrefix: "ACP" }).returning();
    const [approval] = await db.insert(approvals).values({ companyId: company.id, type: "hire_agent", status: "pending", payload: {} }).returning();
    const tasks = await db.insert(issues).values([
      { companyId: company.id, title: "Existing approval link" },
      { companyId: company.id, title: "New approval link" },
    ]).returning();
    await insertIssueApprovalLinks(db, { companyId: company.id, approvalId: approval.id, issueIds: [tasks[0].id] });
    let ready!: () => void;
    let release!: () => void;
    const locked = new Promise<void>(resolve => { ready = resolve; });
    const proceed = new Promise<void>(resolve => { release = resolve; });
    const linking = db.transaction(async tx => {
      await lockIssuesForGateWrite(tx, company.id, tasks.map(task => task.id));
      ready();
      await proceed;
      await insertIssueApprovalLinks(tx, { companyId: company.id, approvalId: approval.id, issueIds: tasks.map(task => task.id) });
    });
    await locked;
    const revising = approvalRecords(db).requestRevision(approval.id, "concurrency-operator");
    const deadline = Date.now() + 5_000;
    let waiting = false;
    try {
      while (Date.now() < deadline) {
        const rows = await db.execute(sql`select 1 from pg_stat_activity where datname = current_database()
          and pid <> pg_backend_pid() and wait_event_type = 'Lock' and query like '%"issues"%'`);
        if (rows.length) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } finally { release(); }
    const [, revised] = await Promise.all([linking, revising]);
    expect(waiting).toBe(true);
    expect(revised.status).toBe("revision_requested");
    const links = await db.select().from(issueApprovals);
    expect(links.filter(link => link.approvalId === approval.id).map(link => link.issueId).sort()).toEqual(tasks.map(task => task.id).sort());
  });
  it("restarts gate acquisition for a link committed while the initial issue lock waits", async () => {
    const [company] = await db.insert(companies).values({ name: "Late approval link", issuePrefix: "APL" }).returning();
    const [approval] = await db.insert(approvals).values({ companyId: company.id, type: "hire_agent", status: "pending", payload: {} }).returning();
    const tasks = await db.insert(issues).values([
      { companyId: company.id, title: "Initially linked" },
      { companyId: company.id, title: "Linked during lock wait" },
    ]).returning();
    await issueApprovalService(db).link(tasks[0].id, approval.id);
    let readyA!: () => void, releaseA!: () => void, readyB!: () => void, releaseB!: () => void;
    const heldA = new Promise<void>(resolve => { readyA = resolve; });
    const proceedA = new Promise<void>(resolve => { releaseA = resolve; });
    const heldB = new Promise<void>(resolve => { readyB = resolve; });
    const proceedB = new Promise<void>(resolve => { releaseB = resolve; });
    const holdingA = db.transaction(async tx => {
      await lockIssuesForGateWrite(tx, company.id, [tasks[0].id]); readyA(); await proceedA;
    });
    await heldA;
    let entered = false;
    const updating = writeApprovalChange(db, company.id, async tx => {
      entered = true;
      return tx.update(approvals).set({ status: "cancelled" }).where(eq(approvals.id, approval.id));
    }, { approvalId: approval.id });
    let holdingB: Promise<unknown> | undefined;
    const waitingForIssue = async () => {
      const rows = await db.execute(sql`select 1 from pg_stat_activity where datname = current_database()
        and pid <> pg_backend_pid() and wait_event_type = 'Lock' and query like '%"issues"%'`);
      return rows.length > 0;
    };
    try {
      await expect.poll(waitingForIssue).toBe(true);
      await issueApprovalService(db).link(tasks[1].id, approval.id);
      holdingB = db.transaction(async tx => {
        await lockIssuesForGateWrite(tx, company.id, [tasks[1].id]); readyB(); await proceedB;
      });
      await heldB;
      releaseA(); await holdingA;
      await expect.poll(waitingForIssue).toBe(true);
      expect(entered).toBe(false);
      releaseB();
      await Promise.all([holdingB, updating]);
      expect(entered).toBe(true);
    } finally {
      releaseA(); releaseB(); await Promise.allSettled([holdingA, holdingB, updating]);
    }
  });

});
