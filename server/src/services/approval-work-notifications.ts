import { lockIssuesForGateWrite } from "./execution-reconciliation-locks.js";
import { and, eq } from "drizzle-orm";
import { approvals, issueApprovals, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";
import { notifyIssueReviewState } from "./issue-review-state-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export const notifyApprovalQueueWork = (transaction: object, companyId: string) => notifyDeliveryWork(transaction, DELIVERY_QUEUES.approvalQueueSeeding, companyId);

type ApprovalChangeScope = { approvalId?: string; issueIds?: string[] };
class ApprovalLinksChanged extends Error {}

export async function notifyApprovalWork(transaction: object, companyId: string, scope?: ApprovalChangeScope) {
  const notify = async (tx: object, issueIds: Set<string>) => {
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.approvalRetention);
    await notifyApprovalQueueWork(tx, companyId);
    for (const issueId of issueIds) await notifyIssueReviewState(tx, { companyId, issueId });
  };
  if (!scope?.approvalId) {
    const issueIds = new Set(scope?.issueIds);
    await lockIssuesForGateWrite(transaction as Db, companyId, [...issueIds]);
    await notify(transaction, issueIds);
    return;
  }
  const approvalId = scope.approvalId;
  const links = (tx: Db) => tx.select({ issueId: issueApprovals.issueId }).from(issueApprovals)
    .where(and(eq(issueApprovals.companyId, companyId), eq(issueApprovals.approvalId, approvalId)));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await (transaction as Db).transaction(async tx => {
        const issueIds = new Set([...(scope.issueIds ?? []), ...(await links(tx as unknown as Db)).map(link => link.issueId)]);
        await lockIssuesForGateWrite(tx, companyId, [...issueIds]);
        await tx.select({ id: approvals.id }).from(approvals)
          .where(and(eq(approvals.companyId, companyId), eq(approvals.id, approvalId))).for("update");
        const current = await links(tx as unknown as Db);
        if (current.some(link => !issueIds.has(link.issueId))) throw new ApprovalLinksChanged();
        await notify(tx, issueIds);
      });
      return;
    } catch (error) {
      if (!(error instanceof ApprovalLinksChanged)) throw error;
      if (attempt === 2) throw conflict("Approval links changed during the update; retry the request");
    }
  }
}

export function writeApprovalChange<T>(db: Db, companyId: string, write: (transaction: Db) => Promise<T>, scope?: ApprovalChangeScope): Promise<T> {
  return db.transaction(async tx => {
    await notifyApprovalWork(tx, companyId, scope);
    return write(tx as unknown as Db);
  });
}
