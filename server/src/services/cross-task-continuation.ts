import { createHash } from "node:crypto";
import {
  agentWakeupRequests,
  executionWorkspaces,
  heartbeatRuns,
  issueComments,
  issues,
  type Db,
} from "@paperclipai/db";
import type { IssueCommentContinuationReceipt } from "@paperclipai/shared";
import { and, desc, eq, inArray, isNotNull, like, or } from "drizzle-orm";
import { acquireExecutionWorkspaceLifecycleLock } from "./execution-workspace-lifecycle-lock.js";
import { isClosedExecutionWorkspaceStatus, readExecutionWorkspaceLifecycleGeneration } from "./execution-workspaces.js";
import { isDeadlockDetected, isUniqueViolation } from "../db-errors.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";


type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const CROSS_TASK_CONTINUATION_COMMITTER_ID = "cross-task-continuation-committer";
export const CROSS_TASK_CONTINUATION_SOURCE = "cross_task_continuation";
export const CROSS_TASK_CONTINUATION_REASON = "issue_reopened_via_comment";
export const CROSS_TASK_CONTINUATION_GATE_CHANGED = "cross_task_continuation_gate_changed";
const INTENT_KEY_PREFIX = "issue_cross_task_continuation:";
const DISPATCH_KEY_PREFIX = "cross-task-continuation-dispatch:";
const INTENT_KEY_LIKE_PREFIX = "issue\\_cross\\_task\\_continuation:";

export const CROSS_TASK_CONTINUATION_MESSAGES = {
  clientRequestIdRequired: "Cross-task continuation requires a clientRequestId for safe retries",
  notReopenable: "This issue is linked to a closed workspace that cannot be reopened.",
  digestMismatch: "This clientRequestId was already used for a different request",
  activeExecution: "Issue has active execution",
  deadlock: "Issue continuation conflicted with a concurrent workspace change; retry",
  runIdentity: "Task workspace run identity is unavailable",
  pauseHold: "Issue follow-up blocked by active subtree pause hold",
  unresolvedBlockers: "Issue follow-up blocked by unresolved blockers",
  notResumable: "Issue is not resumable through comment follow-up intent",
  assigneeChanged: "Issue assignee changed; retry the follow-up",
  responsibleUserChanged: "Issue responsible user changed; retry the follow-up",
} as const;

export function crossTaskContinuationIntentKey(issueId: string, commentId: string) {
  return `${INTENT_KEY_PREFIX}${issueId}:${commentId}`;
}

export function crossTaskContinuationDispatchKey(intentId: string) {
  return `${DISPATCH_KEY_PREFIX}${intentId}`;
}

export function isCrossTaskContinuationDispatchKey(key: string | null | undefined) {
  return typeof key === "string" && key.startsWith(DISPATCH_KEY_PREFIX);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function crossTaskContinuationRequestDigest(input: {
  issueId: string;
  body: string;
  resume?: boolean;
  reopen?: boolean;
  interrupt?: boolean;
  attachmentIds?: string[];
}) {
  return createHash("sha256").update(canonicalJson({
    issueId: input.issueId,
    body: input.body,
    resume: input.resume === true,
    reopen: input.reopen === true,
    interrupt: input.interrupt === true,
    attachmentIds: [...(input.attachmentIds ?? [])].sort(),
  })).digest("hex");
}

export type IssueExecutionWorkspaceBinding =
  | { kind: "none" }
  | { kind: "missing"; workspaceId: string }
  | {
      kind: "closed_isolated";
      workspaceId: string;
      generation: number;
      strategyType: string | null;
      providerType: string | null;
      metadata: Record<string, unknown> | null;
    }
  | { kind: "open_or_shared"; workspaceId: string };

function isClosedIsolatedRow(row: { mode: string | null; status: string | null }) {
  return row.mode === "isolated_workspace" && isClosedExecutionWorkspaceStatus(row.status);
}

export function isSuccessorReopenableWorkspace(row: {
  strategyType: string | null;
  providerType: string | null;
  metadata?: unknown;
}) {
  return row.strategyType === "git_worktree"
    && row.providerType !== "plugin"
    && (row.metadata as Record<string, unknown> | null | undefined)?.workspaceProviderRetired !== true;
}

export async function classifyIssueExecutionWorkspaceBinding(
  db: Db | Transaction,
  issue: { companyId: string; executionWorkspaceId?: string | null },
): Promise<IssueExecutionWorkspaceBinding> {
  const workspaceId = issue.executionWorkspaceId ?? null;
  if (!workspaceId) return { kind: "none" };
  const [row] = await db.select({
    id: executionWorkspaces.id,
    mode: executionWorkspaces.mode,
    status: executionWorkspaces.status,
    strategyType: executionWorkspaces.strategyType,
    providerType: executionWorkspaces.providerType,
    metadata: executionWorkspaces.metadata,
  }).from(executionWorkspaces).where(and(
    eq(executionWorkspaces.id, workspaceId),
    eq(executionWorkspaces.companyId, issue.companyId),
  ));
  if (!row) return { kind: "missing", workspaceId };
  if (isClosedIsolatedRow(row)) {
    return {
      kind: "closed_isolated",
      workspaceId,
      generation: readExecutionWorkspaceLifecycleGeneration(row.metadata as Record<string, unknown> | null),
      strategyType: row.strategyType,
      providerType: row.providerType,
      metadata: row.metadata as Record<string, unknown> | null,
    };
  }
  return { kind: "open_or_shared", workspaceId };
}

export type CrossTaskContinuationReceipt = IssueCommentContinuationReceipt;

export type CrossTaskContinuationReplay =
  | { kind: "fresh" }
  | { kind: "replay"; commentId: string; continuation: CrossTaskContinuationReceipt }
  | { kind: "digest_mismatch" }
  | { kind: "invariant_breach"; commentId: string };

function receiptFromIntent(intent: typeof agentWakeupRequests.$inferSelect): CrossTaskContinuationReceipt {
  const payload = (intent.payload ?? {}) as Record<string, unknown>;
  const coalescedInto = typeof payload.coalescedIntoWakeupRequestId === "string"
    ? payload.coalescedIntoWakeupRequestId : undefined;
  return {
    wakeupRequestId: intent.id,
    status: intent.status,
    runId: intent.runId ?? null,
    ...(coalescedInto ? { coalescedIntoWakeupRequestId: coalescedInto } : {}),
  };
}

export async function findCrossTaskContinuationReplay(
  db: Db | Transaction,
  input: { companyId: string; issueId: string; agentId: string; clientRequestId: string; requestDigest: string },
): Promise<CrossTaskContinuationReplay> {
  const [comment] = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId),
    eq(issueComments.issueId, input.issueId),
    eq(issueComments.authorAgentId, input.agentId),
    eq(issueComments.clientRequestId, input.clientRequestId),
  ));
  if (!comment) return { kind: "fresh" };
  const [intent] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId),
    eq(agentWakeupRequests.idempotencyKey, crossTaskContinuationIntentKey(input.issueId, comment.id)),
  ));
  if (!intent) return { kind: "invariant_breach", commentId: comment.id };
  const payload = (intent.payload ?? {}) as Record<string, unknown>;
  const recorded = (payload.crossTaskContinuation ?? {}) as Record<string, unknown>;
  if (recorded.requestDigest !== input.requestDigest) return { kind: "digest_mismatch" };
  return { kind: "replay", commentId: comment.id, continuation: receiptFromIntent(intent) };
}

export class CrossTaskContinuationRefusal extends Error {
  constructor(readonly status: number, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "CrossTaskContinuationRefusal";
  }
}

const LIVE_RUN_STATUSES = ["queued", "scheduled_retry", "running"] as const;

async function runIsLive(tx: Transaction, companyId: string, runId: string | null | undefined) {
  if (!runId) return false;
  const [run] = await tx.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)));
  return Boolean(run && (LIVE_RUN_STATUSES as readonly string[]).includes(run.status));
}

async function findPendingContinuationIntent(
  tx: Transaction,
  input: { companyId: string; issueId: string; agentId: string },
) {
  const rows = await tx.select({ intent: agentWakeupRequests, runStatus: heartbeatRuns.status })
    .from(agentWakeupRequests)
    .leftJoin(heartbeatRuns, eq(heartbeatRuns.id, agentWakeupRequests.runId))
    .where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.agentId, input.agentId),
      eq(agentWakeupRequests.requestedByActorType, "system"),
      eq(agentWakeupRequests.requestedByActorId, CROSS_TASK_CONTINUATION_COMMITTER_ID),
      like(agentWakeupRequests.idempotencyKey, `${INTENT_KEY_LIKE_PREFIX}${input.issueId}:%`),
      or(
        inArray(agentWakeupRequests.status, ["queued", "claimed"]),
        and(isNotNull(agentWakeupRequests.runId), inArray(heartbeatRuns.status, [...LIVE_RUN_STATUSES])),
      ),
    ))
    .orderBy(desc(agentWakeupRequests.requestedAt))
    .limit(1);
  return rows[0]?.intent ?? null;
}

export type CrossTaskContinuationCommitInput = {
  companyId: string;
  issueId: string;
  actorAgentId: string;
  sourceRunId: string;
  clientRequestId: string;
  requestDigest: string;
  binding: { workspaceId: string; generation: number };
  admitted: { assigneeAgentId: string | null; responsibleUserId: string | null };
  resumeRequested: boolean;
};

export type CrossTaskContinuationCommitDeps = {
  addComment: (tx: Transaction) => Promise<{ id: string }>;
  setIssueTodo: (tx: Transaction) => Promise<{ id: string; status: string } | null>;
  logIssueReopened: (tx: Transaction, input: { reopenedFrom: string }) => Promise<void>;
  getActivePauseHold: (companyId: string, issueId: string) => Promise<unknown | null>;
  getUnresolvedBlockerCount: (issueId: string, tx: Transaction) => Promise<number>;
  reauthorize: (issue: typeof issues.$inferSelect) => Promise<{
    status: number;
    body: { error?: string; details?: Record<string, unknown> };
  } | null>;
  beforeCommit?: (tx: Transaction) => Promise<void>;
};

export type CrossTaskContinuationCommitResult =
  | {
      kind: "committed";
      commentId: string;
      reopenedFrom: string | null;
      issue: { id: string; status: string } | null;
      continuation: CrossTaskContinuationReceipt;
    }
  | { kind: "replay" };

export async function commitCrossTaskContinuation(
  db: Db,
  input: CrossTaskContinuationCommitInput,
  deps: CrossTaskContinuationCommitDeps,
): Promise<CrossTaskContinuationCommitResult> {
  try {
    return await db.transaction(async (tx) => {
      await acquireExecutionWorkspaceLifecycleLock(tx, input.binding.workspaceId);
      const [issue] = await tx.select().from(issues).where(and(
        eq(issues.id, input.issueId), eq(issues.companyId, input.companyId),
      )).for("update");
      const [workspace] = await tx.select().from(executionWorkspaces).where(and(
        eq(executionWorkspaces.id, input.binding.workspaceId), eq(executionWorkspaces.companyId, input.companyId),
      )).for("update");

      const [duplicate] = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
        eq(issueComments.companyId, input.companyId),
        eq(issueComments.issueId, input.issueId),
        eq(issueComments.authorAgentId, input.actorAgentId),
        eq(issueComments.clientRequestId, input.clientRequestId),
      ));
      if (duplicate) return { kind: "replay" } as const;

      if (!issue) throw new CrossTaskContinuationRefusal(404, "Issue not found");
      const accessRefusal = await deps.reauthorize(issue);
      if (accessRefusal) {
        throw new CrossTaskContinuationRefusal(
          accessRefusal.status,
          accessRefusal.body.error ?? "Forbidden",
          accessRefusal.body.details,
        );
      }
      if (issue.assigneeAgentId !== input.admitted.assigneeAgentId) {
        throw new CrossTaskContinuationRefusal(409, CROSS_TASK_CONTINUATION_MESSAGES.assigneeChanged);
      }
      if ((issue.responsibleUserId ?? null) !== (input.admitted.responsibleUserId ?? null)) {
        throw new CrossTaskContinuationRefusal(409, CROSS_TASK_CONTINUATION_MESSAGES.responsibleUserChanged);
      }
      const [sourceRun] = await tx.select({
        agentId: heartbeatRuns.agentId, status: heartbeatRuns.status,
        issueId: heartbeatRuns.issueId, contextSnapshot: heartbeatRuns.contextSnapshot,
      })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.id, input.sourceRunId), eq(heartbeatRuns.companyId, input.companyId)));
      if (!sourceRun || sourceRun.agentId !== input.actorAgentId || sourceRun.status !== "running") {
        throw new CrossTaskContinuationRefusal(403, CROSS_TASK_CONTINUATION_MESSAGES.runIdentity);
      }
      if (await deps.getActivePauseHold(input.companyId, input.issueId)) {
        throw new CrossTaskContinuationRefusal(409, CROSS_TASK_CONTINUATION_MESSAGES.pauseHold);
      }
      const pendingIntent = issue.status === "todo" && issue.assigneeAgentId
        ? await findPendingContinuationIntent(tx, {
            companyId: input.companyId, issueId: input.issueId, agentId: issue.assigneeAgentId,
          })
        : null;
      const reopenable = issue.status === "done" || issue.status === "cancelled"
        || issue.status === "blocked" || issue.status === "in_progress";
      if (!reopenable && !pendingIntent) {
        throw new CrossTaskContinuationRefusal(409, CROSS_TASK_CONTINUATION_MESSAGES.notResumable, {
          issueId: issue.id, status: issue.status,
        });
      }
      if (issue.status === "blocked" && (await deps.getUnresolvedBlockerCount(issue.id, tx)) > 0) {
        throw new CrossTaskContinuationRefusal(409, CROSS_TASK_CONTINUATION_MESSAGES.unresolvedBlockers);
      }
      if (
        (await runIsLive(tx, input.companyId, issue.executionRunId))
        || (issue.checkoutRunId && issue.checkoutRunId !== input.sourceRunId
          && (await runIsLive(tx, input.companyId, issue.checkoutRunId)))
      ) {
        throw new CrossTaskContinuationRefusal(409, CROSS_TASK_CONTINUATION_MESSAGES.activeExecution);
      }

      if (
        issue.executionWorkspaceId !== input.binding.workspaceId
        || !workspace
        || !isClosedIsolatedRow(workspace)
        || readExecutionWorkspaceLifecycleGeneration(workspace.metadata as Record<string, unknown> | null)
          !== input.binding.generation
        || !isSuccessorReopenableWorkspace(workspace)
      ) {
        throw new CrossTaskContinuationRefusal(409, CROSS_TASK_CONTINUATION_MESSAGES.notReopenable);
      }

      const comment = await deps.addComment(tx);

      let reopenedFrom: string | null = null;
      let updated: { id: string; status: string } | null = null;
      if (!pendingIntent) {
        updated = await deps.setIssueTodo(tx);
        if (!updated) throw new CrossTaskContinuationRefusal(404, "Issue not found");
        reopenedFrom = issue.status;
        await deps.logIssueReopened(tx, { reopenedFrom });
      }

      const payload = {
        issueId: issue.id,
        taskId: issue.id,
        commentId: comment.id,
        reopenedFrom,
        mutation: "comment",
        resumeIntent: input.resumeRequested,
        followUpRequested: true,
        _paperclipWakeContext: {
          issueId: issue.id,
          taskId: issue.id,
          wakeReason: CROSS_TASK_CONTINUATION_REASON,
          wakeCommentId: comment.id,
          source: CROSS_TASK_CONTINUATION_SOURCE,
        },
        crossTaskContinuation: {
          requestedByAgentId: input.actorAgentId,
          sourceRunId: input.sourceRunId,
          sourceIssueId: sourceRun.issueId
            ?? (typeof (sourceRun.contextSnapshot as Record<string, unknown> | null)?.issueId === "string"
              ? (sourceRun.contextSnapshot as Record<string, string>).issueId
              : null),
          workspaceId: input.binding.workspaceId,
          workspaceGeneration: input.binding.generation,
          expectedAssigneeAgentId: issue.assigneeAgentId,
          expectedResponsibleUserId: issue.responsibleUserId ?? null,
          requestDigest: input.requestDigest,
        },
        ...(pendingIntent ? { coalescedIntoWakeupRequestId: pendingIntent.id } : {}),
      };
      if (!pendingIntent) await notifyDeliveryWork(tx, DELIVERY_QUEUES.crossTaskContinuations, `task:${issue.id}`);
      const now = new Date();
      const [intent] = await tx.insert(agentWakeupRequests).values({
        companyId: input.companyId,
        agentId: issue.assigneeAgentId!,
        source: "automation",
        triggerDetail: "system",
        reason: CROSS_TASK_CONTINUATION_REASON,
        payload,
        status: pendingIntent ? "coalesced" : "queued",
        ...(pendingIntent ? { finishedAt: now } : {}),
        requestedByActorType: "system",
        requestedByActorId: CROSS_TASK_CONTINUATION_COMMITTER_ID,
        idempotencyKey: crossTaskContinuationIntentKey(issue.id, comment.id),
        runId: null,
      }).returning();

      await deps.beforeCommit?.(tx);
      return {
        kind: "committed",
        commentId: comment.id,
        reopenedFrom,
        issue: updated,
        continuation: receiptFromIntent(intent!),
      } as const;
    });
  } catch (error) {
    if (error instanceof CrossTaskContinuationRefusal) throw error;
    if (isUniqueViolation(error, "issue_comments_agent_client_request_uq")
      || isUniqueViolation(error, "agent_wakeup_requests_cross_task_continuation_intent_uq")) {
      return { kind: "replay" };
    }
    if (isDeadlockDetected(error)) {
      throw new CrossTaskContinuationRefusal(409, CROSS_TASK_CONTINUATION_MESSAGES.deadlock);
    }
    throw error;
  }
}

export function crossTaskContinuationDeliveryGate(
  payload: Record<string, unknown>,
  target: {
    status: string;
    assigneeAgentId: string | null;
    responsibleUserId: string | null;
    executionWorkspaceId: string | null;
  },
  unresolvedBlockerCount: number,
): string | null {
  const recorded = (payload.crossTaskContinuation ?? {}) as Record<string, unknown>;
  const statusOk = target.status === "todo" || target.status === "in_progress"
    || (target.status === "blocked" && unresolvedBlockerCount === 0);
  if (
    !statusOk
    || target.assigneeAgentId !== (recorded.expectedAssigneeAgentId ?? null)
    || (target.responsibleUserId ?? null) !== (recorded.expectedResponsibleUserId ?? null)
    || target.executionWorkspaceId !== (recorded.workspaceId ?? null)
  ) {
    return CROSS_TASK_CONTINUATION_GATE_CHANGED;
  }
  return null;
}
