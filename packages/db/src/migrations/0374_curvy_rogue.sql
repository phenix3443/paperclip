CREATE TABLE "issue_document_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"body_sha256" text NOT NULL,
	"scope" text NOT NULL,
	"outcome" text NOT NULL,
	"revokes_decision_id" uuid,
	"expires_at" timestamp with time zone,
	"actor_agent_id" uuid,
	"actor_user_id" text,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "issue_document_decisions_outcome_check" CHECK (("issue_document_decisions"."outcome" = 'approved' AND "issue_document_decisions"."expires_at" IS NOT NULL AND "issue_document_decisions"."revokes_decision_id" IS NULL)
        OR ("issue_document_decisions"."outcome" = 'revoked' AND "issue_document_decisions"."expires_at" IS NULL AND "issue_document_decisions"."revokes_decision_id" IS NOT NULL)),
	CONSTRAINT "issue_document_decisions_scope_check" CHECK ("issue_document_decisions"."scope" = 'execution_reconciliation')
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "execution_reconciliation_authority" jsonb DEFAULT '{"agentIds":[]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_document_decisions" ADD CONSTRAINT "issue_document_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_document_decisions" ADD CONSTRAINT "issue_document_decisions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_document_decisions" ADD CONSTRAINT "issue_document_decisions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_document_decisions" ADD CONSTRAINT "issue_document_decisions_revision_id_document_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_document_decisions" ADD CONSTRAINT "issue_document_decisions_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_document_decisions" ADD CONSTRAINT "issue_document_decisions_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_document_decisions_document_idx" ON "issue_document_decisions" USING btree ("company_id","document_id","created_at");--> statement-breakpoint
CREATE INDEX "issue_document_decisions_revokes_idx" ON "issue_document_decisions" USING btree ("revokes_decision_id");