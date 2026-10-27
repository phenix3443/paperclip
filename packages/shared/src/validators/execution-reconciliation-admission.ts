import { z } from "zod";


export const EXECUTION_RECONCILIATION_ADMISSION_SCHEMA = "execution_reconciliation_admission_v1" as const;

export const EXECUTION_RECONCILIATION_REFUSAL_CODES = [
  "capability_unsupported",
  "expected_state_mismatch",
  "authorization_invalid",
  "authorization_stale",
  "authority_not_configured",
  "authorization_expired",
  "authorization_payload_mismatch",
  "idempotency_conflict",
  "idempotency_key_settled",
  "action_already_reconciled",
  "issue_kind_not_supported",
  "execution_state_not_supported",
  "run_not_settled",
  "newer_execution_exists",
  "concurrent_change",
] as const;

export const EXECUTION_RECONCILIATION_GATES = [
  "dependency",
  "interaction",
  "approval",
  "subtree_pause",
  "project_pause",
  "company_pause",
  "agent_pause",
  "budget",
  "monitor",
  "workspace",
  "checkout",
  "owner",
] as const;

export type ExecutionReconciliationGate = (typeof EXECUTION_RECONCILIATION_GATES)[number];
export type ExecutionReconciliationRefusalCode =
  | (typeof EXECUTION_RECONCILIATION_REFUSAL_CODES)[number]
  | `gate_closed:${ExecutionReconciliationGate}`;

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, "Expected a lowercase sha256 hex digest");
const isoTimestampSchema = z
  .string()
  .refine((value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
  }, "Expected an ISO 8601 UTC timestamp with milliseconds");
const nullableString = z.string().nullable();
const nullableInteger = z.number().int().nullable();
const requiredJsonValue = z.custom<unknown>((value) => value !== undefined, "Required");

export const expectedReconciliationStateSchema = z
  .object({
    companyId: z.string().guid(),
    projectId: z.string().guid().nullable(),
    issueId: z.string().guid(),
    runId: z.string().guid(),
    actionId: z.string().guid(),
    run: z
      .object({
        status: z.string(),
        finishedAt: isoTimestampSchema,
        agentId: z.string().guid(),
        processPid: nullableInteger,
        processGroupId: nullableInteger,
        runtimeMode: nullableString,
      })
      .strict(),
    unstartedRunIds: z.array(z.string().guid()).max(100),
    action: z
      .object({
        status: z.string(),
        cause: z.string(),
        kind: z.string(),
        outcome: nullableString,
        ownerAgentId: z.string().guid().nullable(),
        returnOwnerAgentId: z.string().guid().nullable(),
        updatedAt: isoTimestampSchema,
      })
      .strict(),
    issue: z
      .object({
        status: z.string(),
        statusVersion: z.number().int(),
        assigneeAgentId: z.string().guid().nullable(),
        assigneeUserId: nullableString,
        responsibleUserId: nullableString,
        workspaceBindingRevision: z.number().int(),
        executionPolicy: requiredJsonValue,
        executionState: requiredJsonValue,
        unblockDescriptor: requiredJsonValue,
        monitorNextCheckAt: isoTimestampSchema.nullable(),
        monitorAttemptCount: z.number().int(),
        monitorScheduledBy: nullableString,
        monitorNotes: nullableString,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const sorted = [...value.unstartedRunIds].sort();
    if (new Set(sorted).size !== sorted.length || sorted.some((id, index) => id !== value.unstartedRunIds[index])) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["unstartedRunIds"], message: "Must be sorted and unique" });
    }
  });

export type ExpectedReconciliationState = z.infer<typeof expectedReconciliationStateSchema>;

export const executionReconciliationAdmissionSchema = z
  .object({
    schema: z.literal(EXECUTION_RECONCILIATION_ADMISSION_SCHEMA),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{16,128}$/, "Use 16-128 characters from [A-Za-z0-9:_-]"),
    expected: expectedReconciliationStateSchema,
    expectedDigest: sha256HexSchema,
    authorization: z
      .object({
        documentId: z.string().guid(),
        revisionId: z.string().guid(),
        revisionNumber: z.number().int().positive(),
        bodyDigest: sha256HexSchema,
        decisionId: z.string().guid(),
      })
      .strict(),
  })
  .strict();

export type ExecutionReconciliationAdmission = z.infer<typeof executionReconciliationAdmissionSchema>;

export const executionReconciliationIdempotencyKeySchema =
  executionReconciliationAdmissionSchema.shape.idempotencyKey;

export const EXECUTION_RECONCILIATION_AUTHORIZATION_SCHEMA = "execution_reconciliation_authorization_v1" as const;
export const EXECUTION_RECONCILIATION_DECISION_SCOPE = "execution_reconciliation" as const;
export const EXECUTION_RECONCILIATION_DECISION_MAX_LIFETIME_MS = 72 * 60 * 60 * 1000;

export const executionReconciliationAuthoritySchema = z
  .object({
    agentIds: z.array(z.string().guid()).max(20).refine((ids) => new Set(ids).size === ids.length, "Agent IDs must be unique"),
  })
  .strict();

export type ExecutionReconciliationAuthority = z.infer<typeof executionReconciliationAuthoritySchema>;

export const createIssueDocumentDecisionSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("approved"),
      revisionId: z.string().guid(),
      scope: z.literal(EXECUTION_RECONCILIATION_DECISION_SCOPE),
      expiresAt: isoTimestampSchema,
    })
    .strict(),
  z
    .object({
      outcome: z.literal("revoked"),
      revisionId: z.string().guid(),
      scope: z.literal(EXECUTION_RECONCILIATION_DECISION_SCOPE),
      revokesDecisionId: z.string().guid(),
    })
    .strict(),
]);

export type CreateIssueDocumentDecision = z.infer<typeof createIssueDocumentDecisionSchema>;

export const executionReconciliationAuthorizationPayloadSchema = z
  .object({
    schema: z.literal(EXECUTION_RECONCILIATION_AUTHORIZATION_SCHEMA),
    scope: z.literal("execute"),
    companyId: z.string().guid(),
    issueId: z.string().guid(),
    runId: z.string().guid(),
    actionId: z.string().guid(),
    expectedDigest: sha256HexSchema,
    expiresAt: isoTimestampSchema,
    intent: z.record(z.string(), z.unknown()),
    evidence: z.record(z.string(), z.unknown()),
  })
  .strict();

export type ExecutionReconciliationAuthorizationPayload = z.infer<typeof executionReconciliationAuthorizationPayloadSchema>;

export type ExecutionReconciliationRequestIntent = {
  actionId: string;
  outcome: string;
  sourceIssueStatus: string;
  resolutionNote: string | null;
  executionReconciliation: {
    runId: string;
    providerStopped: true;
    actionOutcome: string;
    outcomeEvidence: string;
    workspaceRepairEvidence: string | null;
  };
};

export function executionReconciliationRequestIntent(request: {
  actionId?: string;
  outcome: string;
  sourceIssueStatus: string;
  resolutionNote?: string | null;
  executionReconciliation?: {
    runId: string;
    providerStopped: true;
    actionOutcome: string;
    outcomeEvidence: string;
    workspaceRepairEvidence?: string;
  };
}): ExecutionReconciliationRequestIntent {
  const reconciliation = request.executionReconciliation;
  if (!request.actionId || !reconciliation) {
    throw new Error("A request intent requires actionId and executionReconciliation");
  }
  return {
    actionId: request.actionId,
    outcome: request.outcome,
    sourceIssueStatus: request.sourceIssueStatus,
    resolutionNote: request.resolutionNote ?? null,
    executionReconciliation: {
      runId: reconciliation.runId,
      providerStopped: reconciliation.providerStopped,
      actionOutcome: reconciliation.actionOutcome,
      outcomeEvidence: reconciliation.outcomeEvidence,
      workspaceRepairEvidence: reconciliation.workspaceRepairEvidence ?? null,
    },
  };
}
