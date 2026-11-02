export const EXECUTION_DECISION_INPUT_KEYS = [
  "status", "assigneeAgentId", "assigneeUserId", "responsibleUserId", "createdByUserId",
  "executionPolicy", "executionState", "monitorNextCheckAt", "monitorWakeRequestedAt",
  "monitorLastTriggeredAt", "monitorAttemptCount", "monitorNotes", "monitorScheduledBy",
] as const;

export type ExecutionDecisionInputs = Partial<Record<typeof EXECUTION_DECISION_INPUT_KEYS[number], unknown>>;

function canonicalJson(value: unknown): string {
  if (value == null) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("Execution decision inputs must be JSON values");
  return json;
}

export async function executionDecisionInputsDigest(issue: ExecutionDecisionInputs): Promise<string> {
  const snapshot = Object.fromEntries(EXECUTION_DECISION_INPUT_KEYS.map(key => {
    const value = issue[key] ?? null;
    const timestamp = key === "monitorNextCheckAt" || key === "monitorWakeRequestedAt" || key === "monitorLastTriggeredAt";
    return [key, timestamp && typeof value === "string" ? new Date(value).toISOString() : value];
  }));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(snapshot)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
