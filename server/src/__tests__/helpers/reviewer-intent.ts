import { randomUUID } from "node:crypto";
import { agents, companies, companyMemberships, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { recordRunExecutionReleased } from "../../services/heartbeat/case-handoff-lifecycle.js";
import { createReviewerAssignmentIntent } from "../../services/heartbeat/reviewer-assignment-continuation.js";

export async function seedReviewerIntent(db: Db, produce = true, limit?: null | number, released = true) {
    const companyId = randomUUID(), agentId = randomUUID(), authorId = randomUUID(), issueId = randomUUID(), stageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Consumer fixture", issuePrefix: "C" + companyId.slice(0, 7), defaultResponsibleUserId: "board" });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "board",
      membershipRole: "operator", status: "active" });
    await db.insert(agents).values([
      { id: agentId, companyId, name: "Reviewer", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
      { id: authorId, companyId, name: "Author", role: "engineer", status: "idle", adapterType: "process", runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } } },
    ]);
    const [issue] = await db.insert(issues).values({ id: issueId, companyId, title: "Pending review", status: "in_review",
      responsibleUserId: "board", assigneeAgentId: agentId,
      executionPolicy: { mode: "normal", commentRequired: true, ...(limit === undefined ? {} : { maxReviewRounds: limit }), stages: [{ id: stageId, type: "review", approvalsNeeded: 1,
        participants: [{ id: randomUUID(), type: "agent", agentId }] }] },
      executionState: { status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: { type: "agent", agentId }, returnAssignee: { type: "agent", agentId: authorId },
        completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null, changesRequestedCount: 2,
        reviewRequest: { instructions: "Review the same submission" } } }).returning();
    const [source] = await db.insert(heartbeatRuns).values({ companyId, agentId: authorId, status: "cancelled",
      errorCode: "issue_reassigned", finishedAt: new Date(), responsibleUserId: "board", contextSnapshot: { issueId },
      resultJson: { executionCancellation: { state: "acknowledged" }, reassignmentStopConfirmed: true } }).returning();
    if (released) await recordRunExecutionReleased(db, source.id, issueId);
    const receipt = produce ? await db.transaction(tx => createReviewerAssignmentIntent(tx, { companyId, issueId, sourceRunId: source.id,
      requestedByActorType: "agent", requestedByActorId: authorId })) : null;
    return { companyId, agentId, issueId, source, issue, receipt: receipt! };
  }
