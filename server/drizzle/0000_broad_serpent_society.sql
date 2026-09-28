CREATE TABLE "app"."categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "categories_display_name_unique" UNIQUE("display_name")
);
--> statement-breakpoint
CREATE TABLE "app"."chapter_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chapter_id" uuid NOT NULL,
	"title" text NOT NULL,
	"content_key" text NOT NULL,
	"body_compare_hash" text NOT NULL,
	"revision_hash" text NOT NULL,
	"processor_version" text NOT NULL,
	"source_import_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."chapters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"volume_id" uuid,
	"label_raw" text NOT NULL,
	"editorial_position" integer NOT NULL,
	"head_revision_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chapters_work_position_uq" UNIQUE("work_id","editorial_position") DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE TABLE "app"."sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."source_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid,
	"storage_key" text NOT NULL,
	"file_hash" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"mime_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_files_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE TABLE "app"."tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"display_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tags_display_name_unique" UNIQUE("display_name")
);
--> statement-breakpoint
CREATE TABLE "app"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "app"."volumes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_id" uuid NOT NULL,
	"title" text NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "volumes_work_position_uq" UNIQUE("work_id","position")
);
--> statement-breakpoint
CREATE TABLE "app"."work_categories" (
	"work_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_categories_work_id_category_id_pk" PRIMARY KEY("work_id","category_id")
);
--> statement-breakpoint
CREATE TABLE "app"."work_tags" (
	"work_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_tags_work_id_tag_id_pk" PRIMARY KEY("work_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "app"."works" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"author" text DEFAULT '' NOT NULL,
	"work_type" text NOT NULL,
	"serial_status" text,
	"description" text DEFAULT '' NOT NULL,
	"edit_version" integer DEFAULT 1 NOT NULL,
	"active_release_id" uuid,
	"visibility" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."chapter_revisions" ADD CONSTRAINT "chapter_revisions_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "app"."chapters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."chapters" ADD CONSTRAINT "chapters_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "app"."works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."chapters" ADD CONSTRAINT "chapters_volume_id_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "app"."volumes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."source_files" ADD CONSTRAINT "source_files_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "app"."works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."volumes" ADD CONSTRAINT "volumes_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "app"."works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_categories" ADD CONSTRAINT "work_categories_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "app"."works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_categories" ADD CONSTRAINT "work_categories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "app"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_tags" ADD CONSTRAINT "work_tags_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "app"."works"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."work_tags" ADD CONSTRAINT "work_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "app"."tags"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chapter_revisions_chapter_idx" ON "app"."chapter_revisions" USING btree ("chapter_id","created_at");--> statement-breakpoint
CREATE INDEX "chapters_work_position_idx" ON "app"."chapters" USING btree ("work_id","editorial_position");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "app"."sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "source_files_hash_idx" ON "app"."source_files" USING btree ("file_hash");--> statement-breakpoint
CREATE INDEX "work_categories_reverse_idx" ON "app"."work_categories" USING btree ("category_id","work_id");--> statement-breakpoint
CREATE INDEX "work_tags_reverse_idx" ON "app"."work_tags" USING btree ("tag_id","work_id");
--> statement-breakpoint
-- revision must belong to the chapter that points at it (§16A-C composite FK)
ALTER TABLE "app"."chapter_revisions" ADD CONSTRAINT "chapter_revisions_id_chapter_uq" UNIQUE("id","chapter_id");
--> statement-breakpoint
ALTER TABLE "app"."chapters" ADD CONSTRAINT "chapters_head_revision_fk" FOREIGN KEY ("head_revision_id","id") REFERENCES "app"."chapter_revisions"("id","chapter_id");
