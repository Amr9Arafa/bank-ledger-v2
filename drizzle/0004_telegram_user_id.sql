ALTER TABLE "users" ADD COLUMN "telegram_user_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_telegram_user_id_unique" UNIQUE("telegram_user_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_telegram_user_id_check" CHECK ("users"."telegram_user_id" ~ '^[0-9]+$');