export const REWORK_HANDBACK_CONTINUATION_SOURCE = "issue.rework_handback_continuation_recovery";
export const REWORK_HANDBACK_CONTINUATION_KEY_PREFIX = "issue_rework_handback_continuation:";

export function reworkHandbackContinuationKey(input: {
  issueId: string;
  lastStatusDecisionId: string | null;
  statusVersion: number;
  parkedRunId: string;
}) {
  return `${REWORK_HANDBACK_CONTINUATION_KEY_PREFIX}${input.issueId}:${input.lastStatusDecisionId ?? "none"}:${input.statusVersion}:${input.parkedRunId}`;
}

export function reworkHandbackContinuationKeyRunId(key: string) {
  if (!key.startsWith(REWORK_HANDBACK_CONTINUATION_KEY_PREFIX)) return null;
  return key.slice(key.lastIndexOf(":") + 1) || null;
}
