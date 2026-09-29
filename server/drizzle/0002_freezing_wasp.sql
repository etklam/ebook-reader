ALTER TABLE "app"."import_jobs" DROP CONSTRAINT "import_jobs_status_ck";--> statement-breakpoint
ALTER TABLE "app"."import_jobs" ADD COLUMN "apply_mode" text;--> statement-breakpoint
ALTER TABLE "app"."import_jobs" ADD COLUMN "applied_result" jsonb;--> statement-breakpoint
ALTER TABLE "app"."import_jobs" ADD CONSTRAINT "import_jobs_status_ck" CHECK ("app"."import_jobs"."status" in ('queued','processing','review_required','ready','failed','cancelled','committed','applied'));