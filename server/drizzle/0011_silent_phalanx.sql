CREATE TABLE "app"."content_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	"chapter_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"paragraph_index" integer NOT NULL,
	"excerpt" text NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "content_reports_status_ck" CHECK ("app"."content_reports"."status" in ('open','resolved')),
	CONSTRAINT "content_reports_paragraph_ck" CHECK ("app"."content_reports"."paragraph_index" >= 0),
	CONSTRAINT "content_reports_message_ck" CHECK (length("app"."content_reports"."message") between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "app"."user_library" ADD COLUMN "reading_status" text DEFAULT 'want' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."user_library" ADD COLUMN "group_name" text;--> statement-breakpoint
ALTER TABLE "app"."content_reports" ADD CONSTRAINT "content_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."content_reports" ADD CONSTRAINT "content_reports_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "app"."works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."content_reports" ADD CONSTRAINT "content_reports_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "app"."chapters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."content_reports" ADD CONSTRAINT "content_reports_revision_id_chapter_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "app"."chapter_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "content_reports_status_created_idx" ON "app"."content_reports" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "app"."user_library" ADD CONSTRAINT "user_library_reading_status_ck" CHECK ("app"."user_library"."reading_status" in ('want','reading','finished','paused'));--> statement-breakpoint
ALTER TABLE "app"."user_library" ADD CONSTRAINT "user_library_group_name_ck" CHECK ("app"."user_library"."group_name" is null or (length("app"."user_library"."group_name") between 1 and 40));