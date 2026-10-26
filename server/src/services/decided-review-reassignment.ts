import { and, asc, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  approvals,
  environmentLeases,
  heartbeatRuns,
  issueApprovals,
  issueExecutionDecisions,
  issueRecoveryActions,
  issueThreadInteractions,
  issues,
  nativeRunFinalizations,
  type Db,
} from "@paperclipai/db";
import { hasWorkspaceRestoreFailure } from "@paperclipai/shared";
import { persistActivity } from "./activity-log.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { isSupersededConversationRun } from "./agent-conversations.js";
import { readChatControlRecoveryStop } from "./chat-control-recovery-stop.js";
import { getConversationOwnershipBlocker } from "./conversation-continuation.js";
import { executionBlockerPredicate } from "./execution-blocker.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { issueService } from "./issues.js";
import { isPreDispatchExecutionWaitVerified } from "./pre-dispatch-execution-wait.js";
import { hasRemoteTerminationReceipt } from "./remote-execution-termination.js";


type Run = typeof heartbeatRuns.$inferSelect;
type Task = typeof issues.$inferSelect;
type Hold = typeof issueRecoveryActions.$inferSelect;
type Decision = typeof issueExecutionDecisions.$inferSelect;

const LEGACY_RECOVERY_CAUSE = "legacy_execution_requires_reconciliation";
export const DECIDED_REVIEW_CONTINUATION_REPLAY = "decided_review_continuation_v1";
const REVIEW_REQUEST_REASON = "execution_review_requested";
export const SUBMISSION_STAMP = "decidedReviewSubmission";

export type SubmissionIdentity = { decisionId: string; resubmissionActivityId: string };

export type DecidedReviewConsumption = {
  sourceRunId: string;
  decisionId: string;
  resubmissionActivityId: string;
  chainRunIds: string[];
  successorRunId: string;
  shape: "in_review" | "blocked_projection";
  recordedAt: string;
};

export type DecidedReviewSource = { source: Run; chain: Run[]; holds: Hold[]; decision: Decision };

export type DecidedReviewSelection =
  | ({ kind: "selected" } & DecidedReviewSource)
  | { kind: "none"; rule: string; runId?: string };

export type DecidedReviewProof =
  | {
      kind: "proved";
      task: Task;
      source: Run;
      chain: Run[];
      holds: Hold[];
      decisionId: string;
      resubmissionActivityId: string;
      shape: "in_review" | "blocked_projection";
    }
  | { kind: "hold"; reason: string };

function readState(task: Pick<Task, "executionState">) {
  return parseIssueExecutionState(task.executionState);
}

function runIssueId(run: Pick<Run, "nativeIssueId" | "contextSnapshot">) {
  return run.nativeIssueId ?? (typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null);
}

function processStopped(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

function evidenceObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function readDecision(db: Db, task: Pick<Task, "companyId" | "id">, decisionId: string | null | undefined) {
  if (!decisionId) return null;
  const [decision] = await db.select().from(issueExecutionDecisions).where(and(
    eq(issueExecutionDecisions.companyId, task.companyId), eq(issueExecutionDecisions.issueId, task.id),
    eq(issueExecutionDecisions.id, decisionId),
  )).limit(1);
  return decision ?? null;
}

async function readRun(db: Db, companyId: string, runId: string | null | undefined) {
  if (!runId) return null;
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId),
  )).limit(1);
  return run ?? null;
}

async function latestResubmission(db: Db, task: Pick<Task, "companyId" | "id" | "executionState">, decision: Decision) {
  const state = readState(task);
  const author = state?.returnAssignee;
  if (!state?.currentStageId || !author || (author.type === "agent" ? !author.agentId : !author.userId)) return null;
  const [activity] = await db.select().from(activityLog).where(and(
    eq(activityLog.companyId, task.companyId), eq(activityLog.entityType, "issue"),
    eq(activityLog.entityId, task.id), eq(activityLog.action, "issue.updated"),
    eq(activityLog.actorType, author.type), eq(activityLog.actorId, (author.type === "agent" ? author.agentId : author.userId)!),
    gt(activityLog.createdAt, decision.createdAt),
    sql`${activityLog.details}->>'status' = 'in_review'`,
    sql`${activityLog.details}->'_previous'->>'status' = 'in_progress'`,
    sql`${activityLog.details}->'changes'->'executionState'->'to'->>'status' = 'pending'`,
    sql`${activityLog.details}->'changes'->'executionState'->'to'->>'currentStageId' = ${state.currentStageId}`,
    decision.createdByRunId
      ? or(isNull(activityLog.runId), ne(activityLog.runId, decision.createdByRunId))
      : undefined,
  )).orderBy(desc(activityLog.createdAt), desc(activityLog.id)).limit(1);
  return activity ?? null;
}

export async function currentSubmissionIdentity(
  db: Db, task: Pick<Task, "companyId" | "id" | "status" | "executionState">, agentId: string,
): Promise<SubmissionIdentity | null> {
  if (task.status !== "in_review") return null;
  const state = readState(task);
  if (state?.currentStageType !== "review" || !state.currentStageId ||
      state.currentParticipant?.type !== "agent" || state.currentParticipant.agentId !== agentId) return null;
  const decision = await readDecision(db, task, state.lastDecisionId);
  if (!decision || decision.stageId !== state.currentStageId) return null;
  const decidingRun = await readRun(db, task.companyId, decision.createdByRunId);
  if (!decidingRun || decidingRun.agentId !== agentId) return null;
  const resubmission = await latestResubmission(db, task, decision);
  return resubmission ? { decisionId: decision.id, resubmissionActivityId: resubmission.id } : null;
}

export async function findConsumption(
  db: Db, task: Pick<Task, "companyId" | "id">, identity: SubmissionIdentity,
): Promise<DecidedReviewConsumption | null> {
  const [row] = await db.select({ evidence: issueRecoveryActions.evidence }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, task.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
    sql`${issueRecoveryActions.evidence}->'decidedReviewContinuation'->>'decisionId' = ${identity.decisionId}`,
    sql`${issueRecoveryActions.evidence}->'decidedReviewContinuation'->>'resubmissionActivityId' = ${identity.resubmissionActivityId}`,
  )).orderBy(asc(issueRecoveryActions.createdAt)).limit(1);
  return (evidenceObject(row?.evidence.decidedReviewContinuation) as DecidedReviewConsumption | null) ?? null;
}

export async function findSubmissionTurn(
  db: Db, task: Pick<Task, "companyId" | "id">, identity: SubmissionIdentity,
): Promise<{ successorRunId: string } | null> {
  const consumed = await findConsumption(db, task, identity);
  if (consumed) return { successorRunId: consumed.successorRunId };
  const [run] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, task.companyId),
    or(eq(heartbeatRuns.nativeIssueId, task.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${task.id}`),
    sql`${heartbeatRuns.contextSnapshot}->'decidedReviewSubmission'->>'decisionId' = ${identity.decisionId}`,
    sql`${heartbeatRuns.contextSnapshot}->'decidedReviewSubmission'->>'resubmissionActivityId' = ${identity.resubmissionActivityId}`,
  )).orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id)).limit(1);
  return run ? { successorRunId: run.id } : null;
}

async function isContinuedReview(db: Db, task: Pick<Task, "companyId" | "id">) {
  const [continued] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, task.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
    sql`${issueRecoveryActions.evidence} ? 'decidedReviewContinuation'`,
  )).limit(1);
  return Boolean(continued);
}

function isBlockingHold(hold: Hold) {
  return ["active", "escalated"].includes(hold.status) ||
    evidenceObject(hold.evidence.automaticRecovery)?.replay === "blocked";
}

export async function selectDecidedReviewSource(
  db: Db, task: Pick<Task, "companyId" | "id" | "status" | "executionState">, identity?: SubmissionIdentity | null,
): Promise<DecidedReviewSelection> {
  const state = readState(task);
  if (state?.currentParticipant?.type !== "agent" || !state.currentParticipant.agentId) return { kind: "none", rule: "participant_not_agent" };
  const agentId = state.currentParticipant.agentId;
  const decision = await readDecision(db, task, state.lastDecisionId);
  if (!decision || decision.outcome !== "changes_requested") return { kind: "none", rule: "decision_not_changes_requested" };
  const source = await readRun(db, task.companyId, decision.createdByRunId);
  if (!source || source.agentId !== agentId || runIssueId(source) !== task.id) return { kind: "none", rule: "decision_run_not_participant" };
  const submission = identity === undefined ? await currentSubmissionIdentity(db, task, agentId) : identity;
  if (submission && await findSubmissionTurn(db, task, submission)) return { kind: "none", rule: "consumed" };
  const newer = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, task.companyId), eq(heartbeatRuns.agentId, agentId),
    or(eq(heartbeatRuns.nativeIssueId, task.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${task.id}`),
    sql`(${heartbeatRuns.createdAt}, ${heartbeatRuns.id}) > (select created_at, id from heartbeat_runs where company_id = ${task.companyId} and id = ${source.id})`,
  )).orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id));
  const fingerprints = (ids: string[]) => ids.map(id => `legacy-execution:${id}`);
  const chain: Run[] = [];
  for (const run of newer) {
    const wait = evidenceObject(run.resultJson?.executionWait);
    const accepted = [source.id, ...chain.map(q => q.id)];
    const [parent] = typeof wait?.recoveryActionId === "string" ? await db.select({ id: issueRecoveryActions.id })
      .from(issueRecoveryActions).where(and(
        eq(issueRecoveryActions.companyId, task.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
        sql`${issueRecoveryActions.id}::text = ${wait.recoveryActionId}`,
        inArray(sql`${issueRecoveryActions.evidence}->>'runId'`, accepted),
      )).limit(1) : [];
    if (!(await isPreDispatchExecutionWaitVerified(db, run)) || !parent || !source.finishedAt ||
        run.createdAt < source.finishedAt) {
      return { kind: "none", rule: "newer_run_not_verified_pre_dispatch_wait", runId: run.id };
    }
    chain.push(run);
  }
  const holds = (await db.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, task.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
    eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
    inArray(issueRecoveryActions.fingerprint, fingerprints([source.id, ...chain.map(q => q.id)])),
  )).orderBy(asc(issueRecoveryActions.createdAt))).filter(isBlockingHold);
  return { kind: "selected", source, chain, holds, decision };
}

async function provesStopSettled(db: Db, run: Run) {
  if (run.processPid && !processStopped(run.processPid)) return "P2_process_running";
  if (run.processGroupId && !processStopped(-run.processGroupId)) return "P2_process_running";
  const leases = await db.select().from(environmentLeases).where(and(
    eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id),
  ));
  if (leases.some(lease => lease.provider === "local"
    ? !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed"
    : !hasRemoteTerminationReceipt(lease))) return "P2_lease_unreleased";
  return null;
}

async function provesExpectedReassignmentStop(db: Db, run: Run) {
  const result = run.resultJson ?? {};
  const cancellation = evidenceObject(result.cancellation);
  const initiator = evidenceObject(cancellation?.initiator);
  if (run.runtimeMode !== "legacy" || run.status !== "cancelled" || run.errorCode !== "issue_reassigned" ||
      result.reassignmentStopConfirmed !== true || typeof result.issueMutationStopId !== "string" ||
      cancellation?.source !== "control_plane" || cancellation.expected !== true ||
      ["user", "board"].includes(String(initiator?.type)) || !run.finishedAt ||
      hasWorkspaceRestoreFailure(result)) return "P1_not_expected_reassignment_stop";
  const [native] = await db.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations).where(and(
    eq(nativeRunFinalizations.companyId, run.companyId), eq(nativeRunFinalizations.runId, run.id),
  )).limit(1);
  return native ? "P1_native_finalization" : null;
}

async function provesDecisionProvenance(db: Db, task: Task, run: Run, decision: Decision) {
  const state = readState(task);
  if (decision.createdByRunId !== run.id || decision.actorAgentId !== run.agentId ||
      decision.outcome !== "changes_requested" || decision.stageType !== "review" ||
      decision.stageId !== state?.currentStageId || !run.finishedAt ||
      decision.createdAt < run.finishedAt) return "P3_decision_provenance";
  const [later] = await db.select({ id: issueExecutionDecisions.id }).from(issueExecutionDecisions).where(and(
    eq(issueExecutionDecisions.companyId, task.companyId), eq(issueExecutionDecisions.issueId, task.id),
    eq(issueExecutionDecisions.stageId, decision.stageId), ne(issueExecutionDecisions.id, decision.id),
    sql`${issueExecutionDecisions.createdAt} >= ${decision.createdAt.toISOString()}::timestamptz`,
  )).limit(1);
  return later ? "P3_later_decision" : null;
}

export async function provesDecidedReviewProvenance(db: Db, task: Task, selected: DecidedReviewSource) {
  return await provesExpectedReassignmentStop(db, selected.source) ??
    await provesDecisionProvenance(db, task, selected.source, selected.decision);
}

export async function proveDecidedReviewContinuation(db: Db, input: { task: Task }): Promise<DecidedReviewProof> {
  const { task } = input;
  const state = readState(task);
  if (["done", "cancelled"].includes(task.status)) return { kind: "hold", reason: "P4_task_closed" };
  if (state?.status !== "pending" || state.currentStageType !== "review" ||
      state.currentParticipant?.type !== "agent" || !state.currentParticipant.agentId) return { kind: "hold", reason: "P4_not_pending_review" };
  const selected = await selectDecidedReviewSource(db, task);
  if (selected.kind === "none") return { kind: "hold", reason: `selector_${selected.rule}` };
  const { source, chain, holds, decision } = selected;
  const provenance = await provesDecidedReviewProvenance(db, task, selected);
  if (provenance) return { kind: "hold", reason: provenance };
  const stop = await provesStopSettled(db, source);
  if (stop) return { kind: "hold", reason: stop };

  if (task.assigneeAgentId !== source.agentId || isSupersededConversationRun(task, source)) return { kind: "hold", reason: "P4_assignee" };
  let shape: "in_review" | "blocked_projection";
  if (task.status === "in_review") shape = "in_review";
  else if (task.status === "blocked") {
    const chainIds = new Set([source.id, ...chain.map(q => q.id)]);
    const receipt = holds.map(hold => evidenceObject(hold.evidence.reviewHoldBlock)).find(block =>
      typeof block?.runId === "string" && chainIds.has(block.runId) && block.statusVersion === task.statusVersion &&
      block.previousStatus === "in_review" && block.stageId === state.currentStageId && block.lastDecisionId === decision.id);
    if (!receipt) {
      return { kind: "hold", reason: holds.some(hold => hold.evidence.reviewHoldBlock) ? "P4b_receipt_stale" : "P4b_no_receipt" };
    }
    if (task.executionRunId || task.checkoutRunId) return { kind: "hold", reason: "P4b_execution_owned" };
    shape = "blocked_projection";
  } else return { kind: "hold", reason: "P4_status" };

  const resubmission = await latestResubmission(db, task, decision);
  if (!resubmission) return { kind: "hold", reason: "P5_no_resubmission" };

  if (!holds.length) return { kind: "hold", reason: "P6_no_hold" };
  const readiness = (await issueService(db).listDependencyReadiness(task.companyId, [task.id], db)).get(task.id);
  if (readiness && !readiness.isDependencyReady) return { kind: "hold", reason: "P6_dependency" };
  const [interaction] = await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, task.companyId), eq(issueThreadInteractions.issueId, task.id),
    eq(issueThreadInteractions.status, "pending"),
  )).limit(1);
  const [approval] = await db.select({ id: approvals.id }).from(issueApprovals).innerJoin(approvals, and(
    eq(approvals.id, issueApprovals.approvalId), eq(approvals.companyId, task.companyId),
  )).where(and(eq(issueApprovals.companyId, task.companyId), eq(issueApprovals.issueId, task.id),
    inArray(approvals.status, ["pending", "revision_requested"]))).limit(1);
  if (interaction || approval) return { kind: "hold", reason: "P6_decision_pending" };
  if ((await readChatControlRecoveryStop(db, {
    companyId: task.companyId, issueId: task.id, agentId: source.agentId, sourceRunId: source.id,
  })).kind !== "clear") return { kind: "hold", reason: "P6_chat_control_stop" };
  if (await getConversationOwnershipBlocker(db, task.companyId, task.id)) return { kind: "hold", reason: "P6_conversation_owner" };
  const [active] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, task.companyId),
    or(eq(heartbeatRuns.nativeIssueId, task.id), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${task.id}`),
    inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
  )).limit(1);
  if (active) return { kind: "hold", reason: "P6_execution_active" };
  const settledIds = new Set(holds.map(hold => hold.id));
  const blockers = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, task.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
    executionBlockerPredicate(),
  ));
  if (blockers.some(blocker => !settledIds.has(blocker.id))) return { kind: "hold", reason: "P6_foreign_hold" };

  if (holds.some(hold => ["decidedReviewContinuation", "executionReconciliation", "explicitUserContinuation",
    "workspaceRestoreFailure"].some(key => key in hold.evidence))) return { kind: "hold", reason: "P7_already_owned" };

  return {
    kind: "proved", task, source, chain, holds, decisionId: decision.id,
    resubmissionActivityId: resubmission.id, shape,
  };
}

export async function admitDecidedReviewContinuation(
  db: Db, proof: Extract<DecidedReviewProof, { kind: "proved" }>, input: { successorRunId: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const record: DecidedReviewConsumption = {
    sourceRunId: proof.source.id,
    decisionId: proof.decisionId,
    resubmissionActivityId: proof.resubmissionActivityId,
    chainRunIds: proof.chain.map(run => run.id),
    successorRunId: input.successorRunId,
    shape: proof.shape,
    recordedAt: now.toISOString(),
  };
  for (const hold of proof.holds) {
    const runId = hold.evidence.runId;
    await db.update(issueRecoveryActions).set({
      status: "resolved", outcome: "cancelled", resolvedAt: now, updatedAt: now,
      nextAction: "The reviewer recorded its decision before the expected reassignment stop. A fresh review of the resubmission was started.",
      resolutionNote: "The stopped reviewer's outcome is its recorded decision. No prior action was replayed.",
      wakePolicy: null, monitorPolicy: null,
      evidence: {
        ...hold.evidence,
        automaticRecovery: {
          policy: "preserve_without_replay_v1",
          runId,
          ...evidenceObject(hold.evidence.automaticRecovery),
          replay: DECIDED_REVIEW_CONTINUATION_REPLAY,
          actionOutcome: runId === proof.source.id ? "decision_recorded" : "not_performed",
        },
        decidedReviewContinuation: record,
      },
    }).where(and(eq(issueRecoveryActions.companyId, proof.task.companyId), eq(issueRecoveryActions.id, hold.id)));
  }
  const holdIds = proof.holds.map(hold => hold.id);
  const parked = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, proof.task.companyId), eq(agentWakeupRequests.agentId, proof.source.agentId),
    eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${proof.task.id}`,
    inArray(sql`${agentWakeupRequests.payload}->'executionWait'->>'recoveryActionId'`, holdIds),
  ));
  await persistActivity(db, {
    companyId: proof.task.companyId, actorType: "system", actorId: "execution-recovery",
    action: "issue.execution_recovery_settled", entityType: "issue", entityId: proof.task.id,
    agentId: proof.source.agentId, runId: proof.source.id,
    details: { continuation: "decided_review_reassignment", recoveryActionIds: holdIds, ...record },
  });
  return {
    record,
    foldedWakeIds: parked.map(wake => wake.id),
  };
}

export type DecidedReviewWake = {
  agentId: string;
  reason: string | null;
  source: string;
  requestedByActorType: string | null | undefined;
  payload: Record<string, unknown> | null;
  carriesInput: boolean;
};

export type DecidedReviewAdmissionOutcome =
  | { kind: "continue"; serves?: SubmissionIdentity }
  | { kind: "skip"; reason: string; detail: Record<string, unknown> }
  | { kind: "coalesce"; runId: string }
  | { kind: "admit"; identity: SubmissionIdentity };

export type DecidedReviewAdmissionReads = {
  identity(): Promise<SubmissionIdentity | null>;
  consumption(identity: SubmissionIdentity): Promise<{ successorRunId: string } | null>;
  continued(): Promise<boolean>;
  successorActive(runId: string): Promise<boolean>;
  select(identity: SubmissionIdentity): Promise<{ kind: "selected" } | { kind: "none"; rule: string; runId?: string }>;
  hasBlocker(): Promise<boolean>;
  prove(): Promise<{ kind: "proved" } | { kind: "hold"; reason: string }>;
};

function carriedIdentity(payload: Record<string, unknown> | null) {
  const carried = evidenceObject(payload?.decidedReviewContinuation);
  return carried && typeof carried.decisionId === "string" && typeof carried.resubmissionActivityId === "string"
    ? { sourceRunId: carried.sourceRunId, decisionId: carried.decisionId, resubmissionActivityId: carried.resubmissionActivityId }
    : null;
}

export function classifyDecidedReviewWake(wake: DecidedReviewWake, currentParticipantAgentId: string | null) {
  if (wake.source === "automation" && wake.requestedByActorType === "system" &&
      wake.reason === REVIEW_REQUEST_REASON && carriedIdentity(wake.payload)) return "W1" as const;
  if (wake.reason === REVIEW_REQUEST_REASON && wake.agentId === currentParticipantAgentId &&
      wake.requestedByActorType !== "user" && !wake.carriesInput && !carriedIdentity(wake.payload)) return "W2" as const;
  return "W3" as const;
}

export async function decideDecidedReviewAdmission(
  wakeClass: "W1" | "W2" | "W3", wake: Pick<DecidedReviewWake, "payload">, reads: DecidedReviewAdmissionReads,
): Promise<DecidedReviewAdmissionOutcome> {
  if (wakeClass === "W3") return { kind: "continue" };
  const recovery = wakeClass === "W1";
  const identity = await reads.identity();
  if (!identity) {
    return recovery ? { kind: "skip", reason: "decided_review_continuation_stale", detail: { detail: "identity_unavailable" } } : { kind: "continue" };
  }
  const carried = carriedIdentity(wake.payload);
  if (recovery && (carried?.decisionId !== identity.decisionId || carried.resubmissionActivityId !== identity.resubmissionActivityId)) {
    return { kind: "skip", reason: "decided_review_continuation_stale", detail: { detail: "identity_changed", ...identity } };
  }
  const consumed = await reads.consumption(identity);
  if (consumed) {
    return await reads.successorActive(consumed.successorRunId)
      ? { kind: "coalesce", runId: consumed.successorRunId }
      : { kind: "skip", reason: "decided_review_continuation_consumed", detail: { successorRunId: consumed.successorRunId, ...identity } };
  }
  const ordinary = async (): Promise<DecidedReviewAdmissionOutcome> =>
    await reads.continued() ? { kind: "continue", serves: identity } : { kind: "continue" };
  const selected = await reads.select(identity);
  if (selected.kind === "none") {
    return recovery
      ? { kind: "skip", reason: "decided_review_continuation_not_eligible", detail: { rule: selected.rule, runId: selected.runId ?? null, ...identity } }
      : await ordinary();
  }
  if (!(await reads.hasBlocker())) {
    return recovery ? { kind: "skip", reason: "decided_review_continuation_not_held", detail: { ...identity } } : await ordinary();
  }
  const proof = await reads.prove();
  if (proof.kind === "hold") {
    return recovery ? { kind: "skip", reason: "decided_review_continuation_unproven", detail: { predicate: proof.reason, ...identity } } : await ordinary();
  }
  return { kind: "admit", identity };
}

export async function decidedReviewAdmission(db: Db, input: {
  companyId: string; issueId: string; wake: DecidedReviewWake;
}): Promise<DecidedReviewAdmissionOutcome> {
  const [task] = await db.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  if (!task) return { kind: "continue" };
  const state = readState(task);
  const participant = state?.currentParticipant?.type === "agent" ? state.currentParticipant.agentId ?? null : null;
  if (participant && await hasDecidedReviewCandidate(db, task)) {
    await notifyDeliveryWork(db, DELIVERY_QUEUES.executionContinuation, task.id);
  }
  const wakeClass = classifyDecidedReviewWake(input.wake, participant);
  return decideDecidedReviewAdmission(wakeClass, input.wake, {
    identity: () => currentSubmissionIdentity(db, task, input.wake.agentId),
    consumption: identity => findSubmissionTurn(db, task, identity),
    continued: () => isContinuedReview(db, task),
    successorActive: async runId => {
      const run = await readRun(db, task.companyId, runId);
      return Boolean(run && ["queued", "running"].includes(run.status) && task.executionRunId === run.id);
    },
    select: identity => selectDecidedReviewSource(db, task, identity),
    hasBlocker: async () => (await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.companyId, task.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
      executionBlockerPredicate(),
    )).limit(1)).length > 0,
    prove: () => proveDecidedReviewContinuation(db, { task }),
  });
}

export async function parkedReviewRequestSubmission(
  db: Db, input: { companyId: string; issueId: string; wakeId: string },
): Promise<{ kind: "superseded" } | { kind: "serves"; submission: SubmissionIdentity } | null> {
  const [wake] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, input.companyId), eq(agentWakeupRequests.id, input.wakeId),
  )).limit(1);
  const [task] = await db.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  if (!wake || !task) return null;
  const payload = evidenceObject(wake.payload);
  const state = readState(task);
  const participant = state?.currentParticipant?.type === "agent" ? state.currentParticipant.agentId ?? null : null;
  const deferredContext = evidenceObject(payload?._paperclipWakeContext);
  const reason = typeof deferredContext?.wakeReason === "string" ? deferredContext.wakeReason : wake.reason;
  const carriesInput = wake.idempotencyKey?.startsWith("chat-inbound:") ||
    ["commentId", "wakeCommentId", "failedRunId", "taskRetryRequestId", "nativeStatusWakeIntentId",
      "interactionId", "interactionKind", "interactionStatus", "continuationPolicy"]
      .some(key => Boolean(payload?.[key] || deferredContext?.[key])) ||
    [payload?.queuedCommentIds, deferredContext?.queuedCommentIds].some(ids => Array.isArray(ids) && ids.length > 0);
  if (classifyDecidedReviewWake({ agentId: wake.agentId, reason, source: wake.source,
    requestedByActorType: wake.requestedByActorType, payload, carriesInput }, participant) !== "W2") return null;
  if (!(await isContinuedReview(db, task))) return null;
  const identity = await currentSubmissionIdentity(db, task, wake.agentId);
  if (!identity) return null;
  return await findSubmissionTurn(db, task, identity) ? { kind: "superseded" } : { kind: "serves", submission: identity };
}

export function buildDecidedReviewContinuationWakeup(input: {
  issueId: string; sourceRunId: string; decisionId: string; resubmissionActivityId: string;
}) {
  return {
    source: "automation" as const,
    triggerDetail: "system" as const,
    reason: REVIEW_REQUEST_REASON,
    payload: {
      issueId: input.issueId,
      decidedReviewContinuation: {
        sourceRunId: input.sourceRunId, decisionId: input.decisionId, resubmissionActivityId: input.resubmissionActivityId,
      },
    },
    requestedByActorType: "system" as const,
    requestedByActorId: "execution-recovery",
    idempotencyKey: `decided-review-continuation:${input.sourceRunId}:${input.decisionId}`,
    contextSnapshot: {
      issueId: input.issueId, taskId: input.issueId, wakeReason: REVIEW_REQUEST_REASON,
      source: "execution.decided_review_continuation",
    },
  };
}

class RestoreNotProved extends Error {}

type Wakeup = (agentId: string, options: ReturnType<typeof buildDecidedReviewContinuationWakeup>) => Promise<unknown>;

function decidedReviewCandidate() {
  return and(
    eq(issueRecoveryActions.cause, LEGACY_RECOVERY_CAUSE),
    or(inArray(issueRecoveryActions.status, ["active", "escalated"]),
      and(eq(issueRecoveryActions.status, "resolved"),
        sql`${issueRecoveryActions.evidence}->'automaticRecovery'->>'replay' = 'blocked'`)),
    sql`not (${issueRecoveryActions.evidence} ? 'decidedReviewContinuation')`,
    inArray(issues.status, ["in_review", "blocked"]),
    sql`${issues.executionState}->>'status' = 'pending'`,
    sql`${issues.executionState}->>'currentStageType' = 'review'`,
    sql`${issues.executionState}->'currentParticipant'->>'type' = 'agent'`,
    sql`${issues.executionState}->>'lastDecisionId' is not null`,
  );
}

async function hasDecidedReviewCandidate(db: Db, task: Pick<Task, "companyId" | "id">) {
  const [row] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).innerJoin(issues, and(
    eq(issues.companyId, issueRecoveryActions.companyId), eq(issues.id, issueRecoveryActions.sourceIssueId),
  )).where(and(eq(issues.companyId, task.companyId), eq(issues.id, task.id), decidedReviewCandidate())).limit(1);
  return Boolean(row);
}

const SCAN_PAGE = 25;
const SETTLING = new Set(["P2_process_running", "P2_lease_unreleased", "P6_execution_active"]);
export const DECIDED_REVIEW_SETTLE_RETRIES = 20;
export type DecidedReviewScan = {
  after: { companyId: string; issueId: string } | null;
  settling: Map<string, number>;
  visited?: Set<string>;
};
const defaultScan: DecidedReviewScan = { after: null, settling: new Map() };

export function decidedReviewRetryPending(scan: DecidedReviewScan = defaultScan) {
  return scan.after !== null || [...scan.settling.values()].some(attempts => attempts < DECIDED_REVIEW_SETTLE_RETRIES);
}

export async function continueDecidedReviewReassignments(db: Db, wakeup: Wakeup, scan: DecidedReviewScan = defaultScan) {
  const after = scan.after;
  if (!after || !scan.visited) scan.visited = new Set();
  const visited = scan.visited;
  const candidates = await db.selectDistinct({
    companyId: issueRecoveryActions.companyId, issueId: issueRecoveryActions.sourceIssueId,
  })
    .from(issueRecoveryActions).innerJoin(issues, and(
      eq(issues.companyId, issueRecoveryActions.companyId), eq(issues.id, issueRecoveryActions.sourceIssueId),
    )).where(and(
      decidedReviewCandidate(),
      after ? sql`(${issueRecoveryActions.companyId}, ${issueRecoveryActions.sourceIssueId}) > (${after.companyId}, ${after.issueId})` : undefined,
    )).orderBy(asc(issueRecoveryActions.companyId), asc(issueRecoveryActions.sourceIssueId)).limit(SCAN_PAGE);
  const last = candidates[candidates.length - 1];
  scan.after = candidates.length === SCAN_PAGE && last ? { companyId: last.companyId, issueId: last.issueId } : null;
  let woken = 0;
  for (const candidate of candidates) {
    const key = `${candidate.companyId}:${candidate.issueId}`;
    visited.add(key);
    let held: string | null = null;
    const proved = await db.transaction(async tx => {
      const [task] = await tx.select().from(issues).where(and(
        eq(issues.companyId, candidate.companyId), eq(issues.id, candidate.issueId),
      )).for("update");
      if (!task) return null;
      let proof = await proveDecidedReviewContinuation(tx as unknown as Db, { task });
      if (proof.kind !== "proved") { held = proof.reason; return null; }
      if (proof.shape === "blocked_projection") {
        await issueService(tx as unknown as Db).update(task.id, { status: "in_review" }, tx);
        await persistActivity(tx as unknown as Db, {
          companyId: task.companyId, actorType: "system", actorId: "execution-recovery",
          action: "issue.updated", entityType: "issue", entityId: task.id,
          agentId: proof.source.agentId, runId: proof.source.id,
          details: { status: "in_review", _previous: { status: task.status }, source: "decided_review_continuation",
            decisionId: proof.decisionId, resubmissionActivityId: proof.resubmissionActivityId },
        });
        const [restored] = await tx.select().from(issues).where(and(
          eq(issues.companyId, task.companyId), eq(issues.id, task.id),
        ));
        proof = await proveDecidedReviewContinuation(tx as unknown as Db, { task: restored! });
        if (proof.kind !== "proved" || proof.shape !== "in_review") throw new RestoreNotProved();
      }
      return proof;
    }).catch(error => {
      if (error instanceof RestoreNotProved) return null;
      throw error;
    });
    if (held && SETTLING.has(held)) scan.settling.set(key, (scan.settling.get(key) ?? 0) + 1);
    else scan.settling.delete(key);
    if (!proved) continue;
    await wakeup(proved.source.agentId, buildDecidedReviewContinuationWakeup({
      issueId: proved.task.id, sourceRunId: proved.source.id,
      decisionId: proved.decisionId, resubmissionActivityId: proved.resubmissionActivityId,
    }));
    woken += 1;
  }
  if (scan.after === null) {
    for (const key of scan.settling.keys()) if (!visited.has(key)) scan.settling.delete(key);
  }
  return { scanned: candidates.length, woken };
}

export async function decidedReviewHoldIsRedundant(db: Db, task: Task, run: Pick<Run, "id" | "agentId">) {
  const [admitted] = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.companyId, task.companyId), eq(issueRecoveryActions.sourceIssueId, task.id),
    or(
      sql`${issueRecoveryActions.evidence}->'decidedReviewContinuation'->>'sourceRunId' = ${run.id}`,
      sql`${issueRecoveryActions.evidence}->'decidedReviewContinuation'->'chainRunIds' @> ${JSON.stringify([run.id])}::jsonb`,
    ),
  )).limit(1);
  if (admitted) return true;
  const state = readState(task);
  if (!["in_review", "blocked"].includes(task.status) || state?.status !== "pending" ||
      state.currentStageType !== "review" || state.currentParticipant?.type !== "agent" ||
      state.currentParticipant.agentId !== run.agentId || !state.lastDecisionId) return false;
  const selected = await selectDecidedReviewSource(db, task);
  if (selected.kind === "none") return false;
  if (selected.chain.some(attempt => attempt.id === run.id)) {
    return selected.holds.some(hold => hold.evidence.runId === selected.source.id) &&
      !(await provesDecidedReviewProvenance(db, task, selected));
  }
  return selected.source.id === run.id && (await proveDecidedReviewContinuation(db, { task })).kind === "proved";
}
