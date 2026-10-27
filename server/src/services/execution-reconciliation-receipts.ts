import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  executionReconciliationReceipts,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  type Db,
} from "@paperclipai/db";
import type { ExpectedReconciliationState } from "@paperclipai/shared";
import { canonicalReconciliationDigest } from "@paperclipai/shared/execution-reconciliation-canonical";
import { conflict } from "../errors.js";

// Receipts and expected-state binding for execution reconciliation admission
// (doc/plans/2026-10-27-native-execution-reconciliation-admission.md, sections 1 and 6).

type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type Receipt = typeof executionReconciliationReceipts.$inferSelect;

export type ReconciliationReceiptLookup =
  | { state: "committed"; receipt: Receipt }
  | { state: "abandoned"; settledAt: Date }
  | { state: "unsettled" };

/**
 * L0: serializes every resolve and settle that uses the same key. Held until
 * the transaction ends, so a settle waits for an in-flight resolve to commit
 * or roll back before it decides.
 */
export async function lockReconciliationKey(tx: DbOrTransaction, companyId: string, idempotencyKey: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`exec-recon-key:${companyId}:${idempotencyKey}`}, 0))`,
  );
}

function lookupFromRow(issueId: string, row: Receipt | undefined): ReconciliationReceiptLookup {
  if (!row) return { state: "unsettled" };
  // A key is unique per company. A key used for another issue is never this
  // issue's receipt, and reporting it as unsettled would invite a retry.
  if (row.issueId !== issueId) {
    throw conflict("Idempotency key belongs to another issue", { code: "idempotency_conflict" });
  }
  return row.state === "committed"
    ? { state: "committed", receipt: row }
    : { state: "abandoned", settledAt: row.createdAt };
}

async function selectReceipt(db: DbOrTransaction, companyId: string, idempotencyKey: string) {
  return db
    .select()
    .from(executionReconciliationReceipts)
    .where(and(
      eq(executionReconciliationReceipts.companyId, companyId),
      eq(executionReconciliationReceipts.idempotencyKey, idempotencyKey),
    ))
    .then((rows) => rows[0]);
}

/** Read-only. `unsettled` means unknown: a resolve may still be in flight. */
export async function readReconciliationReceipt(
  db: Db,
  input: { companyId: string; issueId: string; idempotencyKey: string },
): Promise<ReconciliationReceiptLookup> {
  return lookupFromRow(input.issueId, await selectReceipt(db, input.companyId, input.idempotencyKey));
}

/**
 * Waits on L0 for any in-flight resolve with this key, then returns the
 * committed receipt or writes an `abandoned` tombstone that blocks the key.
 */
export async function settleReconciliationKey(
  db: Db,
  input: { companyId: string; issueId: string; idempotencyKey: string; actorUserId: string | null },
): Promise<Exclude<ReconciliationReceiptLookup, { state: "unsettled" }>> {
  return db.transaction(async (tx) => {
    await lockReconciliationKey(tx, input.companyId, input.idempotencyKey);
    const existing = lookupFromRow(input.issueId, await selectReceipt(tx, input.companyId, input.idempotencyKey));
    if (existing.state !== "unsettled") return existing;
    const [row] = await tx
      .insert(executionReconciliationReceipts)
      .values({
        companyId: input.companyId,
        issueId: input.issueId,
        idempotencyKey: input.idempotencyKey,
        state: "abandoned",
        actorUserId: input.actorUserId,
      })
      .returning();
    return { state: "abandoned", settledAt: row!.createdAt };
  });
}

/** Runs that the hold itself cancelled before they started (no process, no session). */
export async function listUnstartedHoldRunIds(tx: DbOrTransaction, companyId: string, issueId: string) {
  const rows = await tx
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, companyId),
      eq(heartbeatRuns.issueId, issueId),
      eq(heartbeatRuns.status, "cancelled"),
      eq(heartbeatRuns.errorCode, "execution_reconciliation_required"),
      isNull(heartbeatRuns.startedAt),
      isNull(heartbeatRuns.processPid),
      isNull(heartbeatRuns.processGroupId),
      isNull(heartbeatRuns.nativeSessionId),
    ))
    .orderBy(asc(heartbeatRuns.id));
  return rows.map((row) => row.id);
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

/**
 * Builds the expected snapshot from rows the caller has already locked. Every
 * key is present; a null column is null. `finishedAt` must be set: the route
 * refuses an unsettled run before it builds the snapshot.
 */
export function buildExpectedReconciliationState(input: {
  issue: typeof issues.$inferSelect;
  run: typeof heartbeatRuns.$inferSelect;
  action: typeof issueRecoveryActions.$inferSelect;
  unstartedRunIds: string[];
}): ExpectedReconciliationState {
  const { issue, run, action } = input;
  if (!run.finishedAt) throw new Error("Expected state requires a finished run");
  return {
    companyId: issue.companyId,
    projectId: issue.projectId ?? null,
    issueId: issue.id,
    runId: run.id,
    actionId: action.id,
    run: {
      status: run.status,
      finishedAt: run.finishedAt.toISOString(),
      agentId: run.agentId,
      processPid: run.processPid ?? null,
      processGroupId: run.processGroupId ?? null,
      runtimeMode: run.runtimeMode ?? null,
    },
    unstartedRunIds: [...input.unstartedRunIds].sort(),
    action: {
      status: action.status,
      cause: action.cause,
      kind: action.kind,
      outcome: action.outcome ?? null,
      ownerAgentId: action.ownerAgentId ?? null,
      returnOwnerAgentId: action.returnOwnerAgentId ?? null,
      updatedAt: action.updatedAt.toISOString(),
    },
    issue: {
      status: issue.status,
      statusVersion: issue.statusVersion,
      assigneeAgentId: issue.assigneeAgentId ?? null,
      assigneeUserId: issue.assigneeUserId ?? null,
      responsibleUserId: issue.responsibleUserId ?? null,
      workspaceBindingRevision: issue.workspaceBindingRevision,
      executionPolicy: issue.executionPolicy ?? null,
      executionState: issue.executionState ?? null,
      unblockDescriptor: issue.unblockDescriptor ?? null,
      monitorNextCheckAt: iso(issue.monitorNextCheckAt),
      monitorAttemptCount: issue.monitorAttemptCount,
      monitorScheduledBy: issue.monitorScheduledBy ?? null,
      monitorNotes: issue.monitorNotes ?? null,
    },
  };
}

export type ExpectedStateComparison =
  | { matches: true; digest: string }
  | { matches: false; digest: string; differingKeys: string[] };

/**
 * Compares the server snapshot with the caller's digest. On mismatch it names
 * only the differing top-level keys, never their values.
 */
export function compareExpectedReconciliationState(
  server: ExpectedReconciliationState,
  client: { expected: ExpectedReconciliationState; expectedDigest: string },
): ExpectedStateComparison {
  const digest = canonicalReconciliationDigest(server);
  if (digest === client.expectedDigest && canonicalReconciliationDigest(client.expected) === digest) {
    return { matches: true, digest };
  }
  const serverRecord = server as unknown as Record<string, unknown>;
  const clientRecord = client.expected as unknown as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(serverRecord), ...Object.keys(clientRecord)])].sort();
  const differingKeys = keys.filter((key) =>
    canonicalReconciliationDigest(serverRecord[key] ?? null) !== canonicalReconciliationDigest(clientRecord[key] ?? null));
  if (differingKeys.length === 0) differingKeys.push("expectedDigest");
  return { matches: false, digest, differingKeys };
}
