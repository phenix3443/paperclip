import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  executionReconciliationReceipts,
  heartbeatRuns,
  issueRecoveryActions,
  issues,
  type Db,
} from "@paperclipai/db";
import type {
  ExecutionReconciliationAdmission,
  ExecutionReconciliationRefusalCode,
  ExpectedReconciliationState,
} from "@paperclipai/shared";
import {
  ReconciliationCanonicalError,
  canonicalReconciliationDigest,
  findDuplicateJsonKey,
} from "@paperclipai/shared/execution-reconciliation-canonical";
import { conflict, notFound } from "../errors.js";


type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type Receipt = typeof executionReconciliationReceipts.$inferSelect;
export type ExecutionReconciliationReceiptRow = Receipt;

export type ReconciliationReceiptLookup =
  | { state: "committed"; receipt: Receipt }
  | { state: "abandoned"; settledAt: Date }
  | { state: "unsettled" };

export async function lockReconciliationKey(tx: DbOrTransaction, companyId: string, idempotencyKey: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`exec-recon-key:${companyId}:${idempotencyKey}`}, 0))`,
  );
}

function lookupFromRow(issueId: string, row: Receipt | undefined): ReconciliationReceiptLookup {
  if (!row) return { state: "unsettled" };
  if (row.issueId !== issueId) {
    throw conflict("Idempotency key belongs to another issue", { code: "idempotency_conflict" });
  }
  return row.state === "committed"
    ? { state: "committed", receipt: row }
    : { state: "abandoned", settledAt: row.createdAt };
}

export async function selectReconciliationReceipt(db: DbOrTransaction, companyId: string, idempotencyKey: string) {
  return db
    .select()
    .from(executionReconciliationReceipts)
    .where(and(
      eq(executionReconciliationReceipts.companyId, companyId),
      eq(executionReconciliationReceipts.idempotencyKey, idempotencyKey),
    ))
    .then((rows) => rows[0]);
}

export async function readReconciliationReceipt(
  db: Db,
  input: { companyId: string; issueId: string; idempotencyKey: string },
): Promise<ReconciliationReceiptLookup> {
  return lookupFromRow(input.issueId, await selectReconciliationReceipt(db, input.companyId, input.idempotencyKey));
}

export async function settleReconciliationKey(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    idempotencyKey: string;
    actorUserId: string | null;
    recordSettlement: (tx: DbOrTransaction) => Promise<unknown>;
  },
): Promise<Exclude<ReconciliationReceiptLookup, { state: "unsettled" }> & { settledNow: boolean }> {
  return db.transaction(async (tx) => {
    await lockReconciliationKey(tx, input.companyId, input.idempotencyKey);
    const existing = lookupFromRow(input.issueId, await selectReconciliationReceipt(tx, input.companyId, input.idempotencyKey));
    if (existing.state !== "unsettled") return { ...existing, settledNow: false };
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
    await input.recordSettlement(tx);
    return { state: "abandoned", settledAt: row!.createdAt, settledNow: true };
  });
}

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

const REFUSAL_MARK = Symbol("executionReconciliationRefusal");

export function executionReconciliationRefusal(
  code: ExecutionReconciliationRefusalCode,
  message: string,
  details: Record<string, unknown> = {},
) {
  const error = conflict(message, { ...details, code });
  (error as unknown as Record<symbol, string>)[REFUSAL_MARK] = code;
  return error;
}

export function toExecutionReconciliationRefusal(
  error: unknown,
): { code: ExecutionReconciliationRefusalCode; error: unknown } | null {
  const marked = error && typeof error === "object" ? (error as Record<symbol, unknown>)[REFUSAL_MARK] : undefined;
  if (typeof marked === "string") return { code: marked as ExecutionReconciliationRefusalCode, error };
  const pgCode = error && typeof error === "object" ? (error as { code?: unknown; cause?: { code?: unknown } }) : null;
  const sqlState = pgCode?.code ?? pgCode?.cause?.code;
  if (sqlState === "40P01" || sqlState === "40001") {
    return {
      code: "concurrent_change",
      error: executionReconciliationRefusal("concurrent_change", "A concurrent change rolled back the request. Re-read and retry with the same key."),
    };
  }
  return null;
}

export function executionReconciliationRequestDigest(body: unknown, rawBody: Buffer | undefined): string {
  if (!rawBody) throw new ReconciliationCanonicalError("", "the original request body is unavailable");
  const duplicate = findDuplicateJsonKey(rawBody.toString("utf8").replace(/^\uFEFF/, ""));
  if (duplicate) throw new ReconciliationCanonicalError(duplicate, "duplicate JSON key");
  const copy = JSON.parse(JSON.stringify(body)) as {
    executionReconciliation?: { admission?: { idempotencyKey?: string } };
  };
  delete copy.executionReconciliation?.admission?.idempotencyKey;
  return canonicalReconciliationDigest(copy);
}

export async function checkExecutionReconciliationAdmission(
  tx: DbOrTransaction,
  input: {
    issue: typeof issues.$inferSelect;
    actionId: string;
    runId: string;
    admission: ExecutionReconciliationAdmission;
    requestDigest: string;
    priorReceipt: Receipt | undefined;
  },
): Promise<
  | { kind: "replay"; receipt: Receipt; action: typeof issueRecoveryActions.$inferSelect }
  | { kind: "admit"; expected: ExpectedReconciliationState; expectedDigest: string }
> {
  const { issue, admission } = input;
  const prior = input.priorReceipt;
  if (prior) {
    if (prior.state === "abandoned") {
      throw executionReconciliationRefusal("idempotency_key_settled", "This idempotency key was settled without a commit.");
    }
    if (prior.issueId !== issue.id || prior.requestDigest !== input.requestDigest) {
      throw executionReconciliationRefusal("idempotency_conflict", "This idempotency key was used for a different request.");
    }
    const [action] = await tx.select().from(issueRecoveryActions).where(and(
      eq(issueRecoveryActions.id, prior.actionId!),
      eq(issueRecoveryActions.companyId, issue.companyId),
      eq(issueRecoveryActions.sourceIssueId, issue.id),
    ));
    if (!action) throw notFound("Recovery action not found");
    return { kind: "replay", receipt: prior, action };
  }
  const [admitted] = await tx.select({ id: executionReconciliationReceipts.id }).from(executionReconciliationReceipts)
    .where(and(
      eq(executionReconciliationReceipts.companyId, issue.companyId),
      eq(executionReconciliationReceipts.actionId, input.actionId),
      eq(executionReconciliationReceipts.state, "committed"),
    ));
  if (admitted) {
    throw executionReconciliationRefusal("action_already_reconciled", "This recovery action already has an admitted reconciliation.",
      { receiptId: admitted.id });
  }
  if (issue.executionState != null) {
    throw executionReconciliationRefusal("execution_state_not_supported", "Admission does not support a task with review state.");
  }
  const [action] = await tx.select().from(issueRecoveryActions).where(and(
    eq(issueRecoveryActions.id, input.actionId),
    eq(issueRecoveryActions.companyId, issue.companyId),
    eq(issueRecoveryActions.sourceIssueId, issue.id),
  )).for("update");
  if (!action) throw notFound("Recovery action not found");
  if ((action.evidence as { runId?: unknown }).runId !== input.runId) {
    throw executionReconciliationRefusal("expected_state_mismatch", "The recovery action belongs to another run.",
      { differingKeys: ["runId"] });
  }
  const [run] = await tx.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.companyId, issue.companyId),
  )).for("update");
  if (!run) throw notFound("Run not found");
  if (!run.finishedAt) throw executionReconciliationRefusal("run_not_settled", "The source run has not finished.");
  const unstartedRunIds = await listUnstartedHoldRunIds(tx, issue.companyId, issue.id);
  const expected = buildExpectedReconciliationState({ issue, run, action, unstartedRunIds });
  let comparison: ExpectedStateComparison;
  try {
    comparison = compareExpectedReconciliationState(expected, admission);
  } catch (error) {
    if (error instanceof ReconciliationCanonicalError) {
      throw executionReconciliationRefusal("expected_state_mismatch", "The stored task state cannot be canonicalized.",
        { reason: "server_state_not_canonical" });
    }
    throw error;
  }
  if (!comparison.matches) {
    throw executionReconciliationRefusal("expected_state_mismatch", "The task, run or action changed since it was verified.",
      { serverDigest: comparison.digest, differingKeys: comparison.differingKeys });
  }
  return { kind: "admit", expected, expectedDigest: comparison.digest };
}

export async function insertCommittedReconciliationReceipt(
  tx: DbOrTransaction,
  values: Omit<typeof executionReconciliationReceipts.$inferInsert, "state" | "id" | "createdAt">,
) {
  const [row] = await tx.insert(executionReconciliationReceipts).values({ ...values, state: "committed" }).returning();
  return row!;
}
