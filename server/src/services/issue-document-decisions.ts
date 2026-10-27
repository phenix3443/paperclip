import { and, eq, sql } from "drizzle-orm";
import {
  companies,
  documentRevisions,
  documents,
  issueDocumentDecisions,
  issueDocuments,
  type Db,
} from "@paperclipai/db";
import {
  EXECUTION_RECONCILIATION_DECISION_MAX_LIFETIME_MS,
  EXECUTION_RECONCILIATION_DECISION_SCOPE,
  executionReconciliationAuthoritySchema,
  executionReconciliationAuthorizationPayloadSchema,
  executionReconciliationRequestIntent,
  type CreateIssueDocumentDecision,
  type ExecutionReconciliationAdmission,
} from "@paperclipai/shared";
import {
  canonicalizeReconciliationJson,
  isCanonicalReconciliationBody,
  sha256HexOfText,
} from "@paperclipai/shared/execution-reconciliation-canonical";
import { notFound, unprocessable } from "../errors.js";
import { executionReconciliationRefusal } from "./execution-reconciliation-receipts.js";
import { lockExecutionReconciliationAuthority } from "./execution-reconciliation-authority-lock.js";

type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
export type IssueDocumentDecisionRow = typeof issueDocumentDecisions.$inferSelect;

async function statementTime(tx: DbOrTransaction) {
  const rows = await tx.execute<{ now: Date }>(sql`select statement_timestamp() as now`) as unknown as { now: Date }[];
  return new Date(rows[0]!.now).getTime();
}

export async function createIssueDocumentDecision(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    key: string;
    request: CreateIssueDocumentDecision;
    actor: { agentId: string | null; userId: string | null; runId: string | null };
    recordDecision: (tx: DbOrTransaction, decision: IssueDocumentDecisionRow) => Promise<unknown>;
  },
): Promise<IssueDocumentDecisionRow> {
  return db.transaction(async (tx) => {
    const [link] = await tx
      .select({ documentId: issueDocuments.documentId })
      .from(issueDocuments)
      .where(and(
        eq(issueDocuments.companyId, input.companyId),
        eq(issueDocuments.issueId, input.issueId),
        eq(issueDocuments.key, input.key),
      ));
    if (!link) throw notFound("Document not found");
    await tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.companyId, input.companyId), eq(documents.id, link.documentId)))
      .for("update");
    const [revision] = await tx
      .select()
      .from(documentRevisions)
      .where(and(
        eq(documentRevisions.id, input.request.revisionId),
        eq(documentRevisions.companyId, input.companyId),
        eq(documentRevisions.documentId, link.documentId),
      ));
    if (!revision) throw notFound("Document revision not found");

    const request = input.request;
    const nowMs = await statementTime(tx);
    let expiresAt: Date | null = null;
    let revokesDecisionId: string | null = null;
    if (request.outcome === "approved") {
      expiresAt = new Date(request.expiresAt);
      if (expiresAt.getTime() <= nowMs) throw unprocessable("expiresAt must be in the future");
      if (expiresAt.getTime() > nowMs + EXECUTION_RECONCILIATION_DECISION_MAX_LIFETIME_MS) {
        throw unprocessable("expiresAt must be at most 72 hours from now");
      }
    } else {
      const [target] = await tx
        .select()
        .from(issueDocumentDecisions)
        .where(and(
          eq(issueDocumentDecisions.id, request.revokesDecisionId),
          eq(issueDocumentDecisions.companyId, input.companyId),
          eq(issueDocumentDecisions.issueId, input.issueId),
          eq(issueDocumentDecisions.documentId, link.documentId),
        ));
      if (!target) throw notFound("Decision not found");
      if (target.outcome !== "approved" || target.revisionId !== revision.id || target.scope !== request.scope) {
        throw unprocessable("A revoke must target an approval of the same revision and scope");
      }
      revokesDecisionId = target.id;
    }

    const [decision] = await tx
      .insert(issueDocumentDecisions)
      .values({
        companyId: input.companyId,
        issueId: input.issueId,
        documentId: link.documentId,
        revisionId: revision.id,
        revisionNumber: revision.revisionNumber,
        bodySha256: sha256HexOfText(revision.body),
        scope: request.scope,
        outcome: request.outcome,
        revokesDecisionId,
        expiresAt,
        actorAgentId: input.actor.agentId,
        actorUserId: input.actor.userId,
        createdByRunId: input.actor.runId,
        createdAt: new Date(nowMs),
      })
      .returning();
    await input.recordDecision(tx, decision!);
    return decision!;
  });
}

export async function lockCompanyForAdmission(tx: DbOrTransaction, companyId: string) {
  await lockExecutionReconciliationAuthority(tx, companyId, "shared");
  const [company] = await tx
    .select({ id: companies.id, executionReconciliationAuthority: companies.executionReconciliationAuthority })
    .from(companies)
    .where(eq(companies.id, companyId));
  if (!company) throw notFound("Company not found");
  return company;
}

function invalid(reason: string): never {
  throw executionReconciliationRefusal("authorization_invalid", "The authorization does not verify.", { reason });
}

export async function verifyExecutionReconciliationAuthorization(
  tx: DbOrTransaction,
  input: {
    companyId: string;
    issueId: string;
    actionId: string;
    runId: string;
    authority: unknown;
    admission: ExecutionReconciliationAdmission;
    expectedDigest: string;
    request: Parameters<typeof executionReconciliationRequestIntent>[0];
  },
): Promise<{ payloadDigest: string; evidence: Record<string, unknown> }> {
  const authority = executionReconciliationAuthoritySchema.safeParse(input.authority);
  if (!authority.success || authority.data.agentIds.length === 0) {
    throw executionReconciliationRefusal("authority_not_configured", "No execution reconciliation authority is configured.");
  }
  const reference = input.admission.authorization;

  const [document] = await tx
    .select({ id: documents.id, latestRevisionId: documents.latestRevisionId })
    .from(documents)
    .innerJoin(issueDocuments, eq(issueDocuments.documentId, documents.id))
    .where(and(
      eq(documents.id, reference.documentId),
      eq(documents.companyId, input.companyId),
      eq(issueDocuments.companyId, input.companyId),
      eq(issueDocuments.issueId, input.issueId),
    ))
    .for("share", { of: documents });
  if (!document) invalid("document_not_on_issue");
  const now = await statementTime(tx);

  const [decision] = await tx
    .select()
    .from(issueDocumentDecisions)
    .where(and(
      eq(issueDocumentDecisions.id, reference.decisionId),
      eq(issueDocumentDecisions.companyId, input.companyId),
      eq(issueDocumentDecisions.issueId, input.issueId),
      eq(issueDocumentDecisions.documentId, document!.id),
    ));
  if (!decision) invalid("decision_not_found");
  if (decision!.outcome !== "approved") invalid("decision_not_approval");
  if (decision!.scope !== EXECUTION_RECONCILIATION_DECISION_SCOPE) invalid("decision_scope");
  if (decision!.revisionId !== reference.revisionId) invalid("decision_revision");

  if (document!.latestRevisionId !== reference.revisionId) {
    throw executionReconciliationRefusal("authorization_stale", "A newer revision replaced the approved revision.");
  }
  const [revision] = await tx
    .select()
    .from(documentRevisions)
    .where(and(eq(documentRevisions.id, reference.revisionId), eq(documentRevisions.documentId, document!.id)));
  if (!revision) invalid("revision_not_found");
  if (revision!.revisionNumber !== reference.revisionNumber) invalid("revision_number");
  const bodySha256 = sha256HexOfText(revision!.body);
  if (bodySha256 !== reference.bodyDigest || bodySha256 !== decision!.bodySha256) invalid("body_digest");

  const revokes = await tx
    .select({ actorAgentId: issueDocumentDecisions.actorAgentId })
    .from(issueDocumentDecisions)
    .where(and(
      eq(issueDocumentDecisions.companyId, input.companyId),
      eq(issueDocumentDecisions.revokesDecisionId, decision!.id),
      eq(issueDocumentDecisions.outcome, "revoked"),
    ));
  const revoke = revokes.some((row) => row.actorAgentId && authority.data.agentIds.includes(row.actorAgentId));
  if (revoke) invalid("decision_revoked");
  if (!decision!.actorAgentId || !authority.data.agentIds.includes(decision!.actorAgentId)) {
    invalid("actor_not_authorized");
  }
  if (now >= decision!.expiresAt!.getTime()) {
    throw executionReconciliationRefusal("authorization_expired", "The decision expired.");
  }

  if (!isCanonicalReconciliationBody(revision!.body)) invalid("body_not_canonical");
  const payload = executionReconciliationAuthorizationPayloadSchema.safeParse(JSON.parse(revision!.body));
  if (!payload.success) invalid("payload_schema");
  const approved = payload.data!;
  const payloadExpiry = new Date(approved.expiresAt).getTime();
  if (payloadExpiry > decision!.expiresAt!.getTime()) invalid("payload_outlives_decision");
  if (now >= payloadExpiry) {
    throw executionReconciliationRefusal("authorization_expired", "The authorization payload expired.");
  }
  const mismatch = (field: string) => {
    throw executionReconciliationRefusal("authorization_payload_mismatch",
      "The request does not match the approved payload.", { field });
  };
  if (approved.companyId !== input.companyId) mismatch("companyId");
  if (approved.issueId !== input.issueId) mismatch("issueId");
  if (approved.runId !== input.runId) mismatch("runId");
  if (approved.actionId !== input.actionId) mismatch("actionId");
  if (approved.expectedDigest !== input.admission.expectedDigest || approved.expectedDigest !== input.expectedDigest) {
    mismatch("expectedDigest");
  }
  if (canonicalizeReconciliationJson(executionReconciliationRequestIntent(input.request)) !== canonicalizeReconciliationJson(approved.intent)) {
    mismatch("intent");
  }
  return { payloadDigest: bodySha256, evidence: approved.evidence };
}
