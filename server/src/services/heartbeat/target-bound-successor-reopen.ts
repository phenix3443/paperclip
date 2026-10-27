import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, executionWorkspaces, issues, type Db } from "@paperclipai/db";
import {
  CROSS_TASK_CONTINUATION_COMMITTER_ID,
  crossTaskContinuationDispatchKey,
  crossTaskContinuationIntentKey,
  isCrossTaskContinuationDispatchKey,
  isSuccessorReopenableWorkspace,
} from "../cross-task-continuation.js";
import { isClosedExecutionWorkspaceStatus, readExecutionWorkspaceLifecycleGeneration, type executionWorkspaceService } from "../execution-workspaces.js";
import { runRetainsIssueIdentity } from "../task-repository-acquisition.js";


export const TARGET_BOUND_SUCCESSOR_REOPEN_FAILURE =
  "Cross-task continuation could not reopen the target workspace";

export class TargetBoundSuccessorReopenError extends Error {
  constructor(detail: string) {
    super(`${TARGET_BOUND_SUCCESSOR_REOPEN_FAILURE}: ${detail}`);
    this.name = "TargetBoundSuccessorReopenError";
  }
}

type ExecutionWorkspaceService = Pick<
  ReturnType<typeof executionWorkspaceService>,
  "reopenClosedIsolatedExecutionWorkspaceForIssue" | "clearReopenPendingConsumptionForUnconsumedReopen"
>;

export type TargetBoundSuccessorRun = {
  id: string;
  companyId: string;
  agentId: string;
  wakeupRequestId: string | null;
  issueId: string | null;
  nativeIssueId: string | null;
  contextSnapshot: Record<string, unknown> | null;
};

export type TargetBoundSuccessorReopenOutcome =
  | { kind: "not_eligible" }
  | { kind: "already_active"; workspaceId: string }
  | { kind: "reopened"; workspaceId: string; generation: number; reopened: boolean };

type ContinuationPayload = {
  issueId?: unknown;
  crossTaskContinuation?: {
    workspaceId?: unknown;
    workspaceGeneration?: unknown;
    expectedAssigneeAgentId?: unknown;
    expectedResponsibleUserId?: unknown;
  };
};

const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadDispatchedIntent(db: Db, run: TargetBoundSuccessorRun) {
  if (!run.wakeupRequestId) return null;
  const [receipt] = await db.select({
    idempotencyKey: agentWakeupRequests.idempotencyKey,
    requestedByActorId: agentWakeupRequests.requestedByActorId,
  }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, run.wakeupRequestId),
    eq(agentWakeupRequests.companyId, run.companyId),
  ));
  const dispatchKey = receipt?.idempotencyKey ?? null;
  if (!receipt || !isCrossTaskContinuationDispatchKey(dispatchKey) || receipt.requestedByActorId !== dispatchKey) {
    return null;
  }
  const intentId = dispatchKey!.slice(crossTaskContinuationDispatchKey("").length);
  if (!UUID_PATTERN.test(intentId)) return null;
  const [intent] = await db.select({
    id: agentWakeupRequests.id,
    idempotencyKey: agentWakeupRequests.idempotencyKey,
    requestedByActorType: agentWakeupRequests.requestedByActorType,
    requestedByActorId: agentWakeupRequests.requestedByActorId,
    payload: agentWakeupRequests.payload,
  }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.id, intentId),
    eq(agentWakeupRequests.companyId, run.companyId),
  ));
  if (!intent
    || intent.requestedByActorType !== "system"
    || intent.requestedByActorId !== CROSS_TASK_CONTINUATION_COMMITTER_ID) {
    return null;
  }
  const payload = (intent.payload ?? {}) as ContinuationPayload;
  const targetIssueId = typeof payload.issueId === "string" ? payload.issueId : null;
  if (!targetIssueId || !intent.idempotencyKey?.startsWith(crossTaskContinuationIntentKey(targetIssueId, ""))) {
    return null;
  }
  return { intentId: intent.id, targetIssueId, payload };
}

export async function reopenTargetBoundSuccessorWorkspace(
  db: Db,
  input: {
    run: TargetBoundSuccessorRun;
    responsibleUserId: string | null;
    externalProvider: boolean;
    hasPersistedNativeExecutionInput: boolean;
    freshIsolatedWorkspaceRequested: boolean;
    executionWorkspacesSvc: ExecutionWorkspaceService;
  },
): Promise<TargetBoundSuccessorReopenOutcome> {
  const { run } = input;
  if (input.externalProvider || input.hasPersistedNativeExecutionInput || input.freshIsolatedWorkspaceRequested) {
    return { kind: "not_eligible" };
  }
  const dispatched = await loadDispatchedIntent(db, run);
  if (!dispatched) return { kind: "not_eligible" };

  const fail = (detail: string): never => { throw new TargetBoundSuccessorReopenError(detail); };
  const continuation = dispatched.payload.crossTaskContinuation ?? {};
  const [target] = await db.select({
    id: issues.id,
    companyId: issues.companyId,
    projectId: issues.projectId,
    status: issues.status,
    assigneeAgentId: issues.assigneeAgentId,
    responsibleUserId: issues.responsibleUserId,
    executionWorkspaceId: issues.executionWorkspaceId,
  }).from(issues).where(and(eq(issues.id, dispatched.targetIssueId), eq(issues.companyId, run.companyId)));

  if (!target
    || !runRetainsIssueIdentity(run, target.id)
    || target.companyId !== run.companyId
    || target.assigneeAgentId !== run.agentId
    || continuation.expectedAssigneeAgentId !== run.agentId) {
    return fail("the run is not bound to the continuation target");
  }
  const expectedResponsibleUserId = typeof continuation.expectedResponsibleUserId === "string"
    ? continuation.expectedResponsibleUserId : null;
  if ((input.responsibleUserId ?? null) !== (target.responsibleUserId ?? null)
    || (target.responsibleUserId ?? null) !== expectedResponsibleUserId) {
    return fail("the responsible user changed");
  }
  const workspaceId = typeof continuation.workspaceId === "string" ? continuation.workspaceId : null;
  if (!workspaceId || target.executionWorkspaceId !== workspaceId) {
    return fail("the workspace binding changed");
  }
  const [row] = await db.select({
    id: executionWorkspaces.id,
    mode: executionWorkspaces.mode,
    status: executionWorkspaces.status,
    strategyType: executionWorkspaces.strategyType,
    providerType: executionWorkspaces.providerType,
    metadata: executionWorkspaces.metadata,
  }).from(executionWorkspaces).where(and(
    eq(executionWorkspaces.id, workspaceId),
    eq(executionWorkspaces.companyId, run.companyId),
  ));
  if (!row || row.mode !== "isolated_workspace" || !isSuccessorReopenableWorkspace(row)) {
    return fail("the workspace is not reopenable");
  }
  if (row.status === "active") return { kind: "already_active", workspaceId };
  if (!isClosedExecutionWorkspaceStatus(row.status)) return fail("the workspace is not reopenable");
  const expectedClosedGeneration = typeof continuation.workspaceGeneration === "number"
    ? continuation.workspaceGeneration : null;
  if (expectedClosedGeneration === null
    || readExecutionWorkspaceLifecycleGeneration(row.metadata as Record<string, unknown> | null) !== expectedClosedGeneration) {
    return fail("the workspace changed after the continuation request");
  }

  const actor = { agentId: run.agentId, actorType: "agent" };
  let result: Awaited<ReturnType<ExecutionWorkspaceService["reopenClosedIsolatedExecutionWorkspaceForIssue"]>>;
  try {
    result = await input.executionWorkspacesSvc.reopenClosedIsolatedExecutionWorkspaceForIssue({
      workspaceId,
      issue: { id: target.id, companyId: target.companyId, projectId: target.projectId },
      actor,
      authorizationActor: {
        type: "agent",
        agentId: run.agentId,
        companyId: run.companyId,
        source: "agent_jwt",
        runId: run.id,
        onBehalfOfUserId: input.responsibleUserId === "local-board" ? null : input.responsibleUserId,
      },
      expectedClosedGeneration,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Execution workspace is not reopenable");
  }
  if (!result.ok) return fail(result.message);

  if (result.reopened) {
    const [current] = await db.select({ status: issues.status }).from(issues)
      .where(and(eq(issues.id, target.id), eq(issues.companyId, target.companyId)));
    if (!current || TERMINAL_ISSUE_STATUSES.has(current.status)) {
      await input.executionWorkspacesSvc.clearReopenPendingConsumptionForUnconsumedReopen({
        workspaceId,
        issue: { id: target.id, companyId: target.companyId },
        actor,
        expectedGeneration: result.generation,
      });
      return fail("the target closed before the run used the workspace");
    }
  }
  return { kind: "reopened", workspaceId, generation: result.generation, reopened: result.reopened };
}
