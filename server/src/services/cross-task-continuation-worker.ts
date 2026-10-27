import { and, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { agentWakeupRequests, type Db } from "@paperclipai/db";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { CROSS_TASK_CONTINUATION_COMMITTER_ID, crossTaskContinuationDispatchKey } from "./cross-task-continuation.js";
import { getExecutionBlocker } from "./execution-blocker.js";

type Coordinator = Pick<ReturnType<typeof createDeliveryWorkCoordinator>, "register">;

export const CROSS_TASK_CONTINUATION_STALE_CLAIM_MS = 60_000;

export async function readCrossTaskContinuationWork(db: Db, now = Date.now()) {
  const rows = await db.select({ status: agentWakeupRequests.status, claimedAt: agentWakeupRequests.claimedAt })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.requestedByActorType, "system"),
      eq(agentWakeupRequests.requestedByActorId, CROSS_TASK_CONTINUATION_COMMITTER_ID),
      inArray(agentWakeupRequests.status, ["queued", "claimed"]),
      isNull(agentWakeupRequests.runId),
    ));
  let pending = false;
  let nextClaimDeadline: number | null = null;
  const deferredReceipts = await db.select({ companyId: agentWakeupRequests.companyId, payload: agentWakeupRequests.payload })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.status, "deferred_issue_execution"),
      eq(agentWakeupRequests.requestedByActorType, "system"),
      sql`${agentWakeupRequests.requestedByActorId} = ${agentWakeupRequests.idempotencyKey}`,
      like(agentWakeupRequests.idempotencyKey, `${crossTaskContinuationDispatchKey("")}%`),
      isNull(agentWakeupRequests.runId),
    ));
  for (const receipt of deferredReceipts) {
    const issueId = (receipt.payload as Record<string, unknown> | null)?.issueId;
    if (typeof issueId === "string" && !(await getExecutionBlocker(db, receipt.companyId, issueId))) pending = true;
  }
  for (const row of rows) {
    const staleAt = row.status === "claimed" && row.claimedAt
      ? row.claimedAt.getTime() + CROSS_TASK_CONTINUATION_STALE_CLAIM_MS
      : null;
    if (staleAt === null || staleAt <= now) pending = true;
    else nextClaimDeadline = nextClaimDeadline === null ? staleAt : Math.min(nextClaimDeadline, staleAt);
  }
  return { pending, nextClaimDeadline };
}

export function registerCrossTaskContinuationWork(
  db: Db,
  coordinator: Coordinator,
  dispatch: () => Promise<unknown>,
) {
  let nextDeadline: number | null = null;
  return coordinator.register(DELIVERY_QUEUES.crossTaskContinuations, {
    retryMs: 5_000,
    async run(signal) {
      if (signal.aborted) return;
      await dispatch();
    },
    async hasPending() {
      const work = await readCrossTaskContinuationWork(db);
      nextDeadline = work.nextClaimDeadline;
      return work.pending;
    },
    nextRunAt: () => nextDeadline,
  });
}
