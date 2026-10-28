import { connectionContinuationPendingResponse } from "../satisfied-connection-intents.js";
import { authorizationService, type AuthorizationActor, type AuthorizationResource } from "../authorization.js";
import { z } from "zod";
import { and, asc, eq, inArray, isNull, lte, not, sql } from "drizzle-orm";
import { agentWakeupRequests, companies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../delivery-work-notifications.js";
import { hasRecordedRunExecutionRelease } from "./case-handoff-lifecycle.js";
import { getExecutionBlocker } from "../execution-blocker.js";
import type { WakeupOptions } from "./run-preparation.js";
import { issueExecutionGeneration as reviewerAssignmentGeneration, parseIssueExecutionState } from "../issue-execution-policy.js";
import { ordinaryWakeRequestPredicate } from "../../modules/wake-queue/receipt-namespace.js";

type IntentDb = Pick<Db, "select" | "insert" | "update" | "execute">;
const KEY = "_paperclipReviewerAssignmentContinuation";
type Receipt = typeof agentWakeupRequests.$inferSelect;
type Task = Pick<typeof issues.$inferSelect, "executionPolicy" | "executionState" | "assigneeAgentId" | "assigneeUserId" | "responsibleUserId">;

export async function lockReviewerIntentCompany(tx: IntentDb, companyId: string) {
  const [company] = await tx.select({ status: companies.status }).from(companies)
    .where(eq(companies.id, companyId)).for("share");
  return company?.status ?? null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}

export { issueExecutionGeneration as reviewerAssignmentGeneration } from "../issue-execution-policy.js";

const identitySchema = z.object({ companyId: z.uuid(), issueId: z.uuid(), reviewerId: z.uuid(), sourceRunId: z.uuid(),
  contextSnapshot: z.record(z.string(), z.unknown()),
  generation: z.string().regex(/^[a-f0-9]{64}$/), actorType: z.enum(["agent", "user", "system"]), actorId: z.string().min(1) });
const recordSchema = z.object({ version: z.literal(1), immutable: identitySchema,
  attempt: z.number().int().min(0).max(5), nextAttemptAt: z.number().int().min(0).max(8_640_000_000_000_000), lastHold: z.string().optional() });
type Intent = z.infer<typeof recordSchema>;

function readIntent(row: Receipt): Intent | null {
  const parsed = recordSchema.safeParse(row.payload?.[KEY]);
  if (!parsed.success) return null;
  const intent = parsed.data, id = intent.immutable;
  return row.companyId === id.companyId && row.agentId === id.reviewerId && row.payload?.issueId === id.issueId &&
    row.source === "assignment" && row.triggerDetail === "system" && row.reason === "execution_review_requested" &&
    id.contextSnapshot.issueId === id.issueId && id.contextSnapshot.interruptedRunId === id.sourceRunId &&
    row.requestedByActorType === id.actorType && row.requestedByActorId === id.actorId ? intent : null;
}

function pending(task: Task) {
  const state = parseIssueExecutionState(task.executionState);
  return state?.status === "pending" && state.currentStageType === "review" && state.currentParticipant?.type === "agent" &&
    state.currentParticipant.agentId === task.assigneeAgentId && task.assigneeUserId === null ? state : null;
}

function stageContext(task: Task) {
  const state = pending(task)!;
  return { stageId: state.currentStageId, stageType: "review", wakeRole: "reviewer",
    currentParticipant: state.currentParticipant, returnAssignee: state.returnAssignee, reviewRequest: state.reviewRequest ?? null,
    lastDecisionOutcome: state.lastDecisionOutcome, allowedActions: ["approve", "request_changes"] };
}

function sourceMatches(source: typeof heartbeatRuns.$inferSelect, task: typeof issues.$inferSelect) {
  const state = pending(task);
  return state?.returnAssignee?.type === "agent" && source.agentId === state.returnAssignee.agentId &&
    (source.nativeIssueId === task.id || source.contextSnapshot?.issueId === task.id) &&
    (source.nativeIssueId === null || source.nativeIssueId === task.id) &&
    (source.contextSnapshot?.issueId === undefined || source.contextSnapshot.issueId === task.id);
}

export async function createReviewerAssignmentIntent(tx: IntentDb, input: {
  companyId: string; issueId: string; sourceRunId: string;
  requestedByActorType: "agent" | "user" | "system"; requestedByActorId: string;
}) {
  const company = await lockReviewerIntentCompany(tx, input.companyId);
  if (!company || company === "archived") return null;
  const [task] = await tx.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
  const state = task && pending(task);
  const [source] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.sourceRunId)));
  if (!task || task.status !== "in_review" || !state || !source ||
      !sourceMatches(source, task) ||
      (input.requestedByActorType === "agent" && input.requestedByActorId !== source.agentId) ||
      (input.requestedByActorType === "user" && input.requestedByActorId !== task.responsibleUserId)) return null;
  const generation = reviewerAssignmentGeneration(task);
  const [existing] = await tx.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, task.companyId), sql`${agentWakeupRequests.payload}->>'issueId' = ${task.id}`,
    sql`${agentWakeupRequests.payload}->${KEY}->'immutable'->>'generation' = ${generation}`,
    inArray(agentWakeupRequests.status, ["deferred_issue_execution", "coalesced"]),
  )).orderBy(asc(agentWakeupRequests.createdAt)).limit(1);
  if (existing && readIntent(existing)) return existing;
  const now = new Date();
  const intent: Intent = { version: 1, immutable: { companyId: task.companyId, issueId: task.id,
    reviewerId: task.assigneeAgentId!, sourceRunId: source.id, generation,
    actorType: input.requestedByActorType, actorId: input.requestedByActorId,
    contextSnapshot: { issueId: task.id, taskId: task.id, wakeReason: "execution_review_requested", source: "issue.execution_stage",
      executionStage: stageContext(task), interruptedRunId: source.id } }, attempt: 0, nextAttemptAt: now.getTime() };
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.executionContinuation, task.id);
  const [receipt] = await tx.insert(agentWakeupRequests).values({ companyId: task.companyId, agentId: task.assigneeAgentId!,
    source: "assignment", triggerDetail: "system", reason: "execution_review_requested", status: "deferred_issue_execution",
    requestedByActorType: input.requestedByActorType, requestedByActorId: input.requestedByActorId,
    payload: { issueId: task.id, executionStage: stageContext(task), interruptedRunId: source.id, [KEY]: intent }, requestedAt: now, createdAt: now }).returning();
  return receipt;
}

export async function produceReviewerAssignmentTransition(tx: IntentDb, before: Task, after: typeof issues.$inferSelect,
  input: { sourceRunId: string | null; actorType: "agent" | "user" | "system"; actorId: string }) {
  const next = pending(after), previous = pending(before);
  if (!next || !input.sourceRunId || (previous?.currentStageId === next.currentStageId &&
      canonical(previous.currentParticipant) === canonical(next.currentParticipant))) return null;
  return createReviewerAssignmentIntent(tx, { companyId: after.companyId, issueId: after.id,
    sourceRunId: input.sourceRunId, requestedByActorType: input.actorType, requestedByActorId: input.actorId });
}

export async function hasPendingReviewerAssignment(tx: IntentDb, task: typeof issues.$inferSelect) {
  const [row] = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(unfinished(),
    eq(agentWakeupRequests.companyId, task.companyId), sql`${agentWakeupRequests.payload}->>'issueId' = ${task.id}`,
    sql`${agentWakeupRequests.payload}->${KEY}->'immutable'->>'generation' = ${reviewerAssignmentGeneration(task)}`)).limit(1);
  return Boolean(row);
}

function unfinished() {
  return and(not(ordinaryWakeRequestPredicate()), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    isNull(agentWakeupRequests.runId), isNull(agentWakeupRequests.finishedAt));
}

async function retire(tx: IntentDb, row: Receipt, reason: string) {
  await tx.update(agentWakeupRequests).set({ status: "cancelled", error: reason, finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(agentWakeupRequests.companyId, row.companyId), eq(agentWakeupRequests.id, row.id), unfinished()));
}

async function hold(tx: IntentDb, row: Receipt, intent: Intent, reason: string) {
  const now = new Date();
  const next: Intent = { ...intent, attempt: Math.min(intent.attempt + 1, 5),
    nextAttemptAt: now.getTime() + Math.min(15_000 * 2 ** intent.attempt, 300_000), lastHold: reason };
  await tx.update(agentWakeupRequests).set({ payload: { ...row.payload, [KEY]: next }, error: reason, updatedAt: now })
    .where(and(eq(agentWakeupRequests.companyId, row.companyId), eq(agentWakeupRequests.id, row.id), unfinished()));
}

function nextAttempt() {
  const at = sql`${agentWakeupRequests.payload}->${KEY}->'nextAttemptAt'`;
  return sql`case when jsonb_typeof(${at}) = 'number'
    and ${agentWakeupRequests.payload}->${KEY}->>'version' = '1'
    then case when (${at})::numeric between 0 and 8640000000000000 and mod((${at})::numeric, 1) = 0
      then (${at})::numeric else 0 end else 0 end`;
}

export async function reviewerAssignmentNext(db: IntentDb) {
  const [row] = await db.select({ at: sql<string | null>`min(${nextAttempt()})` })
    .from(agentWakeupRequests).where(unfinished());
  return row?.at == null ? null : Number(row.at);
}

async function lockIntent(tx: IntentDb, candidate: Receipt) {
  const company = await lockReviewerIntentCompany(tx, candidate.companyId);
  const initial = readIntent(candidate);
  if (initial) await tx.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, candidate.companyId), eq(issues.id, initial.immutable.issueId))).for("update");
  const [row] = await tx.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, candidate.companyId), eq(agentWakeupRequests.id, candidate.id), unfinished())).for("update");
  return { company, row };
}

export async function admitReviewerIntent(tx: Db, candidate: Receipt) {
  const { company, row } = await lockIntent(tx, candidate);
  if (!row) return null;
  const intent = readIntent(row);
  if (!intent) { await retire(tx, row, "invalid reviewer intent"); return null; }
  if (intent.nextAttemptAt > Date.now()) return null;
  const id = intent.immutable;
  const [task] = await tx.select().from(issues).where(and(eq(issues.companyId, row.companyId), eq(issues.id, id.issueId)));
  const [source] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, row.companyId), eq(heartbeatRuns.id, id.sourceRunId)));
  if (!task || !pending(task) || ["done", "cancelled"].includes(task.status) || reviewerAssignmentGeneration(task) !== id.generation ||
      !source || !sourceMatches(source, task) ||
      canonical(id.contextSnapshot.executionStage) !== canonical(stageContext(task)) ||
      (id.actorType === "agent" && source.agentId !== id.actorId) ||
      (id.actorType === "user" && task.responsibleUserId !== id.actorId)) {
    await retire(tx, row, "reviewer intent generation or source superseded"); return null;
  }
  if (company === "archived") { await retire(tx, row, "Company archived"); return null; }
  if (company !== "active") { await hold(tx, row, intent, "company_inactive"); return null; }
  if (task.responsibleUserId === null) { await hold(tx, row, intent, "identity_initialization_pending"); return null; }
  const access = authorizationService(tx);
  const actors: AuthorizationActor[] = [{ type: "agent", agentId: row.agentId, companyId: row.companyId,
    onBehalfOfUserId: task.responsibleUserId, source: "agent_key" }];
  if (id.actorType === "agent") actors.push({ type: "agent", agentId: id.actorId, companyId: row.companyId,
    onBehalfOfUserId: task.responsibleUserId, source: "agent_key" });
  if (id.actorType === "user") actors.push({ type: "board", userId: id.actorId, source: "session", ignoreInstanceAdmin: true });
  const resources: AuthorizationResource[] = [{ type: "issue", companyId: row.companyId, issueId: task.id }];
  if (task.projectId) resources.push({ type: "project", companyId: row.companyId, projectId: task.projectId });
  for (const actor of actors) {
    for (const resource of resources) {
      const decision = await access.decide({ actor, action: resource.type === "project" ? "project:read" : "issue:read", resource });
      if (!decision.allowed) { await hold(tx, row, intent, decision.code ?? decision.reason); return null; }
    }
  }
  const response = await connectionContinuationPendingResponse(tx, task, task.responsibleUserId, null);
  if (response) { await hold(tx, row, intent, `pending_${response}`); return null; }
  const [successor] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, row.companyId),
    eq(heartbeatRuns.agentId, row.agentId), inArray(heartbeatRuns.status, ["queued", "running", "scheduled_retry"]),
    sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${task.id}`,
    sql`${heartbeatRuns.contextSnapshot}->>'reviewerAssignmentGeneration' = ${id.generation}`,
  )).orderBy(asc(heartbeatRuns.createdAt), asc(heartbeatRuns.id)).limit(1);
  if (successor) return { row, intent, task, successor };
  if (!await hasRecordedRunExecutionRelease(tx, source, task.id) ||
      await getExecutionBlocker(tx, row.companyId, task.id)) {
    await hold(tx, row, intent, "execution_not_released"); return null;
  }
  return { row, intent, task, successor: null };
}

export async function consumeReviewerIntent(tx: Db, candidate: Receipt, run: typeof heartbeatRuns.$inferSelect) {
  await tx.update(agentWakeupRequests).set({ status: "coalesced", runId: run.id,
    finishedAt: new Date(), updatedAt: new Date(), error: null }).where(and(
      eq(agentWakeupRequests.companyId, candidate.companyId), eq(agentWakeupRequests.id, candidate.id), unfinished()));
}

export async function reconcileReviewerAssignments(db: Db, admit: (row: Receipt, opts: WakeupOptions) => Promise<unknown>) {
  const rows = await db.select().from(agentWakeupRequests).where(and(unfinished(), lte(nextAttempt(), Date.now())))
    .orderBy(asc(nextAttempt()), asc(agentWakeupRequests.createdAt), asc(agentWakeupRequests.id)).limit(50);
  for (const row of rows) {
    const initial = readIntent(row);
    if (initial && initial.nextAttemptAt > Date.now()) continue;
    const selected = await db.transaction(tx => admitReviewerIntent(tx as unknown as Db, row));
    if (!selected) continue;
    let failure = "admission_held";
    try {
      const payload = { ...selected.row.payload };
      delete payload[KEY];
      await admit(selected.row, { source: "assignment", triggerDetail: "system", reason: selected.row.reason,
        requestedByActorType: selected.intent.immutable.actorType, requestedByActorId: selected.row.requestedByActorId,
        payload,
        contextSnapshot: selected.intent.immutable.contextSnapshot,
        idempotencyKey: `review-assignment-continuation:${selected.row.id}`, allowRunCoalescing: false });
    } catch (error) { failure = String(error).slice(0, 512); }
    await db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      const current = await admitReviewerIntent(tx, row);
      if (current) await hold(tx, current.row, current.intent, failure);
    });
  }
}

type RetirementScope = { companyId: string; reason: string } & (
  | { issueId: string; agentIds?: never }
  | { issueId?: never; agentIds: string[] }
  | { issueId?: never; agentIds?: never }
);

export async function retireReviewerIntents(tx: Db, scope: RetirementScope) {
  if (scope.agentIds?.length === 0) return [];
  const now = new Date();
  return tx.update(agentWakeupRequests).set({
    status: "cancelled", error: scope.reason, finishedAt: now, updatedAt: now,
  }).where(and(
    eq(agentWakeupRequests.companyId, scope.companyId),
    not(ordinaryWakeRequestPredicate()),
    inArray(agentWakeupRequests.status, ["queued", "deferred_issue_execution", "claimed"]),
    isNull(agentWakeupRequests.runId),
    scope.issueId ? sql`${agentWakeupRequests.payload}->>'issueId' = ${scope.issueId}` : undefined,
    scope.agentIds ? inArray(agentWakeupRequests.agentId, scope.agentIds) : undefined,
  )).returning({ id: agentWakeupRequests.id });
}
