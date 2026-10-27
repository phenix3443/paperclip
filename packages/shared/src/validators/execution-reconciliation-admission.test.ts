import { describe, expect, it } from "vitest";
import { resolveIssueRecoveryActionSchema } from "./issue.js";
import { updateCompanyBrandingSchema, updateCompanySchema } from "./company.js";
import {
  createIssueDocumentDecisionSchema,
  executionReconciliationAuthoritySchema,
  executionReconciliationRequestIntent,
} from "./execution-reconciliation-admission.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function admission() {
  return {
    schema: "execution_reconciliation_admission_v1",
    idempotencyKey: "recon:test-key-0001",
    expectedDigest: "a".repeat(64),
    authorization: { documentId: id(10), revisionId: id(11), revisionNumber: 1, bodyDigest: "b".repeat(64), decisionId: id(12) },
    expected: {
      companyId: id(1), projectId: null, issueId: id(2), runId: id(3), actionId: id(4),
      run: { status: "failed", finishedAt: "2026-10-27T12:00:00.000Z", agentId: id(5), processPid: null, processGroupId: null, runtimeMode: null },
      unstartedRunIds: [],
      action: { status: "active", cause: "c", kind: "k", outcome: null, ownerAgentId: id(5), returnOwnerAgentId: id(5), updatedAt: "2026-10-27T12:00:01.000Z" },
      issue: {
        status: "blocked", statusVersion: 3, assigneeAgentId: id(5), assigneeUserId: null, responsibleUserId: null,
        workspaceBindingRevision: 0, executionPolicy: null, executionState: null, unblockDescriptor: null,
        monitorNextCheckAt: null, monitorAttemptCount: 0, monitorScheduledBy: null, monitorNotes: null,
      },
    },
  };
}

function request(extra: Record<string, unknown> = {}, admissionValue: unknown = admission()) {
  return {
    actionId: id(4),
    outcome: "restored",
    sourceIssueStatus: "todo",
    executionReconciliation: {
      runId: id(3), providerStopped: true, actionOutcome: "completed",
      outcomeEvidence: "The run saved its output before it stopped.", admission: admissionValue,
    },
    ...extra,
  };
}

describe("executionReconciliation.admission schema", () => {
  it("accepts a complete admission", () => {
    expect(resolveIssueRecoveryActionSchema.safeParse(request()).success).toBe(true);
  });

  it("rejects a missing expected key instead of treating it as null", () => {
    const value = admission();
    delete (value.expected.issue as Record<string, unknown>).executionState;
    expect(resolveIssueRecoveryActionSchema.safeParse(request({}, value)).success).toBe(false);
  });

  it("rejects unknown keys, bad digests, bad keys and non-canonical timestamps", () => {
    expect(resolveIssueRecoveryActionSchema.safeParse(request({}, { ...admission(), extra: 1 })).success).toBe(false);
    expect(resolveIssueRecoveryActionSchema.safeParse(request({}, { ...admission(), expectedDigest: "A".repeat(64) })).success).toBe(false);
    expect(resolveIssueRecoveryActionSchema.safeParse(request({}, { ...admission(), idempotencyKey: "short" })).success).toBe(false);
    const value = admission();
    value.expected.run.finishedAt = "2026-10-27T12:00:00Z";
    expect(resolveIssueRecoveryActionSchema.safeParse(request({}, value)).success).toBe(false);
  });

  it("requires sorted unique unstarted run ids", () => {
    const value = admission();
    value.expected.unstartedRunIds = [id(9), id(8)] as never[];
    expect(resolveIssueRecoveryActionSchema.safeParse(request({}, value)).success).toBe(false);
  });

  it("requires the exact actionId and no workspaceBaseRef", () => {
    const { actionId: _actionId, ...withoutAction } = request();
    expect(resolveIssueRecoveryActionSchema.safeParse(withoutAction).success).toBe(false);
    expect(
      resolveIssueRecoveryActionSchema.safeParse(request({ workspaceBaseRef: { requestedRef: "main", branch: "main" } })).success,
    ).toBe(false);
  });
});

describe("execution reconciliation authorization schemas", () => {
  it("accepts the authority list only in the Board company update schema", () => {
    const agentIds = ["11111111-1111-4111-8111-111111111111"];
    expect(updateCompanySchema.parse({ executionReconciliationAuthority: { agentIds } }))
      .toEqual({ executionReconciliationAuthority: { agentIds } });
    expect(updateCompanyBrandingSchema.safeParse({ name: "x", executionReconciliationAuthority: { agentIds } }).success).toBe(false);
    expect(executionReconciliationAuthoritySchema.safeParse({ agentIds: [agentIds[0], agentIds[0]] }).success).toBe(false);
  });

  it("requires an expiry for an approval and a target for a revoke", () => {
    const revisionId = "22222222-2222-4222-8222-222222222222";
    expect(createIssueDocumentDecisionSchema.safeParse({ outcome: "approved", revisionId, scope: "execution_reconciliation" }).success).toBe(false);
    expect(createIssueDocumentDecisionSchema.safeParse({ outcome: "revoked", revisionId, scope: "execution_reconciliation",
      expiresAt: "2026-10-28T00:00:00.000Z" }).success).toBe(false);
    expect(createIssueDocumentDecisionSchema.safeParse({ outcome: "approved", revisionId, scope: "execution_reconciliation",
      expiresAt: "2026-10-28T00:00:00.000Z", actorAgentId: revisionId }).success).toBe(false);
  });

  it("projects the request intent with nulls for absent optional fields and without the admission", () => {
    const runId = "33333333-3333-4333-8333-333333333333";
    const intent = executionReconciliationRequestIntent({
      actionId: runId, outcome: "restored", sourceIssueStatus: "todo",
      executionReconciliation: { runId, providerStopped: true, actionOutcome: "mixed", outcomeEvidence: "evidence text",
        admission: { idempotencyKey: "ignored" } } as never,
    });
    expect(intent).toEqual({ actionId: runId, outcome: "restored", sourceIssueStatus: "todo", resolutionNote: null,
      executionReconciliation: { runId, providerStopped: true, actionOutcome: "mixed", outcomeEvidence: "evidence text",
        workspaceRepairEvidence: null } });
  });
});
