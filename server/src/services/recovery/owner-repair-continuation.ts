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
export const OWNER_REPAIR_CONTINUATION_INDEX = "agent_wakeup_requests_owner_repair_continuation_uq";

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
  terminalEvidence: { runStatus: string; finishedAt: string; durableSettlementEventSeq: number };
  completedWorkProductIds: string[];
  settledAt: string;
  deliveredAt?: string | null;
  deliveredRunId?: string | null;
  deniedReason?: string | null;
};

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
    && context.retryReason === "issue_disposition_repair"
    && Boolean(action.ownerAgentId)
    && action.ownerAgentId === action.returnOwnerAgentId
    && run.agentId === action.ownerAgentId
    && run.status === "succeeded"
    && run.finishedAt !== null;
}
