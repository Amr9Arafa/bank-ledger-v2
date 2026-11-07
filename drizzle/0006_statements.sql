CREATE TABLE "statement_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"bank" text NOT NULL,
	"format" text NOT NULL,
	"file_name" text NOT NULL,
	"statement_ref" text NOT NULL,
	"raw_text" text NOT NULL,
	"opening_date" date NOT NULL,
	"opening_balance_minor" bigint NOT NULL,
	"closing_date" date NOT NULL,
	"closing_balance_minor" bigint NOT NULL,
	"line_count" integer NOT NULL,
	"skipped_line_count" integer NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statement_imports_bank_check" CHECK ("statement_imports"."bank" in ('nbe', 'cib')),
	CONSTRAINT "statement_imports_format_check" CHECK ("statement_imports"."format" in ('mt940', 'csv')),
	CONSTRAINT "statement_imports_period_check" CHECK ("statement_imports"."closing_date" >= "statement_imports"."opening_date"),
	CONSTRAINT "statement_imports_counts_check" CHECK ("statement_imports"."line_count" >= 0 and "statement_imports"."skipped_line_count" between 0 and "statement_imports"."line_count")
);
--> statement-breakpoint
ALTER TABLE "statement_imports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"booking_date" date NOT NULL,
	"value_date" date NOT NULL,
	"direction" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"type_code" text NOT NULL,
	"customer_ref" text NOT NULL,
	"bank_ref" text NOT NULL,
	"description" text NOT NULL,
	"payment_ref" text,
	"kind" text NOT NULL,
	"counterparty" text,
	"cheque_ref" text,
	"line_key" text NOT NULL,
	"status" text NOT NULL,
	"ignore_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statement_lines_direction_check" CHECK ("statement_lines"."direction" in ('credit', 'debit')),
	CONSTRAINT "statement_lines_amount_positive" CHECK ("statement_lines"."amount_minor" > 0),
	CONSTRAINT "statement_lines_kind_check" CHECK ("statement_lines"."kind" in ('incoming_transfer', 'outgoing_transfer', 'account_transfer', 'cheque', 'fee', 'interest', 'other')),
	CONSTRAINT "statement_lines_status_check" CHECK ("statement_lines"."status" in ('unmatched', 'matched', 'created', 'ignored', 'before_start')),
	CONSTRAINT "statement_lines_ignore_reason_check" CHECK (("statement_lines"."status" = 'ignored') = ("statement_lines"."ignore_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "statement_lines" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "statement_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"statement_line_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"cleared_cheque" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "statement_matches_statement_line_id_unique" UNIQUE("statement_line_id"),
	CONSTRAINT "statement_matches_transaction_id_unique" UNIQUE("transaction_id"),
	CONSTRAINT "statement_matches_origin_check" CHECK ("statement_matches"."origin" in ('matched', 'created'))
);
--> statement-breakpoint
ALTER TABLE "statement_matches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_type_check";--> statement-breakpoint
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_import_id_statement_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."statement_imports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_lines" ADD CONSTRAINT "statement_lines_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_matches" ADD CONSTRAINT "statement_matches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_matches" ADD CONSTRAINT "statement_matches_statement_line_id_statement_lines_id_fk" FOREIGN KEY ("statement_line_id") REFERENCES "public"."statement_lines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_matches" ADD CONSTRAINT "statement_matches_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_matches" ADD CONSTRAINT "statement_matches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "statement_imports_ref_per_account" ON "statement_imports" USING btree ("bank_account_id","statement_ref");--> statement-breakpoint
CREATE INDEX "statement_imports_account_period" ON "statement_imports" USING btree ("bank_account_id","closing_date");--> statement-breakpoint
CREATE UNIQUE INDEX "statement_lines_key_per_account" ON "statement_lines" USING btree ("bank_account_id","line_key");--> statement-breakpoint
CREATE UNIQUE INDEX "statement_lines_import_line" ON "statement_lines" USING btree ("import_id","line_no");--> statement-breakpoint
CREATE INDEX "statement_lines_account_status" ON "statement_lines" USING btree ("bank_account_id","status","booking_date");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_type_check" CHECK ("transactions"."type" in ('transfer_in', 'deposit', 'internal_in', 'interest', 'transfer_out', 'cheque', 'fee', 'internal_out'));