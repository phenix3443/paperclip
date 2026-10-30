import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, companyMemberships, completionContracts, heartbeatRuns, issueRelations,
  issues, nativeRunFinalizations, nativeRunResults, statusDecisions, statusDecisionEffects, workAssessments, type Db } from "@paperclipai/db";
import { commitNativeStatusDecision } from "../../services/native-runtime/status-decision-committer.js";
import { NATIVE_STATUS_ARBITER_POLICY_VERSION } from "../../services/native-runtime/status-arbiter.js";

export async function seedNativeDependency(db: Db, agentStatus = "paused", nativeProducer = false) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), blockerId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Dependency ownership", issuePrefix: `D${companyId.slice(0, 6)}`,
      requireBoardApprovalForNewAgents: false, defaultResponsibleUserId: "responsible-user" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "responsible-user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Dependency owner", role: "engineer", status: agentStatus,
      adapterType: "codex_local", adapterConfig: {}, permissions: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Dependent", status: "todo", assigneeAgentId: agentId, responsibleUserId: "responsible-user" },
      { id: blockerId, companyId, title: "Completed blocker", status: "done", responsibleUserId: "responsible-user" },
    ]);
    const runId = randomUUID(), contractId = randomUUID(), resultId = randomUUID(), assessmentId = randomUUID(), decisionId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId, issueId: blockerId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "test", risk: "standard", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {}, canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", invocationSource: "automation",
      nativeIssueId: blockerId, completionContractId: contractId });
    await db.insert(nativeRunResults).values({ id: resultId, companyId, issueId: blockerId, runId,
      completionContractId: contractId, serverFingerprint: resultId, schemaStatus: "accepted", resultJson: {}, canonicalSha256: resultId });
    await db.insert(workAssessments).values({ id: assessmentId, companyId, issueId: blockerId, runId, contractId, resultId,
      triggerKind: "turn_finished", triggerActorCompanyId: companyId, priorIssueStatus: "in_progress", priorStatusVersion: 0,
      policyVersion: "test", assessmentJson: {}, inputDigest: assessmentId });
    if (nativeProducer) {
      await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, blockerId));
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, issueId));
      await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
      await db.insert(nativeRunFinalizations).values({ companyId, issueId: blockerId, runId, phase: "assessed", resultId, assessmentId });
      const [prior] = await db.select().from(issues).where(eq(issues.id, blockerId));
      await db.update(workAssessments).set({ priorIssueStatus: prior!.status, priorStatusVersion: Number(prior!.statusVersion) }).where(eq(workAssessments.id, assessmentId));
      await commitNativeStatusDecision({ db, companyId, issueId: blockerId, runId, assessmentId,
        priorStatus: prior!.status, priorStatusVersion: Number(prior!.statusVersion), priorDecisionId: prior!.lastStatusDecisionId,
        decision: { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, statusAction: "done", toStatus: "done",
          reasonCode: "completion_criteria_satisfied", unblockDescriptor: null, effects: [] } });
      const [intent] = await db.select().from(agentWakeupRequests).where(and(
        eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")));
      if (!intent) throw new Error("Native completion did not create a dependency intent");
      return { companyId, agentId, issueId, blockerId, runId, intent: intent! };
    }
    await db.insert(statusDecisions).values({ id: decisionId, companyId, issueId: blockerId, runId, assessmentId, decisionVersion: 1,
      policyVersion: "test", fromStatus: "in_progress", toStatus: "done", reasonCode: "completed", decisionJson: {},
      decisionDigest: decisionId, applicationState: "applied", appliedAt: new Date() });
    const [intent] = await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "automation", triggerDetail: "system",
      reason: "issue_blockers_resolved", requestedByActorType: "system", requestedByActorId: "native-status-committer",
      idempotencyKey: `issue_blockers_resolved:${issueId}:${blockerId}`, payload: { issueId, taskId: issueId, resolvedBlockerIssueId: blockerId,
        blockerIssueIds: [blockerId], _paperclipWakeContext: { issueId, taskId: issueId, source: "native_status_decision" } } }).returning();
    await db.insert(statusDecisionEffects).values({ companyId, issueId: blockerId, decisionId, ordinal: 0, effectKind: "dependency_wake",
      targetType: "agent_wakeup_request", targetId: intent!.id, idempotencyKey: `effect:${decisionId}`,
      payload: { dependentIssueId: issueId, resolvedBlockerIssueId: blockerId }, deliveryState: "delivered" });
    return { companyId, agentId, issueId, blockerId, runId, intent: intent! };
  }

