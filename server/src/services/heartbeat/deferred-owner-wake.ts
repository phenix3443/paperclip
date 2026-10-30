import { and, asc, eq, gte, ne, or, sql } from "drizzle-orm";
import { agentWakeupRequests, agents, heartbeatRuns, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { ordinaryWakeRequestPredicate } from "../../modules/wake-queue/receipt-namespace.js";
import { parseIssueExecutionState } from "../issue-execution-policy.js";
import { isHeartbeatRunTerminalStatus } from "./run-lifecycle.js";
import type { WakeupOptions } from "./run-preparation.js";

const DEFERRED_STATUS = "deferred_issue_execution";
const WAKE_CONTEXT_KEY = "_paperclipWakeContext";
const INVOKABLE_AGENT_STATUSES = new Set(["idle", "running", "active"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export type DeferredOwnerWake = { agentId: string; deferredWakeId: string; opts: WakeupOptions };

/**
 * The deferred wakes of other agents that a blocking run's end should hand on.
 *
 * A wake for another agent waits as `deferred_issue_execution` while a run holds the task. When
 * that run is a reassigned owner's run and it ends by an operator stop, an acknowledged
 * reassignment stop or a stale-dispatch cancel, the release drain does not promote other agents'
 * wakes, so those wakes wait forever. This selects, per agent, the oldest deferred wake that the
 * task still needs, so the end event can admit each once:
 * - an interaction wake (for example a question for the CTO) while its interaction is pending;
 * - an ordinary wake of the current assignee, unless the assignee already has a newer run.
 *
 * Three kinds stay with their own paths. The ended run's own agent keeps its queued input after a
 * Stop until the next explicit wake adopts it. Wakes for the pending review participant and
 * review-stage wakes follow the review continuation and its parked-request rules. Nothing is
 * selected while another live run still holds the task, for a closed task, or for a paused or
 * otherwise not invokable agent.
 */
export async function selectDeferredOwnerWakes(
  db: Db,
  input: { companyId: string; issueId: string; endedRunId: string },
): Promise<DeferredOwnerWake[]> {
  // Wake admission locks the task row before it defers a wake. The same lock orders this read after it.
  return db.transaction(async (transaction) => select(transaction as unknown as Db, input));
}

async function select(
  db: Db,
  input: { companyId: string; issueId: string; endedRunId: string },
): Promise<DeferredOwnerWake[]> {
  const [issue] = await db.select().from(issues)
    .where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
  if (!issue || ["done", "cancelled"].includes(issue.status)) return [];

  if (issue.executionRunId && issue.executionRunId !== input.endedRunId) {
    const [holder] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, issue.executionRunId));
    // A live run still owns the task; its own release drains the queue.
    if (holder && !isHeartbeatRunTerminalStatus(holder.status)) return [];
  }
  const [ended] = await db.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, input.endedRunId));
  if (!ended) return [];

  const state = parseIssueExecutionState(issue.executionState);
  const participant = state?.status === "pending" && state.currentParticipant?.type === "agent"
    ? state.currentParticipant.agentId : null;
  const assignee = issue.assigneeUserId ? null : issue.assigneeAgentId;

  const deferred = await db.select().from(agentWakeupRequests).where(and(
    ordinaryWakeRequestPredicate(),
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.status, DEFERRED_STATUS),
    ne(agentWakeupRequests.agentId, ended.agentId),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
  )).orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.id));

  const selected: DeferredOwnerWake[] = [];
  const decided = new Set<string>();
  for (const wake of deferred) {
    if (decided.has(wake.agentId)) continue;
    decided.add(wake.agentId);
    if (wake.agentId === participant) continue;
    const payload = record(wake.payload) ?? {};
    if (record(payload.executionStage)) continue;

    const interactionId = typeof payload.interactionId === "string" ? payload.interactionId : null;
    if (interactionId) {
      const [interaction] = await db.select({ status: issueThreadInteractions.status }).from(issueThreadInteractions)
        .where(and(eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.id, interactionId)));
      if (interaction?.status !== "pending") continue;
    } else {
      if (wake.agentId !== assignee) continue;
      const [newerRun] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, wake.agentId),
        or(eq(heartbeatRuns.issueId, issue.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${issue.id}`),
        gte(heartbeatRuns.createdAt, wake.createdAt),
      )).limit(1);
      if (newerRun) continue;
    }

    const [agent] = await db.select({ status: agents.status }).from(agents)
      .where(and(eq(agents.companyId, input.companyId), eq(agents.id, wake.agentId)));
    if (!agent || !INVOKABLE_AGENT_STATUSES.has(agent.status)) continue;

    const context = record(payload[WAKE_CONTEXT_KEY]);
    const { executionWait: _wait, [WAKE_CONTEXT_KEY]: _context, ...originalPayload } = payload;
    const contextSnapshot = context ? (({ wakeSource: _s, wakeTriggerDetail: _t, taskKey: _k, ...rest }) => rest)(context) : undefined;
    selected.push({
      agentId: wake.agentId,
      deferredWakeId: wake.id,
      opts: {
        source: wake.source as WakeupOptions["source"],
        triggerDetail: (wake.triggerDetail ?? undefined) as WakeupOptions["triggerDetail"],
        reason: typeof context?.wakeReason === "string" ? context.wakeReason : null,
        payload: originalPayload,
        ...(contextSnapshot ? { contextSnapshot } : {}),
        requestedByActorType: (wake.requestedByActorType ?? undefined) as WakeupOptions["requestedByActorType"],
        requestedByActorId: wake.requestedByActorId,
        // One admission per deferred wake per ended run, even if the end is recorded twice.
        idempotencyKey: `deferred-owner-release:${input.endedRunId}:${wake.id}`,
      },
    });
  }
  return selected;
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
 * Admits each selected deferred wake once, when a run that held the task has ended.
 * A deferred row is retired only after admission returns a wake, so a refused admission keeps it queued.
 */
export async function admitDeferredOwnerWake(
  db: Db,
  enqueueWakeup: (agentId: string, opts: WakeupOptions) => Promise<unknown>,
  input: { companyId: string; issueId: string; endedRunId: string },
) {
  for (const wake of await selectDeferredOwnerWakes(db, input)) {
    const admitted = await enqueueWakeup(wake.agentId, wake.opts);
    if (admitted) await retireReadmittedDeferredWake(db, { companyId: input.companyId, deferredWakeId: wake.deferredWakeId });
  }
}
