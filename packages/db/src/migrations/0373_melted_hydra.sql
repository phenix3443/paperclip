CREATE TABLE "execution_reconciliation_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"action_id" uuid,
	"run_id" uuid,
	"idempotency_key" text NOT NULL,
	"state" text NOT NULL,
	"request_digest" text,
	"authorization_payload_digest" text,
	"expected_digest" text,
	"expected_snapshot" jsonb,
	"authorization_revision_id" uuid,
	"authorization_decision_id" uuid,
	"authorization_body_sha256" text,
	"result" jsonb,
	"actor_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_reconciliation_receipts_state_check" CHECK (("execution_reconciliation_receipts"."state" = 'committed' AND "execution_reconciliation_receipts"."action_id" IS NOT NULL AND "execution_reconciliation_receipts"."request_digest" IS NOT NULL AND "execution_reconciliation_receipts"."expected_digest" IS NOT NULL AND "execution_reconciliation_receipts"."result" IS NOT NULL)
        OR ("execution_reconciliation_receipts"."state" = 'abandoned' AND "execution_reconciliation_receipts"."action_id" IS NULL AND "execution_reconciliation_receipts"."request_digest" IS NULL AND "execution_reconciliation_receipts"."result" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "execution_reconciliation_receipts" ADD CONSTRAINT "execution_reconciliation_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_reconciliation_receipts" ADD CONSTRAINT "execution_reconciliation_receipts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_reconciliation_receipts" ADD CONSTRAINT "execution_reconciliation_receipts_action_id_issue_recovery_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."issue_recovery_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_reconciliation_receipts" ADD CONSTRAINT "execution_reconciliation_receipts_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "execution_reconciliation_receipts_company_key_uq" ON "execution_reconciliation_receipts" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_reconciliation_receipts_committed_action_uq" ON "execution_reconciliation_receipts" USING btree ("company_id","action_id") WHERE "execution_reconciliation_receipts"."state" = 'committed';--> statement-breakpoint
CREATE INDEX "execution_reconciliation_receipts_issue_idx" ON "execution_reconciliation_receipts" USING btree ("company_id","issue_id");