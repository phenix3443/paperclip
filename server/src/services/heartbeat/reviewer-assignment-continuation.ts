import { and, eq, inArray, isNull, not, sql } from "drizzle-orm";
import { agentWakeupRequests, companies, type Db } from "@paperclipai/db";
import { ordinaryWakeRequestPredicate } from "../../modules/wake-queue/receipt-namespace.js";

export async function lockReviewerIntentCompany(tx: Db, companyId: string) {
  const [company] = await tx.select({ status: companies.status }).from(companies)
    .where(eq(companies.id, companyId)).for("share");
  return company?.status ?? null;
}

type RetirementScope = { companyId: string; reason: string } & (
  | { issueId: string; agentIds?: never }
  | { issueId?: never; agentIds: string[] }
  | { issueId?: never; agentIds?: never }
);

export async function retireReviewerIntents(tx: Db, scope: RetirementScope) {
  if (scope.agentIds?.length === 0) return [];
  const now = new Date();
  return tx.update(agentWakeupRequests).set({
    status: "cancelled", error: scope.reason, finishedAt: now, updatedAt: now,
  }).where(and(
    eq(agentWakeupRequests.companyId, scope.companyId),
    not(ordinaryWakeRequestPredicate()),
    inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "claimed"]),
    isNull(agentWakeupRequests.runId),
    scope.issueId ? sql`${agentWakeupRequests.payload}->>'issueId' = ${scope.issueId}` : undefined,
    scope.agentIds ? inArray(agentWakeupRequests.agentId, scope.agentIds) : undefined,
  )).returning({ id: agentWakeupRequests.id });
}
