import { sql, type SQLWrapper } from "drizzle-orm";
import { agentWakeupRequests } from "@paperclipai/db";
import { REVIEWER_ASSIGNMENT_CONTINUATION_KEY } from "./domain/receipt-namespace.js";

export { hasReviewerAssignmentContinuation } from "./domain/receipt-namespace.js";

export function ordinaryWakeRequestPredicate(payload: SQLWrapper = agentWakeupRequests.payload) {
  return sql`NOT COALESCE(${payload} ? ${REVIEWER_ASSIGNMENT_CONTINUATION_KEY}, false)`;
}

export function ordinaryWakeRequestSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error("Invalid wake request SQL alias");
  return `NOT COALESCE(${alias}.payload ? '${REVIEWER_ASSIGNMENT_CONTINUATION_KEY}', false)`;
}
