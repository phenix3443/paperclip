// Develop records resultJson.executionReleased (see recordRunExecutionReleased)
// once a finished run's executor is released. Strict resultJson allowlists
// accept that key only in this exact shape for the same run and task.
export function isOwnExecutionReleaseMarker(value: unknown, runId: string, issueId: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return marker.schema === "paperclip.run-execution-release.v1" && marker.runId === runId && marker.issueId === issueId &&
    typeof marker.settledAt === "string" && Object.keys(marker).every(key => ["schema", "runId", "issueId", "settledAt"].includes(key));
}
