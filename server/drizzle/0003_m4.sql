CREATE TABLE "app"."apply_idempotency" (
	"key" text PRIMARY KEY NOT NULL,
	"import_job_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."import_jobs" DROP CONSTRAINT "import_jobs_status_ck";--> statement-breakpoint
ALTER TABLE "app"."apply_idempotency" ADD CONSTRAINT "apply_idempotency_import_job_id_import_jobs_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "app"."import_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "apply_idempotency_job_idx" ON "app"."apply_idempotency" USING btree ("import_job_id");--> statement-breakpoint
ALTER TABLE "app"."import_jobs" ADD CONSTRAINT "import_jobs_status_ck" CHECK ("app"."import_jobs"."status" in ('queued','processing','review_required','ready','failed','cancelled','committed','applied','reverted'));