import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, exists, inArray, isNotNull, isNull, like, sql } from "drizzle-orm";
import { agents, companies, heartbeatRuns, agentWakeupRequests, issues, statusDecisionEffects, statusDecisions, type Db } from "@paperclipai/db";
import { ordinaryWakeRequestPredicate } from "../../modules/wake-queue/receipt-namespace.js";
import { evaluateAgentInvokability } from "../agent-invokability.js";
import { isAgentAwaitingSetup } from "../../modules/agent-lifecycle/index.js";
import { isHeartbeatWakeOnDemandEnabled } from "../heartbeat-policy.js";
import { parseIssueExecutionState } from "../issue-execution-policy.js";
import { observeInvocationBudgetBlock } from "../budgets.js";
import { getExecutionBlocker } from "../execution-blocker.js";
import { issueService } from "../issues.js";
import { issueTreeControlService } from "../issue-tree-control.js";
import { authorizationService, type AuthorizationResource } from "../authorization.js";

type Wake = typeof agentWakeupRequests.$inferSelect;
const markerKey = "_paperclipDependencyAdmission";
const terminalRunStatuses = ["succeeded", "failed", "cancelled", "timed_out", "interrupted"];

export function pendingDependencyReceiptResults(db: Db) {
  return and(eq(agentWakeupRequests.reason, "issue_blockers_resolved"),
    like(agentWakeupRequests.requestedByActorId, "native-status-wake-dispatch:%"),
    inArray(agentWakeupRequests.status, ["queued", "claimed", "deferred_issue_execution"]),
    isNotNull(agentWakeupRequests.runId), exists(db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, agentWakeupRequests.runId), eq(heartbeatRuns.companyId, agentWakeupRequests.companyId),
      eq(heartbeatRuns.agentId, agentWakeupRequests.agentId), inArray(heartbeatRuns.status, terminalRunStatuses)))));
}

type Reservation = {
  version: 1;
  receiptId: string;
  companyId: string;
  agentId: string;
  issueId: string;
  intentId: string;
  effectId: string;
  idempotencyKey: string | null;
  triggerDetail: string | null;
  inputPayload: Record<string, unknown>;
};

export type DependencyClaim = { intent: Wake; reservation: Reservation; receipt: Wake | null };
export type DependencyOutcome =
  | { kind: "admitted"; runId: string }
  | { kind: "waiting"; gate: string }
  | { kind: "retired"; reason: string }
  | { kind: "retryableFailure"; error: string };

type Eligibility = { kind: "eligible" } | Extract<DependencyOutcome, { kind: "waiting" | "retired" }>;

export class DependencyAdmissionHeld extends Error {
  constructor(readonly gate: string) { super(gate); }
}

function isNativeDependencyIntent(row: Wake) {
  return row.reason === "issue_blockers_resolved" && row.source === "automation"
    && row.requestedByActorType === "system" && row.requestedByActorId === "native-status-committer";
}

function inputPayload(row: Wake) {
  const payload = { ...row.payload };
  delete payload[markerKey];
  return payload;
}

function reservation(row: Wake): Reservation | null {
  const value = row.payload?.[markerKey] as Reservation | undefined;
  return value?.version === 1 && value.intentId === row.id && value.companyId === row.companyId
    && value.agentId === row.agentId && value.issueId === row.payload?.issueId
    && value.idempotencyKey === row.idempotencyKey && value.triggerDetail === row.triggerDetail
    && typeof value.receiptId === "string" && typeof value.effectId === "string"
    && isDeepStrictEqual(value.inputPayload, inputPayload(row)) ? value : null;
}

function observed(row: Wake) {
  return and(ordinaryWakeRequestPredicate(), eq(agentWakeupRequests.id, row.id),
    eq(agentWakeupRequests.companyId, row.companyId), eq(agentWakeupRequests.agentId, row.agentId),
    eq(agentWakeupRequests.source, row.source),
    sql`${agentWakeupRequests.reason} is not distinct from ${row.reason}`,
    sql`${agentWakeupRequests.idempotencyKey} is not distinct from ${row.idempotencyKey}`,
    sql`${agentWakeupRequests.triggerDetail} is not distinct from ${row.triggerDetail}`,
    sql`${agentWakeupRequests.requestedByActorType} is not distinct from ${row.requestedByActorType}`,
    sql`${agentWakeupRequests.requestedByActorId} is not distinct from ${row.requestedByActorId}`,
    eq(agentWakeupRequests.status, row.status), row.runId ? eq(agentWakeupRequests.runId, row.runId) : isNull(agentWakeupRequests.runId),
    row.claimedAt ? eq(agentWakeupRequests.claimedAt, row.claimedAt) : isNull(agentWakeupRequests.claimedAt),
    sql`${agentWakeupRequests.payload} = ${JSON.stringify(row.payload)}::jsonb`);
}

async function provenance(db: Db, row: Wake) {
  if (!isNativeDependencyIntent(row) || typeof row.payload?.issueId !== "string") return null;
  const effects = await db.select({ id: statusDecisionEffects.id }).from(statusDecisionEffects)
    .innerJoin(statusDecisions, and(eq(statusDecisions.id, statusDecisionEffects.decisionId),
      eq(statusDecisions.companyId, row.companyId), eq(statusDecisions.applicationState, "applied")))
    .where(and(eq(statusDecisionEffects.companyId, row.companyId),
      eq(statusDecisionEffects.effectKind, "dependency_wake"), eq(statusDecisionEffects.targetType, "agent_wakeup_request"),
      eq(statusDecisionEffects.targetId, row.id),
      reservation(row) ? eq(statusDecisionEffects.id, reservation(row)!.effectId) : undefined,
      sql`${statusDecisionEffects.payload}->>'dependentIssueId' = ${row.payload.issueId}`,
      sql`${statusDecisionEffects.payload}->>'resolvedBlockerIssueId' = ${row.payload.resolvedBlockerIssueId}`,
      sql`${statusDecisionEffects.issueId}::text = ${row.payload.resolvedBlockerIssueId}`))
    .orderBy(asc(statusDecisionEffects.createdAt), asc(statusDecisionEffects.id)).limit(1);
  return effects[0] ?? null;
}

function matchesReceipt(row: Wake, intent: Wake, binding: Reservation) {
  if (row.id !== binding.receiptId || row.companyId !== intent.companyId || row.agentId !== intent.agentId
    || row.source !== intent.source || row.reason !== intent.reason || row.triggerDetail !== intent.triggerDetail
    || row.idempotencyKey !== intent.idempotencyKey || row.requestedByActorType !== "system"
    || row.requestedByActorId !== `native-status-wake-dispatch:${intent.id}`
    || (row.payload?._paperclipWakeContext as Record<string, unknown> | undefined)?.nativeStatusWakeIntentId !== intent.id) return false;
  return Object.entries(binding.inputPayload).every(([key, value]) => key === "_paperclipWakeContext"
    ? Object.entries(value as Record<string, unknown>).every(([name, field]) =>
        isDeepStrictEqual((row.payload?.[key] as Record<string, unknown> | undefined)?.[name], field))
    : isDeepStrictEqual(row.payload?.[key], value));
}

function matchesRun(run: typeof heartbeatRuns.$inferSelect, receipt: Wake, binding: Reservation) {
  return run.id === receipt.runId && run.wakeupRequestId === receipt.id
    && run.companyId === binding.companyId && run.agentId === binding.agentId
    && run.contextSnapshot?.issueId === binding.issueId
    && (run.nativeIssueId === null || run.nativeIssueId === binding.issueId)
    && (run.scopeKind === "issue" ? run.issueId === binding.issueId : run.issueId === null);
}

export function createDependencyAdmission(db: Db, schedulingGate: () => Promise<string | null>,
  policyGate: (queryDb: Db, agent: typeof agents.$inferSelect) => Promise<string | null>) {
  async function inspect(queryDb: Db, row: Wake): Promise<Eligibility> {
    const [company] = await queryDb.select().from(companies).where(eq(companies.id, row.companyId));
    const [target] = await queryDb.select().from(issues).where(and(eq(issues.companyId, row.companyId),
      sql`${issues.id}::text = ${row.payload?.issueId}`));
    const companyAgents = await queryDb.select().from(agents).where(eq(agents.companyId, row.companyId));
    const agent = companyAgents.find(value => value.id === row.agentId);
    if (!company || company.status === "archived" || !target || !agent || agent.status === "terminated"
      || target.assigneeAgentId !== row.agentId || ["done", "cancelled"].includes(target.status))
      return { kind: "retired", reason: "Dependency target is no longer eligible" };
    const scheduling = await schedulingGate();
    if (scheduling) return { kind: "waiting", gate: scheduling };
    if (company.status !== "active") return { kind: "waiting", gate: "company_pause" };
    if (isAgentAwaitingSetup(agent)) return { kind: "waiting", gate: "agent_setup" };
    if (!evaluateAgentInvokability(agent, companyAgents).invokable) return { kind: "waiting", gate: "agent_invokability" };
    if (!isHeartbeatWakeOnDemandEnabled(agent)) return { kind: "waiting", gate: "wake_policy" };
    const policyBlock = await policyGate(queryDb, agent);
    if (policyBlock) return { kind: "waiting", gate: policyBlock };
    if (await observeInvocationBudgetBlock(queryDb, { companyId: row.companyId, agentId: row.agentId, projectId: target.projectId }))
      return { kind: "waiting", gate: "budget" };
    if (!target.responsibleUserId) return { kind: "waiting", gate: "responsible_user_unresolved" };
    const access = authorizationService(queryDb);
    const actor = { type: "agent" as const, agentId: row.agentId, companyId: row.companyId,
      onBehalfOfUserId: target.responsibleUserId, source: "agent_key" as const };
    const resources: AuthorizationResource[] = [{ type: "issue", companyId: row.companyId, issueId: target.id }];
    if (target.projectId) resources.push({ type: "project", companyId: row.companyId, projectId: target.projectId });
    for (const resource of resources) {
      const decision = await access.decide({ actor, resource, action: resource.type === "issue" ? "issue:read" : "project:read" });
      if (!decision.allowed) return { kind: "waiting", gate: "responsible_user_authority" };
    }
    if (parseIssueExecutionState(target.executionState)?.status === "pending") return { kind: "waiting", gate: "review" };
    if (target.checkoutRunId) return { kind: "waiting", gate: "checkout" };
    if ((await issueService(queryDb).listDependencyReadiness(row.companyId, [target.id])).get(target.id)?.isDependencyReady === false)
      return { kind: "waiting", gate: "dependency" };
    if (await issueTreeControlService(queryDb).getActivePauseHoldGate(row.companyId, target.id))
      return { kind: "waiting", gate: "subtree_pause" };
    if (await getExecutionBlocker(queryDb, row.companyId, target.id)) return { kind: "waiting", gate: "execution_recovery" };
    const [active] = await queryDb.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, row.companyId), sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${target.id}`,
      sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`)).limit(1);
    return active ? { kind: "waiting", gate: "active_execution" } : { kind: "eligible" };
  }

  async function lockInput(tx: Db, row: Wake) {
    await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, row.companyId)).for("share");
    await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, row.companyId), eq(agents.id, row.agentId))).for("share");
    await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, row.companyId),
      sql`${issues.id}::text = ${row.payload?.issueId}`)).for("update");
    return tx.select().from(agentWakeupRequests).where(observed(row)).for("update").then(rows => rows[0] ?? null);
  }

  async function receiptFor(tx: Db, row: Wake, binding: Reservation) {
    const [receipt] = await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, binding.receiptId));
    if (receipt && !matchesReceipt(receipt, row, binding)) throw new Error("Dependency receipt binding conflicts with durable input");
    if (receipt?.runId) {
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, row.companyId),
        eq(heartbeatRuns.agentId, row.agentId), eq(heartbeatRuns.id, receipt.runId)));
      if (!run || !matchesRun(run, receipt, binding))
        throw new Error("Dependency receipt run binding conflicts with durable input");
    }
    return receipt ?? null;
  }

  async function prepare(row: Wake, staleClaimMs: number): Promise<DependencyClaim | null> {
    if (row.status === "claimed" && row.claimedAt && Date.now() - row.claimedAt.getTime() < staleClaimMs) return null;
    const observation = await inspect(db, row);
    const reserved = reservation(row);
    if (observation.kind === "waiting" && reserved && ["deferred_issue_execution", "coalesced"].includes(row.status)
      && !(await receiptFor(db, row, reserved))?.runId) return null;
    return db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      const current = await lockInput(tx, row);
      const origin = current && await provenance(tx, current);
      if (!current || !origin) return null;
      if (current.status === "skipped" && reservation(current)) return null;
      if (current.status === "claimed" && current.claimedAt
        && Date.now() - current.claimedAt.getTime() < staleClaimMs) return null;
      let binding = reservation(current);
      if (current.payload?.[markerKey] && !binding) throw new Error("Dependency reservation binding conflicts with durable input");
      if (!binding) {
        const legacy = await tx.select().from(agentWakeupRequests).where(and(ordinaryWakeRequestPredicate(),
          eq(agentWakeupRequests.companyId, current.companyId), eq(agentWakeupRequests.requestedByActorType, "system"),
          eq(agentWakeupRequests.requestedByActorId, `native-status-wake-dispatch:${current.id}`))).limit(2);
        if (legacy.length > 1) throw new Error("Ambiguous legacy dependency receipts require repair");
        binding = { version: 1, receiptId: legacy[0]?.id ?? randomUUID(), companyId: current.companyId,
          agentId: current.agentId, issueId: String(current.payload!.issueId), intentId: current.id,
          effectId: origin.id, inputPayload: inputPayload(current), idempotencyKey: current.idempotencyKey,
          triggerDetail: current.triggerDetail };
        const previous = legacy[0];
        if (current.status === "skipped" && !previous) throw new Error("Unbound skipped dependency input requires repair");
        if (previous && !matchesReceipt(previous, current, binding)) {
          const wait = previous.payload?.executionWait as Record<string, unknown> | undefined;
          const reversible = previous.reason === "budget.blocked" && ["company", "agent", "project"].includes(String(wait?.scopeType))
            || previous.reason === "agent.not_invokable" && wait?.status === "paused" && wait.reason === "paused";
          const normalized = { ...previous, reason: current.reason, idempotencyKey: current.idempotencyKey };
          if (previous.runId || previous.status !== "skipped" || !reversible
            || wait?.requestedIdempotencyKey !== current.idempotencyKey || !matchesReceipt(normalized, current, binding))
            throw new Error("Legacy dependency receipt binding conflicts with durable input");
          await tx.update(agentWakeupRequests).set({ reason: current.reason, idempotencyKey: current.idempotencyKey,
            status: "deferred_issue_execution", finishedAt: null, updatedAt: new Date() }).where(observed(previous));
        }
      }
      const receipt = await receiptFor(tx, current, binding);
      if (receipt?.runId) {
        await tx.update(agentWakeupRequests).set({ status: "completed", runId: receipt.runId,
          payload: { ...current.payload, [markerKey]: binding }, finishedAt: receipt.finishedAt ?? new Date(), updatedAt: new Date() })
          .where(observed(current));
        return null;
      }
      if (receipt && receipt.status !== "deferred_issue_execution") throw new Error("Dependency receipt without a run requires explicit repair");
      const eligibility = await inspect(tx, current);
      if (eligibility.kind === "retired") {
        if (receipt) await tx.update(agentWakeupRequests).set({ status: "skipped", error: eligibility.reason,
          finishedAt: new Date(), updatedAt: new Date() }).where(observed(receipt));
        await tx.update(agentWakeupRequests).set({ status: "skipped", error: eligibility.reason,
          payload: { ...current.payload, [markerKey]: binding }, finishedAt: new Date(), updatedAt: new Date() }).where(observed(current));
        return null;
      }
      if (eligibility.kind === "waiting") {
        const status = receipt ? "coalesced" : "deferred_issue_execution";
        if (current.status !== status || !reservation(current)) {
          await tx.update(agentWakeupRequests).set({ status,
            payload: { ...current.payload, [markerKey]: binding }, error: eligibility.gate, updatedAt: new Date() }).where(observed(current));
        }
        return null;
      }
      const [claimed] = await tx.update(agentWakeupRequests).set({ status: "claimed",
        claimedAt: sql`greatest(date_trunc('milliseconds', clock_timestamp()), coalesce(${agentWakeupRequests.claimedAt} + interval '1 millisecond', '-infinity'::timestamptz))`,
        payload: { ...current.payload, [markerKey]: binding }, error: null, updatedAt: new Date() })
        .where(observed(current)).returning();
      return claimed ? { intent: claimed, reservation: binding, receipt } : null;
    });
  }

  async function authorize(tx: Db, claim: DependencyClaim) {
    const current = await lockInput(tx, claim.intent);
    const origin = current && await provenance(tx, current);
    if (!current || current.status !== "claimed" || origin?.id !== claim.reservation.effectId
      || !isDeepStrictEqual(reservation(current), claim.reservation)) throw new DependencyAdmissionHeld("claim_superseded");
    return receiptFor(tx, current, claim.reservation);
  }

  async function settle(tx: Db, claim: DependencyClaim, outcome: DependencyOutcome) {
    const receipt = await authorize(tx, claim);
    const runId = receipt?.runId ?? (outcome.kind === "admitted" ? outcome.runId : null);
    await tx.update(agentWakeupRequests).set({
      status: runId ? "completed" : receipt?.status === "deferred_issue_execution" ? "coalesced"
        : outcome.kind === "retired" ? "skipped" : outcome.kind === "retryableFailure" ? "queued" : "deferred_issue_execution",
      runId, finishedAt: runId || outcome.kind === "retired" ? new Date() : null,
      error: outcome.kind === "waiting" ? outcome.gate : outcome.kind === "retired" ? outcome.reason
        : outcome.kind === "retryableFailure" ? outcome.error.slice(0, 1000) : null,
      updatedAt: new Date(),
    }).where(observed(claim.intent));
  }

  async function promoteReceipt(tx: Db, claim: DependencyClaim, receipt: Wake) {
    await authorize(tx, claim);
    const [promoted] = await tx.update(agentWakeupRequests).set({ status: "queued", error: null, updatedAt: new Date() })
      .where(observed(receipt)).returning();
    return promoted;
  }

  async function recoverReceipt(candidate: Wake) {
    const intentId = candidate.requestedByActorId?.match(/^native-status-wake-dispatch:([0-9a-f-]{36})$/)?.[1];
    const runId = candidate.runId;
    if (!intentId || !runId) return false;
    return db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      const [initial] = await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, candidate.companyId),
        eq(agentWakeupRequests.id, intentId)));
      const intent = initial && await lockInput(tx, initial);
      if (!intent || !await provenance(tx, intent)) return false;
      const binding = reservation(intent);
      if (!binding || (intent.runId !== null && intent.runId !== runId)) return false;
      const [current] = await tx.select().from(agentWakeupRequests).where(observed(candidate)).for("update");
      if (!current) return false;
      const receipt = await receiptFor(tx, intent, binding);
      if (!receipt || receipt.id !== candidate.id || receipt.runId !== runId) return false;
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, candidate.companyId),
        eq(heartbeatRuns.id, runId), inArray(heartbeatRuns.status, terminalRunStatuses)));
      if (!run) return false;
      const [settled] = await tx.update(agentWakeupRequests).set({ status: run.status === "succeeded" ? "completed" : run.status,
        finishedAt: run.finishedAt, error: run.error, updatedAt: new Date() }).where(observed(current)).returning({ id: agentWakeupRequests.id });
      return Boolean(settled);
    });
  }

  return { prepare, authorize, settle, inspect, promoteReceipt, recoverReceipt };
}

export async function allowsDependencyProcessLossRetry(db: Db, run: typeof heartbeatRuns.$inferSelect, preDispatchProof: boolean) {
  const nativeIntentId = run.contextSnapshot?.nativeStatusWakeIntentId;
  const dependencyHint = typeof nativeIntentId === "string" && run.contextSnapshot?.wakeReason === "issue_blockers_resolved";
  if (!run.wakeupRequestId) return !dependencyHint;
  const [receipt] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.id, run.wakeupRequestId),
    eq(agentWakeupRequests.agentId, run.agentId)));
  const intentId = receipt?.requestedByActorId?.match(/^native-status-wake-dispatch:([0-9a-f-]{36})$/)?.[1];
  const [intent] = intentId ? await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.id, intentId))) : [];
  const dependencyLineage = dependencyHint || intent?.reason === "issue_blockers_resolved"
    || (receipt?.reason === "issue_blockers_resolved" && receipt.requestedByActorId?.startsWith("native-status-wake-dispatch:"));
  if (!dependencyLineage) return true;
  if (!preDispatchProof || !receipt || !intent || receipt.runId !== run.id
    || (intent.runId !== null && intent.runId !== run.id)) return false;
  const origin = await provenance(db, intent);
  if (!origin) return false;
  const binding = reservation(intent) ?? (intent.payload?.[markerKey] ? null : {
    version: 1 as const, receiptId: receipt.id, companyId: intent.companyId, agentId: intent.agentId,
    issueId: String(intent.payload?.issueId), intentId: intent.id, effectId: origin.id,
    idempotencyKey: intent.idempotencyKey, triggerDetail: intent.triggerDetail, inputPayload: inputPayload(intent),
  });
  return Boolean(binding && matchesReceipt(receipt, intent, binding) && matchesRun(run, receipt, binding));
}
