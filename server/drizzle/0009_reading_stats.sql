CREATE TABLE "app"."user_reading_activity" (
	"user_id" uuid NOT NULL,
	"activity_date" date NOT NULL,
	"active_seconds" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_reading_activity_user_id_activity_date_pk" PRIMARY KEY("user_id","activity_date"),
	CONSTRAINT "user_reading_activity_seconds_ck" CHECK ("app"."user_reading_activity"."active_seconds" between 0 and 86400)
);
--> statement-breakpoint
ALTER TABLE "app"."import_jobs" ADD COLUMN "requested_chapter_pattern" text;--> statement-breakpoint
ALTER TABLE "app"."user_reading_activity" ADD CONSTRAINT "user_reading_activity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;
