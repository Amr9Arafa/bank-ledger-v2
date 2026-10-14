CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"transaction_id" uuid,
	"bank_account_id" uuid,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_one_target" CHECK (num_nonnulls("audit_log"."transaction_id", "audit_log"."bank_account_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"bank_name" text NOT NULL,
	"account_number" text NOT NULL,
	"currency" text DEFAULT 'EGP' NOT NULL,
	"opening_balance_minor" bigint NOT NULL,
	"opening_date" date NOT NULL,
	"receives_transfers" boolean DEFAULT true NOT NULL,
	"issues_cheques" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_accounts_currency_check" CHECK ("bank_accounts"."currency" = 'EGP')
);
--> statement-breakpoint
ALTER TABLE "bank_accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"type" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"party_name" text,
	"reference" text,
	"description" text,
	"cheque_number" text,
	"transaction_date" date NOT NULL,
	"due_date" date,
	"status" text NOT NULL,
	"cleared_date" date,
	"transfer_group_id" uuid,
	"status_reason" text,
	"notes" text,
	"created_by" uuid NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_type_check" CHECK ("transactions"."type" in ('transfer_in', 'deposit', 'internal_in', 'cheque', 'fee', 'internal_out')),
	CONSTRAINT "transactions_amount_positive" CHECK ("transactions"."amount_minor" > 0),
	CONSTRAINT "transactions_cheque_number_check" CHECK (("transactions"."type" = 'cheque') = ("transactions"."cheque_number" is not null)),
	CONSTRAINT "transactions_status_check" CHECK (("transactions"."type" = 'cheque' and "transactions"."status" in ('issued', 'cleared', 'cancelled'))
        or ("transactions"."type" <> 'cheque' and "transactions"."status" in ('active', 'voided'))),
	CONSTRAINT "transactions_cleared_date_check" CHECK (("transactions"."status" = 'cleared') = ("transactions"."cleared_date" is not null)),
	CONSTRAINT "transactions_transfer_group_check" CHECK (("transactions"."type" in ('internal_in', 'internal_out')) = ("transactions"."transfer_group_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "transactions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"language" text DEFAULT 'ar' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_role_check" CHECK ("users"."role" in ('admin', 'accountant', 'viewer')),
	CONSTRAINT "users_language_check" CHECK ("users"."language" in ('ar', 'en'))
);
--> statement-breakpoint
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_transaction" ON "audit_log" USING btree ("transaction_id");--> statement-breakpoint
CREATE INDEX "bank_accounts_org" ON "bank_accounts" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "cheque_number_per_account" ON "transactions" USING btree ("bank_account_id","cheque_number") WHERE "transactions"."type" = 'cheque';--> statement-breakpoint
CREATE INDEX "ledger_order" ON "transactions" USING btree ("bank_account_id","transaction_date","created_at");--> statement-breakpoint
CREATE INDEX "transactions_transfer_group" ON "transactions" USING btree ("transfer_group_id");