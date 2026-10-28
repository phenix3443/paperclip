import { and, eq, inArray, sql } from "drizzle-orm";
import { issueApprovals, issueRecoveryActions, type Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function releaseWaitingReconciledDeliveries(
  tx: DbOrTransaction,
  input: { companyId: string; gates: readonly string[]; issueIds?: readonly string[] },
) {
  if (input.gates.length === 0 || input.issueIds?.length === 0) return 0;
  const released = await tx
    .update(issueRecoveryActions)
    .set({
      evidence: sql`jsonb_set(${issueRecoveryActions.evidence}, '{continuationWait,recheckAt}', to_jsonb(${new Date().toISOString()}::text))`,
    })
    .where(and(
      eq(issueRecoveryActions.companyId, input.companyId),
      eq(issueRecoveryActions.status, "resolved"),
      sql`${issueRecoveryActions.evidence}->>'continuationDelivery' = 'waiting'`,
      inArray(sql<string>`${issueRecoveryActions.evidence}#>>'{continuationWait,gate}'`, [...input.gates]),
      input.issueIds ? inArray(issueRecoveryActions.sourceIssueId, [...input.issueIds]) : undefined,
    ))
    .returning({ id: issueRecoveryActions.id });
  if (released.length > 0) await notifyDeliveryWork(tx, DELIVERY_QUEUES.executionContinuation);
  return released.length;
}

export async function releaseWaitingReconciledDeliveriesForApproval(
  tx: DbOrTransaction,
  input: { companyId: string; approvalId: string },
) {
  const linked = await tx.select({ issueId: issueApprovals.issueId }).from(issueApprovals).where(and(
    eq(issueApprovals.companyId, input.companyId), eq(issueApprovals.approvalId, input.approvalId),
  ));
  return releaseWaitingReconciledDeliveries(tx, {
    companyId: input.companyId, gates: ["approval"], issueIds: linked.map((row) => row.issueId),
  });
}
