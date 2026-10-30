ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_one_target";--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "target_user_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_one_target" CHECK (num_nonnulls("audit_log"."transaction_id", "audit_log"."bank_account_id", "audit_log"."target_user_id") = 1);