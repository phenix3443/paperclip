import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { ordinaryWakeRequestPredicate } from "../../modules/wake-queue/receipt-namespace.js";
import { parseIssueExecutionState } from "../issue-execution-policy.js";
import type { WakeupOptions } from "./run-preparation.js";

const SKIP_REASON = "execution_reconciliation_required";
const WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const LIVE_WAKE_STATUSES = ["queued", "claimed", "deferred_issue_execution"];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * The wake that an executor's release should hand on, if any.
 *
 * An assignment wake that arrives while the previous executor of the same task
 * still holds its environment lease is recorded as skipped. The usual case is a
 * review handoff: the author's own run moves the task to review, the handoff
 * cancels that run, and the reviewer's wake is checked before the cancelled
 * run releases its lease. This selects the newest such skipped wake for the
 * task's current assignee, so the release event can deliver it once. It
 * returns null when the wake is stale (other assignee, other review stage or
 * participant, closed task) or when the assignee already has a newer run or a
 * live wake for the task.
 */
export async function selectReleasedExecutionWake(
  db: Db,
  input: { companyId: string; issueId: string; releasedRunId: string },
): Promise<{ agentId: string; opts: WakeupOptions } | null> {
  // Wake admission locks the task row before it checks the executor and records
  // a skip. Taking the same lock here orders this read after any such skip.
  return db.transaction(async (transaction) => select(transaction as unknown as Db, input));
}

async function select(
  db: Db,
  input: { companyId: string; issueId: string; releasedRunId: string },
): Promise<{ agentId: string; opts: WakeupOptions } | null> {
  const [issue] = await db.select().from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
  if (!issue?.assigneeAgentId || issue.assigneeUserId || ["done", "cancelled"].includes(issue.status)) return null;
  const agentId = issue.assigneeAgentId;

  const [skipped] = await db.select().from(agentWakeupRequests).where(and(
    ordinaryWakeRequestPredicate(),
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.agentId, agentId),
    eq(agentWakeupRequests.status, "skipped"),
    eq(agentWakeupRequests.reason, SKIP_REASON),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
  )).orderBy(desc(agentWakeupRequests.createdAt), desc(agentWakeupRequests.id)).limit(1);
  if (!skipped) return null;

  const payload = record(skipped.payload) ?? {};
  const context = record(payload[WAKE_CONTEXT_KEY]);
  const stage = record(payload.executionStage);
  if (stage) {
    const state = parseIssueExecutionState(issue.executionState);
    const participant = state?.currentParticipant;
    if (state?.status !== "pending" || state.currentStageId !== stage.stageId ||
        participant?.type !== "agent" || participant.agentId !== agentId) return null;
  }

  const [newerRun] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, agentId),
    or(eq(heartbeatRuns.issueId, issue.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`),
    gte(heartbeatRuns.createdAt, skipped.createdAt),
  )).limit(1);
  if (newerRun) return null;
  const [liveWake] = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.agentId, agentId),
    inArray(agentWakeupRequests.status, LIVE_WAKE_STATUSES),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
  )).limit(1);
  if (liveWake) return null;

  const { executionWait: _wait, [WAKE_CONTEXT_KEY]: _context, ...originalPayload } = payload;
  const contextSnapshot = context ? (({ wakeSource: _s, wakeTriggerDetail: _t, taskKey: _k, ...rest }) => rest)(context) : undefined;
  return {
    agentId,
    opts: {
      source: skipped.source as WakeupOptions["source"],
      triggerDetail: (skipped.triggerDetail ?? undefined) as WakeupOptions["triggerDetail"],
      reason: typeof context?.wakeReason === "string" ? context.wakeReason : null,
      payload: originalPayload,
      ...(contextSnapshot ? { contextSnapshot } : {}),
      requestedByActorType: (skipped.requestedByActorType ?? undefined) as WakeupOptions["requestedByActorType"],
      requestedByActorId: skipped.requestedByActorId,
      // One delivery per skipped wake per release, even if the release is recorded twice.
      idempotencyKey: `execution-release:${input.releasedRunId}:${skipped.id}`,
    },
  };
}
