// Native rework hand-back: the reviewer requested changes and the issue is
// back with its executor agent. The native execution state is authoritative
// here; heuristic waits (such as a review-wait continuation summary) must not
// override it.

export type ReworkHandbackIssueFacts = {
  status: string | null | undefined;
  assigneeAgentId: string | null | undefined;
  assigneeUserId: string | null | undefined;
  executionState: unknown;
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function isNativeReworkHandback(
  issue: ReworkHandbackIssueFacts | null | undefined,
  agentId: string | null | undefined,
): boolean {
  if (!issue || !agentId) return false;
  if (issue.status !== "in_progress") return false;
  if (issue.assigneeUserId) return false;
  if (issue.assigneeAgentId !== agentId) return false;
  const state = readRecord(issue.executionState);
  if (!state || state.status !== "changes_requested") return false;
  const returnAssignee = readRecord(state.returnAssignee);
  return returnAssignee?.type === "agent" && returnAssignee.agentId === agentId;
}
