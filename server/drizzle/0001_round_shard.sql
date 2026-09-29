CREATE TABLE "app"."import_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_job_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"volume_label" text,
	"label_raw" text NOT NULL,
	"parsed_label" jsonb,
	"title" text DEFAULT '' NOT NULL,
	"content_key" text NOT NULL,
	"body_hash" text NOT NULL,
	"snippet" text DEFAULT '' NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	CONSTRAINT "import_items_job_position_uq" UNIQUE("import_job_id","position")
);
--> statement-breakpoint
CREATE TABLE "app"."import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid,
	"source_file_id" uuid NOT NULL,
	"requested_by_user_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"detected_format" text,
	"requested_encoding" text,
	"detected_encoding" text,
	"encoding_result" jsonb,
	"chapter_count" integer,
	"processor_version" text NOT NULL,
	"error_code" text,
	"error_detail" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"committed_work_id" uuid,
	"committed_chapter_count" integer,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_jobs_status_ck" CHECK ("app"."import_jobs"."status" in ('queued','processing','review_required','ready','failed','cancelled','committed'))
);
--> statement-breakpoint
-- (drizzle-kit diff artifact removed: tags unique was already correctly named
-- tags_display_name_unique in 0000; the 0000 snapshot mis-recorded it)
ALTER TABLE "app"."import_items" ADD CONSTRAINT "import_items_import_job_id_import_jobs_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "app"."import_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."import_jobs" ADD CONSTRAINT "import_jobs_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "app"."works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."import_jobs" ADD CONSTRAINT "import_jobs_source_file_id_source_files_id_fk" FOREIGN KEY ("source_file_id") REFERENCES "app"."source_files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."import_jobs" ADD CONSTRAINT "import_jobs_requested_by_user_id_users_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_items_job_idx" ON "app"."import_items" USING btree ("import_job_id","position");--> statement-breakpoint
CREATE INDEX "import_jobs_status_created_idx" ON "app"."import_jobs" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "app"."volumes" ADD CONSTRAINT "volumes_id_work_uq" UNIQUE("id","work_id");--> statement-breakpoint
ALTER TABLE "app"."chapters" ADD CONSTRAINT "chapters_volume_id_work_id_volumes_id_work_id_fk" FOREIGN KEY ("volume_id","work_id") REFERENCES "app"."volumes"("id","work_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."users" ADD CONSTRAINT "users_role_ck" CHECK ("app"."users"."role" in ('admin','member'));--> statement-breakpoint
ALTER TABLE "app"."works" ADD CONSTRAINT "works_work_type_ck" CHECK ("app"."works"."work_type" in ('short_story','serial'));--> statement-breakpoint
ALTER TABLE "app"."works" ADD CONSTRAINT "works_serial_status_ck" CHECK ("app"."works"."serial_status" is null or "app"."works"."serial_status" in ('ongoing','completed','paused'));--> statement-breakpoint
ALTER TABLE "app"."works" ADD CONSTRAINT "works_type_status_ck" CHECK (("app"."works"."work_type" = 'serial') or ("app"."works"."work_type" = 'short_story' and "app"."works"."serial_status" is null));--> statement-breakpoint
ALTER TABLE "app"."works" ADD CONSTRAINT "works_visibility_ck" CHECK ("app"."works"."visibility" in ('draft','public','unlisted','removed'));