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
