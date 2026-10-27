import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { issueRecoveryActions } from "./issue_recovery_actions.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const executionReconciliationReceipts = pgTable(
  "execution_reconciliation_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    actionId: uuid("action_id").references(() => issueRecoveryActions.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    idempotencyKey: text("idempotency_key").notNull(),
    state: text("state").$type<"committed" | "abandoned">().notNull(),
    requestDigest: text("request_digest"),
    authorizationPayloadDigest: text("authorization_payload_digest"),
    expectedDigest: text("expected_digest"),
    expectedSnapshot: jsonb("expected_snapshot").$type<Record<string, unknown>>(),
    authorizationRevisionId: uuid("authorization_revision_id"),
    authorizationDecisionId: uuid("authorization_decision_id"),
    authorizationBodySha256: text("authorization_body_sha256"),
    authorizationEvidence: jsonb("authorization_evidence").$type<Record<string, unknown>>(),
    result: jsonb("result").$type<Record<string, unknown>>(),
    actorUserId: text("actor_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyKeyIdx: uniqueIndex("execution_reconciliation_receipts_company_key_uq").on(table.companyId, table.idempotencyKey),
    committedActionIdx: uniqueIndex("execution_reconciliation_receipts_committed_action_uq")
      .on(table.companyId, table.actionId)
      .where(sql`${table.state} = 'committed'`),
    issueIdx: index("execution_reconciliation_receipts_issue_idx").on(table.companyId, table.issueId),
    stateCheck: check(
      "execution_reconciliation_receipts_state_check",
      sql`(${table.state} = 'committed' AND ${table.actionId} IS NOT NULL AND ${table.requestDigest} IS NOT NULL AND ${table.expectedDigest} IS NOT NULL AND ${table.result} IS NOT NULL)
        OR (${table.state} = 'abandoned' AND ${table.actionId} IS NULL AND ${table.requestDigest} IS NULL AND ${table.result} IS NULL)`,
    ),
  }),
);
