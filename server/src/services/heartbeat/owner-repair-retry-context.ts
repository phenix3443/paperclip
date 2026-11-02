import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueRecoveryActions, issues } from "@paperclipai/db";
import { isNativeReworkHandback } from "../../modules/run-dispatch/index.js";
import { parseObject } from "../../adapters/utils.js";
import { REWORK_HANDBACK_CONTINUATION_SOURCE } from "../recovery/rework-handback-continuation.js";

const OWNER_REPAIR_SOURCE = "issue.deliberate_wait_disposition_repair";
const OWNER_REPAIR_CAUSE = "deliberate_wait_without_target";
const OWNER_REPAIR_WAKE_POLICY = "bounded_owner_disposition_repair";

const OWNER_REPAIR_ONLY_CONTEXT_KEYS = [
  "recoveryActionId",
  "recoveryCause",
  "dispositionRepairInstruction",
  "dispositionRepairAttempt",
  "dispositionRepairMaxAttempts",
  "dispositionRepairFingerprint",
  "dispositionRepairSourceRunId",
  "legacyDispositionEpisode",
  "bypassContinuationSummaryPark",
] as const;

type RetrySourceRun = {
  companyId: string;
  agentId: string;
  issueId: string | null;
};

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

async function loadIssue(db: Db, run: RetrySourceRun) {
  if (!run.issueId) return null;
  return db
    .select({
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeUserId: issues.assigneeUserId,
      executionState: issues.executionState,
    })
    .from(issues)
    .where(and(eq(issues.id, run.issueId), eq(issues.companyId, run.companyId)))
    .then((rows) => rows[0] ?? null);
}

async function ownerRepairContextIsInvalid(
  db: Db,
  run: RetrySourceRun,
  context: Record<string, unknown>,
): Promise<boolean> {
  if (!run.issueId) return false;
  const recoveryActionId = readString(context.recoveryActionId);
  if (recoveryActionId) {
    const action = await db
      .select({
        companyId: issueRecoveryActions.companyId,
        sourceIssueId: issueRecoveryActions.sourceIssueId,
        cause: issueRecoveryActions.cause,
        wakePolicy: issueRecoveryActions.wakePolicy,
        ownerAgentId: issueRecoveryActions.ownerAgentId,
        returnOwnerAgentId: issueRecoveryActions.returnOwnerAgentId,
        status: issueRecoveryActions.status,
      })
      .from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, recoveryActionId))
      .then((rows) => rows[0] ?? null);
    if (!action) return false;
    if (action.companyId !== run.companyId || action.sourceIssueId !== run.issueId) return false;
    if (action.cause !== OWNER_REPAIR_CAUSE) return false;
    if (parseObject(action.wakePolicy).type !== OWNER_REPAIR_WAKE_POLICY) return false;
    if (action.ownerAgentId !== run.agentId || action.returnOwnerAgentId !== run.agentId) return false;
    if (action.status !== "active" && action.status !== "escalated") return true;
    return isNativeReworkHandback(await loadIssue(db, run), run.agentId);
  }

  if (readString(context.recoveryCause) !== OWNER_REPAIR_CAUSE) return false;
  if (readString(context.source) !== OWNER_REPAIR_SOURCE) return false;
  if (!readString(context.dispositionRepairFingerprint)) return false;
  if (context.legacyDispositionEpisode != null) return false;
  const contextIssueId = readString(context.issueId);
  if (contextIssueId && contextIssueId !== run.issueId) return false;
  return isNativeReworkHandback(await loadIssue(db, run), run.agentId);
}

/**
 * A retry of an owner disposition repair keeps the repair context only while
 * that repair is still valid. Once its action is settled, or the issue is a
 * native rework hand-back to the same agent, the retry is ordinary work.
 */
export async function selectOwnerRepairRetryContext(
  db: Db,
  run: RetrySourceRun,
  context: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!readString(context.recoveryActionId) && !readString(context.recoveryCause)) return context;
  if (!(await ownerRepairContextIsInvalid(db, run, context))) return context;
  const next: Record<string, unknown> = { ...context };
  for (const key of OWNER_REPAIR_ONLY_CONTEXT_KEYS) delete next[key];
  next.source = REWORK_HANDBACK_CONTINUATION_SOURCE;
  return next;
}
