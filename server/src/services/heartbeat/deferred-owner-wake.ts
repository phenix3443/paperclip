import { and, asc, eq, gte, or, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { ordinaryWakeRequestPredicate } from "../../modules/wake-queue/receipt-namespace.js";
import { parseIssueExecutionState } from "../issue-execution-policy.js";
import { isHeartbeatRunTerminalStatus } from "./run-lifecycle.js";
import type { WakeupOptions } from "./run-preparation.js";

const DEFERRED_STATUS = "deferred_issue_execution";
const INVOKABLE_AGENT_STATUSES = new Set(["idle", "running", "active"]);
const WAKE_CONTEXT_KEY = "_paperclipWakeContext";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export type DeferredOwnerWake = { agentId: string; deferredWakeId: string; opts: WakeupOptions };

/**
 * The deferred wake of the task's current owner that a blocking run's end should hand on, if any.
 *
 * A wake for another agent waits as `deferred_issue_execution` while a run holds the task. When
 * that run is a reassigned owner's run and it ends by an operator stop, an acknowledged
 * reassignment stop or a stale-dispatch cancel, the release drain does not promote other agents'
 * wakes, so the new owner's wake waits forever. This selects the oldest such wake for the current
 * assignee, so the end event can admit it once. It returns null while another live run still holds
 * the task, for a stale wake (closed task, other assignee, or a newer run of the assignee on the
 * task) and for a paused or otherwise not invokable assignee.
 *
 * Two kinds of deferred wake stay with their own paths. The ended run's own agent keeps its
 * queued input after a Stop until the next explicit wake adopts it. A review-stage wake follows
 * the review continuation and its parked-request rules.
 */
export async function selectDeferredOwnerWake(
  db: Db,
  input: { companyId: string; issueId: string; endedRunId: string },
): Promise<DeferredOwnerWake | null> {
  // Wake admission locks the task row before it defers a wake. The same lock orders this read after it.
  return db.transaction(async (transaction) => select(transaction as unknown as Db, input));
}

async function select(
  db: Db,
  input: { companyId: string; issueId: string; endedRunId: string },
): Promise<DeferredOwnerWake | null> {
  const [issue] = await db.select().from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
  if (!issue || ["done", "cancelled"].includes(issue.status)) return null;

  if (issue.executionRunId && issue.executionRunId !== input.endedRunId) {
    const [holder] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, issue.executionRunId));
    // A live run still owns the task; its own release drains the queue.
    if (holder && !isHeartbeatRunTerminalStatus(holder.status)) return null;
  }

  const agentId = issue.assigneeUserId ? null : issue.assigneeAgentId;
  if (!agentId) return null;
  const [ended] = await db.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, input.endedRunId));
  if (!ended || ended.agentId === agentId) return null;
  const [owner] = await db.select({ status: agents.status }).from(agents)
    .where(and(eq(agents.companyId, input.companyId), eq(agents.id, agentId)));
  if (!owner || !INVOKABLE_AGENT_STATUSES.has(owner.status)) return null;

  const [deferred] = await db.select().from(agentWakeupRequests).where(and(
    ordinaryWakeRequestPredicate(),
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.agentId, agentId),
    eq(agentWakeupRequests.status, DEFERRED_STATUS),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
  )).orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.id)).limit(1);
  if (!deferred) return null;

  const payload = record(deferred.payload) ?? {};
  const context = record(payload[WAKE_CONTEXT_KEY]);
  if (record(payload.executionStage) || parseIssueExecutionState(issue.executionState)?.status === "pending") return null;

  const [newerRun] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId),
    eq(heartbeatRuns.agentId, agentId),
    or(eq(heartbeatRuns.issueId, issue.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`),
    gte(heartbeatRuns.createdAt, deferred.createdAt),
  )).limit(1);
  if (newerRun) return null;

  const { executionWait: _wait, [WAKE_CONTEXT_KEY]: _context, ...originalPayload } = payload;
  const contextSnapshot = context ? (({ wakeSource: _s, wakeTriggerDetail: _t, taskKey: _k, ...rest }) => rest)(context) : undefined;
  return {
    agentId,
    deferredWakeId: deferred.id,
    opts: {
      source: deferred.source as WakeupOptions["source"],
      triggerDetail: (deferred.triggerDetail ?? undefined) as WakeupOptions["triggerDetail"],
      reason: typeof context?.wakeReason === "string" ? context.wakeReason : null,
      payload: originalPayload,
      ...(contextSnapshot ? { contextSnapshot } : {}),
      requestedByActorType: (deferred.requestedByActorType ?? undefined) as WakeupOptions["requestedByActorType"],
      requestedByActorId: deferred.requestedByActorId,
      // One admission per deferred wake per ended run, even if the end is recorded twice.
      idempotencyKey: `deferred-owner-release:${input.endedRunId}:${deferred.id}`,
    },
  };
}

/** Retires the deferred row once its wake was admitted again, so no later drain promotes it a second time. */
export async function retireReadmittedDeferredWake(db: Db, input: { companyId: string; deferredWakeId: string }) {
  await db.update(agentWakeupRequests).set({
    status: "cancelled",
    error: "Admitted again after the run that held the task ended",
    finishedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    ordinaryWakeRequestPredicate(),
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.id, input.deferredWakeId),
    eq(agentWakeupRequests.status, DEFERRED_STATUS),
  ));
}

/**
 * Admits the current owner's deferred wake once, when a run that held the task has ended.
 * The deferred row is retired only after admission returns a wake, so a refused admission keeps it queued.
 */
export async function admitDeferredOwnerWake(
  db: Db,
  enqueueWakeup: (agentId: string, opts: WakeupOptions) => Promise<unknown>,
  input: { companyId: string; issueId: string; endedRunId: string },
) {
  const wake = await selectDeferredOwnerWake(db, input);
  if (!wake) return;
  const admitted = await enqueueWakeup(wake.agentId, wake.opts);
  if (admitted) await retireReadmittedDeferredWake(db, { companyId: input.companyId, deferredWakeId: wake.deferredWakeId });
}
