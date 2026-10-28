CREATE TABLE "pending_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"type" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"raw_text" text,
	"image_url" text,
	"extracted" jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"resulting_record_id" uuid,
	"external_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_entries_external_message_id_unique" UNIQUE("external_message_id"),
	CONSTRAINT "pending_entries_type_check" CHECK ("pending_entries"."type" in ('transaction', 'cheque')),
	CONSTRAINT "pending_entries_source_check" CHECK ("pending_entries"."source" in ('web', 'telegram')),
	CONSTRAINT "pending_entries_status_check" CHECK ("pending_entries"."status" in ('pending', 'approved', 'rejected')),
	CONSTRAINT "pending_entries_input_check" CHECK ("pending_entries"."status" = 'rejected' or num_nonnulls("pending_entries"."raw_text", "pending_entries"."image_url") > 0),
	CONSTRAINT "pending_entries_review_check" CHECK (("pending_entries"."status" = 'pending') = ("pending_entries"."reviewed_by" is null and "pending_entries"."reviewed_at" is null)),
	CONSTRAINT "pending_entries_result_check" CHECK (("pending_entries"."status" = 'approved') = ("pending_entries"."resulting_record_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "pending_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pending_entries" ADD CONSTRAINT "pending_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_entries" ADD CONSTRAINT "pending_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_entries" ADD CONSTRAINT "pending_entries_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_entries" ADD CONSTRAINT "pending_entries_resulting_record_id_transactions_id_fk" FOREIGN KEY ("resulting_record_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pending_entries_inbox" ON "pending_entries" USING btree ("organization_id","status","created_at");