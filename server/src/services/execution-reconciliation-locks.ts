import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { agents, issueApprovals, issues, type Db } from "@paperclipai/db";

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

export async function lockIssuesForGateWrite(tx: DbOrTransaction, companyId: string, issueIds: string[]) {
  const ids = Array.from(new Set(issueIds)).sort();
  if (ids.length === 0) return;
  await tx.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.id, ids)))
    .orderBy(asc(issues.id))
    .for("update");
}

export async function lockIssuesLinkedToApproval(tx: DbOrTransaction, companyId: string, approvalId: string) {
  const linked = await tx.select({ issueId: issueApprovals.issueId }).from(issueApprovals)
    .where(and(eq(issueApprovals.companyId, companyId), eq(issueApprovals.approvalId, approvalId)));
  await lockIssuesForGateWrite(tx, companyId, linked.map((row) => row.issueId));
}
