CREATE TABLE "app"."bookmarks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	"chapter_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"paragraph_index" integer DEFAULT 0 NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookmarks_paragraph_ck" CHECK ("app"."bookmarks"."paragraph_index" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."publication_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"release_id" uuid NOT NULL,
	"release_version" integer NOT NULL,
	"event_type" text DEFAULT 'published' NOT NULL,
	"new_chapter_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_chapter_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "publication_events_release_uq" UNIQUE("release_id")
);
--> statement-breakpoint
CREATE TABLE "app"."reader_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"theme" text NOT NULL,
	"font_size" integer NOT NULL,
	"line_height" real NOT NULL,
	"paragraph_spacing" real NOT NULL,
	"conversion_mode" text NOT NULL,
	"reading_mode" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reader_preferences_font_ck" CHECK ("app"."reader_preferences"."font_size" between 14 and 28),
	CONSTRAINT "reader_preferences_line_height_ck" CHECK ("app"."reader_preferences"."line_height" between 1.4 and 2.6),
	CONSTRAINT "reader_preferences_spacing_ck" CHECK ("app"."reader_preferences"."paragraph_spacing" between 0 and 3)
);
--> statement-breakpoint
CREATE TABLE "app"."reading_progress" (
	"user_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	"chapter_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"paragraph_index" integer DEFAULT 0 NOT NULL,
	"fraction" real,
	"sync_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reading_progress_user_id_work_id_pk" PRIMARY KEY("user_id","work_id"),
	CONSTRAINT "reading_progress_paragraph_ck" CHECK ("app"."reading_progress"."paragraph_index" >= 0),
	CONSTRAINT "reading_progress_sync_ck" CHECK ("app"."reading_progress"."sync_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "app"."registration_invites" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."release_items" (
	"release_id" uuid NOT NULL,
	"chapter_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"editorial_position" integer NOT NULL,
	"volume_id" uuid,
	"label_raw" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	CONSTRAINT "release_items_release_id_chapter_id_pk" PRIMARY KEY("release_id","chapter_id"),
	CONSTRAINT "release_items_position_uq" UNIQUE("release_id","editorial_position")
);
--> statement-breakpoint
CREATE TABLE "app"."user_chapter_reads" (
	"user_id" uuid NOT NULL,
	"chapter_id" uuid NOT NULL,
	"release_version" integer,
	"first_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_read_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_chapter_reads_user_id_chapter_id_pk" PRIMARY KEY("user_id","chapter_id")
);
--> statement-breakpoint
CREATE TABLE "app"."user_follows" (
	"user_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	"last_seen_release_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_follows_user_id_work_id_pk" PRIMARY KEY("user_id","work_id")
);
--> statement-breakpoint
CREATE TABLE "app"."user_library" (
	"user_id" uuid NOT NULL,
	"work_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_library_user_id_work_id_pk" PRIMARY KEY("user_id","work_id")
);
--> statement-breakpoint
CREATE TABLE "app"."work_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"idempotency_key" text,
	"note" text DEFAULT '' NOT NULL,
	"chapter_count" integer NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_releases_work_version_uq" UNIQUE("work_id","version"),
	CONSTRAINT "work_releases_idempotency_uq" UNIQUE("idempotency_key"),
	CONSTRAINT "work_releases_id_work_uq" UNIQUE("id","work_id"),
	CONSTRAINT "work_releases_version_ck" CHECK ("app"."work_releases"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "app"."bookmarks" ADD CONSTRAINT "bookmarks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."bookmarks" ADD CONSTRAINT "bookmarks_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "app"."works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."bookmarks" ADD CONSTRAINT "bookmarks_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "app"."chapters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."bookmarks" ADD CONSTRAINT "bookmarks_revision_id_chapter_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "app"."chapter_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."publication_events" ADD CONSTRAINT "publication_events_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "app"."works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."publication_events" ADD CONSTRAINT "publication_events_release_id_work_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "app"."work_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."reader_preferences" ADD CONSTRAINT "reader_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."reading_progress" ADD CONSTRAINT "reading_progress_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."reading_progress" ADD CONSTRAINT "reading_progress_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "app"."works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."reading_progress" ADD CONSTRAINT "reading_progress_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "app"."chapters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."reading_progress" ADD CONSTRAINT "reading_progress_revision_id_chapter_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "app"."chapter_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."registration_invites" ADD CONSTRAINT "registration_invites_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."registration_invites" ADD CONSTRAINT "registration_invites_used_by_user_id_users_id_fk" FOREIGN KEY ("used_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."release_items" ADD CONSTRAINT "release_items_release_id_work_releases_id_fk" FOREIGN KEY ("release_id") REFERENCES "app"."work_releases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."release_items" ADD CONSTRAINT "release_items_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "app"."chapters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."release_items" ADD CONSTRAINT "release_items_revision_id_chapter_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "app"."chapter_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."release_items" ADD CONSTRAINT "release_items_volume_id_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "app"."volumes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_chapter_reads" ADD CONSTRAINT "user_chapter_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_chapter_reads" ADD CONSTRAINT "user_chapter_reads_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "app"."chapters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_follows" ADD CONSTRAINT "user_follows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_follows" ADD CONSTRAINT "user_follows_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "app"."works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_library" ADD CONSTRAINT "user_library_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_library" ADD CONSTRAINT "user_library_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "app"."works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_releases" ADD CONSTRAINT "work_releases_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "app"."works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_releases" ADD CONSTRAINT "work_releases_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bookmarks_user_work_idx" ON "app"."bookmarks" USING btree ("user_id","work_id");--> statement-breakpoint
CREATE INDEX "bookmarks_user_chapter_idx" ON "app"."bookmarks" USING btree ("user_id","chapter_id");--> statement-breakpoint
CREATE INDEX "publication_events_work_idx" ON "app"."publication_events" USING btree ("work_id","release_version");--> statement-breakpoint
CREATE INDEX "release_items_revision_idx" ON "app"."release_items" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "user_chapter_reads_user_idx" ON "app"."user_chapter_reads" USING btree ("user_id","last_read_at");--> statement-breakpoint
CREATE INDEX "user_follows_user_idx" ON "app"."user_follows" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_library_user_idx" ON "app"."user_library" USING btree ("user_id","updated_at");--> statement-breakpoint
-- active release pointer: composite FK via work_releases(id, work_id) candidate
-- key — a work can never point at another work's release (hand-added, same
-- pattern as chapters.head_revision_id)
ALTER TABLE "app"."works" ADD CONSTRAINT "works_active_release_fk" FOREIGN KEY ("active_release_id", "id") REFERENCES "app"."work_releases"("id", "work_id") ON DELETE no action ON UPDATE no action;
