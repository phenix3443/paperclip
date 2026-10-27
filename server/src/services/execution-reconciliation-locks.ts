import { and, eq, sql } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";

type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export function issueTreeHoldLockKey(companyId: string) {
  return `issue-tree-hold:${companyId}`;
}

export async function lockIssueTreeHolds(
  tx: DbOrTransaction,
  companyId: string,
  mode: "shared" | "exclusive",
) {
  const key = issueTreeHoldLockKey(companyId);
  await tx.execute(mode === "shared"
    ? sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`
    : sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export async function lockAdmissionOwnerAndTreeHolds(
  tx: DbOrTransaction,
  companyId: string,
  ownerAgentId: string | null,
) {
  if (ownerAgentId) {
    await tx.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.companyId, companyId), eq(agents.id, ownerAgentId)))
      .for("share");
  }
  await lockIssueTreeHolds(tx, companyId, "shared");
}
