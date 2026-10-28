import { sql, type SQLWrapper } from "drizzle-orm";

export function isOwnExecutionReleaseMarker(value: unknown, runId: string, issueId: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return marker.schema === "paperclip.run-execution-release.v1" && marker.runId === runId && marker.issueId === issueId &&
    typeof marker.settledAt === "string" && Object.keys(marker).every(key => ["schema", "runId", "issueId", "settledAt"].includes(key));
}

export function ownExecutionReleaseMarkerSql(resultJson: SQLWrapper, runId: SQLWrapper, issueId: string) {
  return sql`coalesce(jsonb_typeof(${resultJson}->'executionReleased') = 'object'
    and ${resultJson}#>>'{executionReleased,schema}' = 'paperclip.run-execution-release.v1'
    and ${resultJson}#>>'{executionReleased,runId}' = ${runId}::text
    and ${resultJson}#>>'{executionReleased,issueId}' = ${issueId}
    and jsonb_typeof(${resultJson}#>'{executionReleased,settledAt}') = 'string'
    and (${resultJson}->'executionReleased') - 'schema' - 'runId' - 'issueId' - 'settledAt' = '{}'::jsonb, false)`;
}
