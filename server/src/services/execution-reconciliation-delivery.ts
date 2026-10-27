import { and, asc, eq, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companies,
  executionReconciliationReceipts,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
} from "@paperclipai/db";
import type { ExpectedReconciliationState } from "@paperclipai/shared";
import { isConversation } from "./agent-conversations.js";
import { admitExecutionReconciliationGates, lockAdmissionRows } from "./execution-reconciliation-admission.js";
import { lockAdmissionOwnerAndTreeHolds } from "./execution-reconciliation-locks.js";
import { toExecutionReconciliationRefusal } from "./execution-reconciliation-receipts.js";

type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export type ReconciledDeliveryDecision =
  | { kind: "deliver" }
  | { kind: "waiting"; gate: string }
  | { kind: "invalidated"; reason: string };

const MAX_RECHECK_DELAY_MS = 60 * 60 * 1000;
const BASE_RECHECK_DELAY_MS = 5 * 60 * 1000;

export function isAdmittedReconciliation(decision: Record<string, unknown>) {
  return typeof decision.authorizationPayloadDigest === "string";
}

export async function lockReconciledDeliveryPrefix(tx: DbOrTransaction, companyId: string, ownerAgentId: string) {
  await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId)).for("share");
  await lockAdmissionOwnerAndTreeHolds(tx, companyId, ownerAgentId);
}

export async function revalidateReconciledDelivery(
  tx: DbOrTransaction,
  input: { issue: typeof issues.$inferSelect; action: typeof issueRecoveryActions.$inferSelect },
): Promise<ReconciledDeliveryDecision> {
  const { issue, action } = input;
  const [receipt] = await tx
    .select()
    .from(executionReconciliationReceipts)
    .where(and(
      eq(executionReconciliationReceipts.companyId, issue.companyId),
      eq(executionReconciliationReceipts.actionId, action.id),
      eq(executionReconciliationReceipts.state, "committed"),
    ));
  if (!receipt || receipt.issueId !== issue.id || !receipt.runId) return { kind: "invalidated", reason: "receipt_missing" };
  if (["done", "cancelled"].includes(issue.status)) return { kind: "invalidated", reason: "issue_closed" };
  if (issue.executionState != null) return { kind: "invalidated", reason: "stage_changed" };
  if (!issue.assigneeAgentId || issue.assigneeAgentId !== action.returnOwnerAgentId) {
    return { kind: "invalidated", reason: "owner_mismatch" };
  }
  if (isConversation(issue)) return { kind: "invalidated", reason: "issue_kind_not_supported" };

  const locked = await lockAdmissionRows(tx, { companyId: issue.companyId, issueId: issue.id, runId: receipt.runId });
  if (!locked.run) return { kind: "invalidated", reason: "source_run_missing" };
  if (locked.activeMemberRuns.length > 0) return { kind: "invalidated", reason: "newer_run" };
  const baseline = receipt.createdAt.toISOString();
  const [newer] = await tx
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, issue.companyId),
      ne(heartbeatRuns.id, receipt.runId),
      or(
        eq(heartbeatRuns.issueId, issue.id),
        eq(heartbeatRuns.nativeIssueId, issue.id),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.id}`,
        sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${issue.id}`,
        eq(heartbeatRuns.retryOfRunId, receipt.runId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'previousRunId' = ${receipt.runId}`,
      ),
      or(
        sql`${heartbeatRuns.createdAt} >= ${baseline}::timestamptz`,
        sql`${heartbeatRuns.finishedAt} > ${baseline}::timestamptz`,
      ),
    ))
    .orderBy(asc(heartbeatRuns.id))
    .limit(1);
  if (newer) return { kind: "invalidated", reason: "newer_run" };
  if (locked.wakes.length > 0) return { kind: "waiting", gate: "pending_wake" };

  try {
    await admitExecutionReconciliationGates(tx, {
      issue,
      action,
      locked,
      expected: receipt.expectedSnapshot as unknown as ExpectedReconciliationState,
    });
  } catch (error) {
    const refusal = toExecutionReconciliationRefusal(error);
    if (!refusal?.code.startsWith("gate_closed:")) throw error;
    const gate = refusal.code.slice("gate_closed:".length);
    if (gate === "owner") return { kind: "invalidated", reason: "owner_mismatch" };
    return { kind: "waiting", gate };
  }
  return { kind: "deliver" };
}

export async function recordReconciledDeliveryOutcome(
  tx: DbOrTransaction,
  action: typeof issueRecoveryActions.$inferSelect,
  decision: Exclude<ReconciledDeliveryDecision, { kind: "deliver" }>,
) {
  const now = new Date();
  const evidence = decision.kind === "waiting"
    ? (() => {
      const previous = action.evidence.continuationWait as { since?: string; attempts?: number } | undefined;
      const attempts = typeof previous?.attempts === "number" ? previous.attempts : 0;
      const delay = Math.min(BASE_RECHECK_DELAY_MS * 2 ** attempts, MAX_RECHECK_DELAY_MS);
      return {
        continuationDelivery: "waiting",
        continuationWait: {
          gate: decision.gate,
          since: previous?.since ?? now.toISOString(),
          recheckAt: new Date(now.getTime() + delay).toISOString(),
          attempts: attempts + 1,
        },
      };
    })()
    : { continuationDelivery: "invalidated", continuationInvalidatedReason: decision.reason };
  await tx
    .update(issueRecoveryActions)
    .set({ evidence: sql`${issueRecoveryActions.evidence} || ${JSON.stringify(evidence)}::jsonb` })
    .where(and(eq(issueRecoveryActions.companyId, action.companyId), eq(issueRecoveryActions.id, action.id)));
}

export async function isGuardedReconciliationDelivery(
  db: DbOrTransaction,
  companyId: string,
  issueId: string,
  recoveryActionId: unknown,
) {
  if (typeof recoveryActionId !== "string") return false;
  const [action] = await db
    .select({ evidence: issueRecoveryActions.evidence })
    .from(issueRecoveryActions)
    .where(and(
      eq(issueRecoveryActions.companyId, companyId),
      eq(issueRecoveryActions.sourceIssueId, issueId),
      eq(issueRecoveryActions.id, recoveryActionId),
    ));
  const decision = action?.evidence.executionReconciliation;
  return Boolean(decision && typeof decision === "object" && isAdmittedReconciliation(decision as Record<string, unknown>));
}
