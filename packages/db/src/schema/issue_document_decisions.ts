import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { documents } from "./documents.js";
import { documentRevisions } from "./document_revisions.js";
import { agents } from "./agents.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

export const issueDocumentDecisions = pgTable(
  "issue_document_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
    revisionId: uuid("revision_id").notNull().references(() => documentRevisions.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    bodySha256: text("body_sha256").notNull(),
    scope: text("scope").$type<"execution_reconciliation">().notNull(),
    outcome: text("outcome").$type<"approved" | "revoked">().notNull(),
    revokesDecisionId: uuid("revokes_decision_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    actorAgentId: uuid("actor_agent_id").references(() => agents.id, { onDelete: "set null" }),
    actorUserId: text("actor_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    documentIdx: index("issue_document_decisions_document_idx").on(table.companyId, table.documentId, table.createdAt),
    revokesIdx: index("issue_document_decisions_revokes_idx").on(table.revokesDecisionId),
    outcomeCheck: check(
      "issue_document_decisions_outcome_check",
      sql`(${table.outcome} = 'approved' AND ${table.expiresAt} IS NOT NULL AND ${table.revokesDecisionId} IS NULL)
        OR (${table.outcome} = 'revoked' AND ${table.expiresAt} IS NULL AND ${table.revokesDecisionId} IS NOT NULL)`,
    ),
    scopeCheck: check("issue_document_decisions_scope_check", sql`${table.scope} = 'execution_reconciliation'`),
  }),
);
