import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { companies, createDb, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { withAccountingTransaction } from "../services/accounting-transaction.js";

const publication = vi.hoisted(() => vi.fn());
vi.mock("../services/activity-log.js", () => ({ publishActivity: publication }));

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("accounting commit ownership", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let fixtureNumber = 0;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("accounting-commit-");
    db = createDb(database.connectionString);
  }, 90_000);
  beforeEach(() => publication.mockReset());
  afterAll(async () => { await database?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Before", issuePrefix: `ACOM${++fixtureNumber}` });
    return companyId;
  }

  it.each([true, false])("publishes only after an outer commit (commit=%s)", async commit => {
    const companyId = await fixture();
    const work = db.transaction(async outer => {
      const result = await withAccountingTransaction(outer as unknown as Db, companyId, async (tx, publications) => {
        await tx.update(companies).set({ name: "After" }).where(eq(companies.id, companyId));
        publications.push({ companyId, payload: { action: "changed" }, pluginEvent: null });
        return 42;
      });
      expect(result).toBe(42);
      expect(publication).not.toHaveBeenCalled();
      const [outside] = await db.select().from(companies).where(eq(companies.id, companyId));
      expect(outside.name).toBe("Before");
      if (!commit) throw new Error("rollback outer");
    });
    if (commit) await work;
    else await expect(work).rejects.toThrow("rollback outer");
    expect(publication).toHaveBeenCalledTimes(commit ? 1 : 0);
    const [persisted] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(persisted.name).toBe(commit ? "After" : "Before");
  });

  it("discards a rolled-back accounting savepoint and publishes a later successful mutation", async () => {
    const companyId = await fixture();
    await db.transaction(async outer => {
      await expect(withAccountingTransaction(outer as unknown as Db, companyId, async (_tx, publications) => {
        publications.push({ companyId, payload: { action: "discarded" }, pluginEvent: null });
        throw new Error("rollback accounting");
      })).rejects.toThrow("rollback accounting");
      await withAccountingTransaction(outer as unknown as Db, companyId, async (_tx, publications) => {
        publications.push({ companyId, payload: { action: "kept" }, pluginEvent: null });
      });
      expect(publication).not.toHaveBeenCalled();
    });
    expect(publication.mock.calls.map(([value]) => value.payload.action)).toEqual(["kept"]);
  });
});
