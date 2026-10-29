import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, isNull, sql } from "drizzle-orm";
import { agentWakeupRequests, issues, statusDecisionEffects, statusDecisions, type Db } from "@paperclipai/db";
import { ordinaryWakeRequestPredicate } from "../../modules/wake-queue/receipt-namespace.js";

type Wake = typeof agentWakeupRequests.$inferSelect;
const markerKey = "_paperclipDependencyAdmission";

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
  | { kind: "retired"; reason: string };

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
    eq(agentWakeupRequests.status, row.status), isNull(agentWakeupRequests.runId),
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
      sql`${statusDecisionEffects.payload}->>'dependentIssueId' = ${row.payload.issueId}`,
      sql`${statusDecisionEffects.payload}->>'resolvedBlockerIssueId' = ${row.payload.resolvedBlockerIssueId}`,
      sql`${statusDecisionEffects.issueId}::text = ${row.payload.resolvedBlockerIssueId}`)).limit(2);
  return effects.length === 1 ? effects[0] : null;
}

function matchesReceipt(row: Wake, intent: Wake, binding: Reservation) {
  if (row.id !== binding.receiptId || row.companyId !== intent.companyId || row.agentId !== intent.agentId
    || row.source !== intent.source || row.reason !== intent.reason || row.triggerDetail !== intent.triggerDetail
    || row.idempotencyKey !== intent.idempotencyKey || row.requestedByActorType !== "system"
    || row.requestedByActorId !== `native-status-wake-dispatch:${intent.id}`) return false;
  return Object.entries(binding.inputPayload).every(([key, value]) => key === "_paperclipWakeContext"
    ? Object.entries(value as Record<string, unknown>).every(([name, field]) =>
        isDeepStrictEqual((row.payload?.[key] as Record<string, unknown> | undefined)?.[name], field))
    : isDeepStrictEqual(row.payload?.[key], value));
}

export function createDependencyAdmission(db: Db) {
  async function lockInput(tx: Db, row: Wake) {
    await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, row.companyId),
      sql`${issues.id}::text = ${row.payload?.issueId}`)).for("update");
    return tx.select().from(agentWakeupRequests).where(observed(row)).for("update").then(rows => rows[0] ?? null);
  }

  async function receiptFor(tx: Db, row: Wake, binding: Reservation) {
    const [receipt] = await tx.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, binding.receiptId));
    if (receipt && !matchesReceipt(receipt, row, binding)) throw new Error("Dependency receipt binding conflicts with durable input");
    return receipt ?? null;
  }

  async function prepare(row: Wake, gate: string | null, staleClaimMs: number): Promise<DependencyClaim | null> {
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
        await tx.update(agentWakeupRequests).set({ status: "coalesced", runId: receipt.runId,
          payload: { ...current.payload, [markerKey]: binding }, finishedAt: receipt.finishedAt ?? new Date(), updatedAt: new Date() })
          .where(observed(current));
        return null;
      }
      if (gate) {
        const status = receipt ? "coalesced" : "deferred_issue_execution";
        if (current.status !== status || !reservation(current)) {
          await tx.update(agentWakeupRequests).set({ status,
            payload: { ...current.payload, [markerKey]: binding }, error: gate, updatedAt: new Date() }).where(observed(current));
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
      status: runId || receipt?.status === "deferred_issue_execution" ? "coalesced"
        : outcome.kind === "retired" ? "skipped" : "deferred_issue_execution",
      runId, finishedAt: runId || outcome.kind === "retired" ? new Date() : null,
      error: outcome.kind === "waiting" ? outcome.gate : outcome.kind === "retired" ? outcome.reason : null,
      updatedAt: new Date(),
    }).where(observed(claim.intent));
  }

  return { prepare, authorize, settle };
}

export async function isVerifiedDependencyRun(db: Db, run: { id: string; companyId: string; agentId: string; wakeupRequestId: string | null }) {
  if (!run.wakeupRequestId) return false;
  const [receipt] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.id, run.wakeupRequestId),
    eq(agentWakeupRequests.agentId, run.agentId), eq(agentWakeupRequests.runId, run.id)));
  const intentId = receipt?.requestedByActorId?.match(/^native-status-wake-dispatch:([0-9a-f-]{36})$/)?.[1];
  if (!receipt || !intentId) return false;
  const [intent] = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.id, intentId)));
  if (!intent) return false;
  const binding = reservation(intent);
  return Boolean(binding && matchesReceipt(receipt, intent, binding) && await provenance(db, intent));
}
