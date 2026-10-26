import { ISSUE_DISPOSITION_REPAIR_RETRY_REASON } from "@paperclipai/shared";
import { parseObject } from "../../adapters/utils.js";

/**
 * Settlement of a completed bounded owner repair and admission of its single
 * business continuation.
 *
 * The settlement record lives on the recovery action
 * (`evidence.ownerRepairSettlement`) and is the outbox: it is written under the
 * issue lock with a pre-generated wakeup request id. The queue later inserts
 * the receipt row with exactly that id and the key below. The unique index
 * `agent_wakeup_requests_owner_repair_continuation_uq` keeps one receipt per
 * key, including terminal receipts, so a consumed slot is never reopened.
 */
export const OWNER_REPAIR_SETTLEMENT_SCHEMA = "paperclip.owner-repair-settlement.v1";
export const OWNER_REPAIR_CONTINUATION_REASON = "owner_repair_continuation";

export type OwnerRepairSettlementState =
  /** Receipt id reserved; the queue has not accepted it yet. */
  | "pending_dispatch"
  /** The queue accepted the receipt; its run (if any) is the only successor. */
  | "delivered"
  /** A terminal decision (owner change, terminal task) consumed the slot. */
  | "denied";

export type OwnerRepairSettlement = {
  schema: typeof OWNER_REPAIR_SETTLEMENT_SCHEMA;
  state: OwnerRepairSettlementState;
  continuationKey: string;
  wakeupRequestId: string;
  repairRunId: string;
  ownerAgentId: string;
  actionFingerprint: string;
  expectedIssueStatusVersion: number;
  /** Issue binding observed under the settlement lock; admission re-checks it. */
  issueBinding: OwnerRepairIssueBinding;
  terminalEvidence: { runStatus: string; finishedAt: string; durableSettlementEventSeq: number };
  completedWorkProductIds: string[];
  /** Repository/PR/commit evidence of work already done; never a replay grant. */
  completedWorkProducts?: OwnerRepairCompletedWorkProduct[];
  settledAt: string;
  deliveredAt?: string | null;
  deliveredRunId?: string | null;
  deniedReason?: string | null;
  /** Latest temporary refusal; it never consumes the reserved receipt. */
  lastWait?: { reason: string; at: string } | null;
  /** Version moves accepted after a recorded wait resolved; the audit trail of each rebind. */
  rebinds?: OwnerRepairRebind[];
};

export type OwnerRepairRebind = {
  fromStatusVersion: number;
  toStatusVersion: number;
  fromStatusDecisionId: string | null;
  toStatusDecisionId: string | null;
  waitReason: string;
  at: string;
};

/**
 * A reserved continuation may follow the issue to a new version only after a
 * recorded wait: the same owner still holds an open task, and the responsible
 * human, workspace binding and execution stage are unchanged.
 */
export function ownerRepairRebindAllowed(
  settlement: OwnerRepairSettlement,
  issue: { assigneeAgentId: string | null; status: string; statusVersion: number } & Parameters<typeof ownerRepairIssueBinding>[0],
) {
  if (!settlement.lastWait || issue.statusVersion === settlement.expectedIssueStatusVersion) return false;
  if (issue.assigneeAgentId !== settlement.ownerAgentId || !["todo", "in_progress"].includes(issue.status)) return false;
  const current = ownerRepairIssueBinding(issue);
  const bound = settlement.issueBinding;
  return current.responsibleUserId === bound.responsibleUserId
    && current.workspaceBindingRevision === bound.workspaceBindingRevision
    && current.executionStageId === bound.executionStageId;
}

/** Queue admission request for one reserved owner-repair continuation. */
export type OwnerRepairContinuationRequest = {
  actionId: string;
  repairRunId: string;
  issueId: string;
  wakeupRequestId: string;
  continuationKey: string;
  expectedIssueStatusVersion: number;
  requestedAt: Date;
};

export type OwnerRepairCompletedWorkProduct = {
  id: string;
  type: string;
  provider: string;
  externalId: string | null;
  url: string | null;
  status: string;
  createdByRunId: string | null;
};

export const OWNER_REPAIR_CONTINUATION_REMAINING_SCOPE =
  "Continue the remaining work of this task. The completed work products listed here are already done; " +
  "do not repeat their pushes, merges, or publications.";

/**
 * Recovery-action fingerprints that record an unknown outcome for a run
 * (workspace restore or execution reconciliation still owed).
 */
export function unknownEffectRecoveryFingerprints(runId: string) {
  return [`legacy-execution:${runId}`, `native-workspace:${runId}`];
}

export type OwnerRepairIssueBinding = {
  responsibleUserId: string | null;
  lastStatusDecisionId: string | null;
  workspaceBindingRevision: number;
  executionStageId: string | null;
};

export function ownerRepairIssueBinding(issue: {
  responsibleUserId: string | null;
  lastStatusDecisionId: string | null;
  workspaceBindingRevision: number;
  executionState: unknown;
}): OwnerRepairIssueBinding {
  const stageId = parseObject(issue.executionState).currentStageId;
  return {
    responsibleUserId: issue.responsibleUserId,
    lastStatusDecisionId: issue.lastStatusDecisionId,
    workspaceBindingRevision: issue.workspaceBindingRevision,
    executionStageId: typeof stageId === "string" && stageId ? stageId : null,
  };
}

export function sameOwnerRepairIssueBinding(left: OwnerRepairIssueBinding, right: OwnerRepairIssueBinding) {
  return left.responsibleUserId === right.responsibleUserId
    && left.lastStatusDecisionId === right.lastStatusDecisionId
    && left.workspaceBindingRevision === right.workspaceBindingRevision
    && left.executionStageId === right.executionStageId;
}

export function ownerRepairContinuationKey(input: {
  issueId: string;
  actionId: string;
  repairRunId: string;
}) {
  return `owner-repair-continuation:${input.issueId}:${input.actionId}:${input.repairRunId}:business`;
}

export function readOwnerRepairSettlement(evidence: unknown): OwnerRepairSettlement | null {
  const record = parseObject(parseObject(evidence).ownerRepairSettlement);
  if (record.schema !== OWNER_REPAIR_SETTLEMENT_SCHEMA) return null;
  const state = record.state;
  if (state !== "pending_dispatch" && state !== "delivered" && state !== "denied") return null;
  for (const field of ["continuationKey", "wakeupRequestId", "repairRunId", "ownerAgentId", "actionFingerprint", "settledAt"]) {
    if (typeof record[field] !== "string" || !record[field]) return null;
  }
  if (!Number.isSafeInteger(record.expectedIssueStatusVersion)) return null;
  const binding = parseObject(record.issueBinding);
  if (!Number.isSafeInteger(binding.workspaceBindingRevision)) return null;
  return record as unknown as OwnerRepairSettlement;
}

type RepairRunShape = {
  id: string;
  agentId: string;
  companyId: string;
  status: string;
  finishedAt: Date | null;
  contextSnapshot: Record<string, unknown> | null;
};

type RepairActionShape = {
  id: string;
  companyId: string;
  sourceIssueId: string;
  status: string;
  ownerType: string;
  ownerAgentId: string | null;
  returnOwnerAgentId: string | null;
  wakePolicy: unknown;
};

/**
 * Whether `run` is exactly the scheduled repair of `action` and has
 * succeeded. Durable terminal settlement is checked separately against the
 * run's events; success alone is not proof that the executor released it.
 */
export function isCompletedScheduledOwnerRepair(action: RepairActionShape, run: RepairRunShape | null) {
  if (!run) return false;
  const wakePolicy = parseObject(action.wakePolicy);
  const context = parseObject(run.contextSnapshot);
  return action.status === "active"
    && action.ownerType === "agent"
    && wakePolicy.type === "bounded_owner_disposition_repair"
    && wakePolicy.scheduledRunId === run.id
    && run.companyId === action.companyId
    && context.recoveryActionId === action.id
    && (context.issueId ?? context.taskId) === action.sourceIssueId
    && context.retryReason === ISSUE_DISPOSITION_REPAIR_RETRY_REASON
    && Boolean(action.ownerAgentId)
    && action.ownerAgentId === action.returnOwnerAgentId
    && run.agentId === action.ownerAgentId
    && run.status === "succeeded"
    && run.finishedAt !== null;
}
