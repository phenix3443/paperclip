import { and, asc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  agentWakeupRequests,
  approvals,
  companies,
  issueApprovals,
  issueThreadInteractions,
  projects,
  environmentLeases,
  heartbeatRuns,
  issueRecoveryActions,
  issueRelations,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import type { ExpectedReconciliationState } from "@paperclipai/shared";
import { isConversation } from "./agent-conversations.js";
import { DIRECT_NON_INVOKABLE_STATUSES } from "./agent-invokability.js";
import { budgetServiceInTransaction } from "./budgets.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { executionReconciliationRefusal } from "./execution-reconciliation-receipts.js";

type DbOrTransaction = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

const TERMINAL_RUN_STATUSES = ["failed", "interrupted", "timed_out", "cancelled"];
const ACTIVE_MEMBER_RUN_STATUSES = ["queued", "running", "scheduled_retry"];
const ACTIVE_WAKE_STATUSES = ["queued", "claimed", "deferred_issue_execution"];
const SETTLED_COORDINATOR_PHASES = ["committed", "terminal_failure"];

function memberRunPredicate(companyId: string, issueId: string, sourceRunId: string) {
  return and(
    eq(heartbeatRuns.companyId, companyId),
    ne(heartbeatRuns.id, sourceRunId),
    or(
      eq(heartbeatRuns.issueId, issueId),
      eq(heartbeatRuns.nativeIssueId, issueId),
      sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
      sql`${heartbeatRuns.contextSnapshot} ->> 'taskId' = ${issueId}`,
      sql`${heartbeatRuns.contextSnapshot} ->> 'taskKey' = ${issueId}`,
      sql`${heartbeatRuns.contextSnapshot} -> 'paperclipIssue' ->> 'id' = ${issueId}`,
      eq(heartbeatRuns.retryOfRunId, sourceRunId),
      sql`${heartbeatRuns.contextSnapshot} ->> 'previousRunId' = ${sourceRunId}`,
    ),
  );
}

export type LockedAdmissionRows = Awaited<ReturnType<typeof lockAdmissionRows>>;

export async function lockAdmissionRows(
  tx: DbOrTransaction,
  input: { companyId: string; issueId: string; runId: string },
) {
  const { companyId, issueId, runId } = input;
  const blockers = await tx
    .select({ id: issues.id, status: issues.status })
    .from(issues)
    .where(and(
      eq(issues.companyId, companyId),
      inArray(issues.id, tx.select({ id: issueRelations.issueId }).from(issueRelations).where(and(
        eq(issueRelations.companyId, companyId),
        eq(issueRelations.relatedIssueId, issueId),
        eq(issueRelations.type, "blocks"),
      ))),
    ))
    .orderBy(asc(issues.id))
    .for("share");
  const actions = await tx
    .select({ id: issueRecoveryActions.id, status: issueRecoveryActions.status })
    .from(issueRecoveryActions)
    .where(and(eq(issueRecoveryActions.companyId, companyId), eq(issueRecoveryActions.sourceIssueId, issueId)))
    .orderBy(asc(issueRecoveryActions.id))
    .for("update");
  const wakes = await tx
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(and(
      eq(agentWakeupRequests.companyId, companyId),
      sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issueId}`,
      inArray(agentWakeupRequests.status, ACTIVE_WAKE_STATUSES),
    ))
    .orderBy(asc(agentWakeupRequests.id))
    .for("update");
  const [coordinator] = await tx
    .select()
    .from(nativeRunFinalizations)
    .where(and(eq(nativeRunFinalizations.companyId, companyId), eq(nativeRunFinalizations.runId, runId)))
    .for("update");
  const [run] = await tx
    .select()
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, runId)))
    .for("update");
  const activeMemberRuns = await tx
    .select({ id: heartbeatRuns.id, status: heartbeatRuns.status })
    .from(heartbeatRuns)
    .where(and(memberRunPredicate(companyId, issueId, runId), inArray(heartbeatRuns.status, ACTIVE_MEMBER_RUN_STATUSES)))
    .orderBy(asc(heartbeatRuns.id))
    .for("update");
  const leases = await tx
    .select({ id: environmentLeases.id, status: environmentLeases.status })
    .from(environmentLeases)
    .where(and(eq(environmentLeases.companyId, companyId), eq(environmentLeases.heartbeatRunId, runId)))
    .orderBy(asc(environmentLeases.id))
    .for("share");
  return { blockers, actions, wakes, coordinator: coordinator ?? null, run: run ?? null, activeMemberRuns, leases };
}

export async function admitExecutionReconciliationRuns(
  tx: DbOrTransaction,
  input: {
    issue: typeof issues.$inferSelect;
    actionId: string;
    locked: LockedAdmissionRows;
    unstartedRunIds: string[];
  },
) {
  const { issue, locked } = input;
  const run = locked.run;
  if (!run || !TERMINAL_RUN_STATUSES.includes(run.status) || !run.finishedAt) {
    throw executionReconciliationRefusal("run_not_settled", "The source run has not reached a terminal status.");
  }
  if (isConversation(issue)) {
    throw executionReconciliationRefusal("issue_kind_not_supported", "Admission does not support a conversation task.");
  }
  const coordinator = locked.coordinator;
  if (coordinator && (
    coordinator.leaseOwner ||
    !SETTLED_COORDINATOR_PHASES.includes(coordinator.phase) ||
    (coordinator.failureDetail as { successorRunId?: unknown } | null)?.successorRunId
  )) {
    throw executionReconciliationRefusal("run_not_settled", "The run finalization is not settled.", { reason: "coordinator" });
  }
  if (locked.actions.some((action) => action.id !== input.actionId && ["active", "escalated"].includes(action.status))) {
    throw executionReconciliationRefusal("newer_execution_exists", "Another recovery action is open on this task.",
      { reason: "recovery_action" });
  }
  if (locked.activeMemberRuns.length > 0) {
    throw executionReconciliationRefusal("newer_execution_exists", "Another run for this task is queued or running.",
      { reason: "active_run" });
  }
  if (locked.wakes.length > 0) {
    throw executionReconciliationRefusal("newer_execution_exists", "A wake for this task is pending.", { reason: "pending_wake" });
  }
  const finishedAt = run.finishedAt;
  const newer = await tx
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(and(
      memberRunPredicate(issue.companyId, issue.id, run.id),
      or(
        sql`${heartbeatRuns.createdAt} >= ${finishedAt.toISOString()}::timestamptz`,
        sql`${heartbeatRuns.finishedAt} > ${finishedAt.toISOString()}::timestamptz`,
        eq(heartbeatRuns.retryOfRunId, run.id),
        sql`${heartbeatRuns.contextSnapshot} ->> 'previousRunId' = ${run.id}`,
      ),
    ))
    .orderBy(asc(heartbeatRuns.id));
  const exempt = new Set(input.unstartedRunIds);
  const blocking = newer.filter((row) => !exempt.has(row.id));
  if (blocking.length > 0) {
    throw executionReconciliationRefusal("newer_execution_exists", "A newer run exists for this task.", { reason: "newer_run" });
  }
}

const gateClosed = (gate: Parameters<typeof gateCode>[0], message: string, details?: Record<string, unknown>) =>
  executionReconciliationRefusal(gateCode(gate), message, details);
function gateCode<G extends "dependency" | "interaction" | "approval" | "subtree_pause" | "project_pause" | "company_pause"
  | "agent_pause" | "budget" | "monitor" | "workspace" | "checkout" | "owner">(gate: G) {
  return `gate_closed:${gate}` as const;
}

export async function admitExecutionReconciliationGates(
  tx: DbOrTransaction,
  input: {
    issue: typeof issues.$inferSelect;
    action: { returnOwnerAgentId: string | null };
    locked: LockedAdmissionRows;
    expected: ExpectedReconciliationState;
  },
) {
  const { issue, locked } = input;
  const run = locked.run!;
  const ownerAgentId = issue.assigneeAgentId;
  if (!ownerAgentId || ownerAgentId !== input.action.returnOwnerAgentId || ownerAgentId !== run.agentId) {
    throw gateClosed("owner", "The assignee, the recorded return owner and the source run agent differ.");
  }
  if ([issue.checkoutRunId, issue.executionRunId].some((runId) => runId && runId !== run.id)) {
    throw gateClosed("checkout", "Another run holds the task checkout or execution lock.");
  }
  if (issue.monitorNextCheckAt) {
    throw gateClosed("monitor", "The task has a scheduled monitor.");
  }
  if (issue.workspaceBindingRevision !== input.expected.issue.workspaceBindingRevision || issue.workspacePendingSelection != null) {
    throw gateClosed("workspace", "The workspace binding changed or a workspace selection is pending.");
  }
  const openBlocker = locked.blockers.find((blocker) => !["done", "cancelled"].includes(blocker.status));
  if (openBlocker) {
    throw gateClosed("dependency", "A blocking task is not done.", { blockerIssueId: openBlocker.id });
  }
  const [interaction] = await tx.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions)
    .where(and(
      eq(issueThreadInteractions.companyId, issue.companyId),
      eq(issueThreadInteractions.issueId, issue.id),
      eq(issueThreadInteractions.status, "pending"),
    ))
    .limit(1);
  if (interaction) throw gateClosed("interaction", "The task has a pending interaction.");
  const [approval] = await tx.select({ id: approvals.id }).from(issueApprovals)
    .innerJoin(approvals, eq(approvals.id, issueApprovals.approvalId))
    .where(and(eq(issueApprovals.issueId, issue.id), inArray(approvals.status, ["pending", "revision_requested"])))
    .limit(1);
  if (approval) throw gateClosed("approval", "The task has a pending approval.");
  const pauseHold = await issueTreeControlService(tx as unknown as Db).getActivePauseHoldGate(issue.companyId, issue.id);
  if (pauseHold) throw gateClosed("subtree_pause", "An active subtree pause covers the task.", { holdId: pauseHold.holdId });
  const [company] = await tx.select({ status: companies.status }).from(companies).where(eq(companies.id, issue.companyId));
  if (company?.status !== "active") throw gateClosed("company_pause", "The company is not active.");
  if (issue.projectId) {
    const [project] = await tx.select({ pausedAt: projects.pausedAt }).from(projects)
      .where(and(eq(projects.companyId, issue.companyId), eq(projects.id, issue.projectId)));
    if (project?.pausedAt) throw gateClosed("project_pause", "The project is paused.");
  }
  const [agent] = await tx.select({ status: agents.status }).from(agents)
    .where(and(eq(agents.companyId, issue.companyId), eq(agents.id, ownerAgentId)));
  if (!agent || DIRECT_NON_INVOKABLE_STATUSES.has(agent.status as never)) {
    throw gateClosed("agent_pause", "The owner agent cannot be invoked.");
  }
  const budgetBlock = await budgetServiceInTransaction(tx as unknown as Db)
    .getInvocationBlock(issue.companyId, ownerAgentId, { issueId: issue.id, projectId: issue.projectId });
  if (budgetBlock) throw gateClosed("budget", "A budget or pause gate blocks the owner agent.");
}
