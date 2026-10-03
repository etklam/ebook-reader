CREATE TABLE "app"."chapter_revision_resources" (
	"revision_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"source_href" text DEFAULT '' NOT NULL,
	"alt" text DEFAULT '' NOT NULL,
	CONSTRAINT "chapter_revision_resources_revision_id_content_hash_pk" PRIMARY KEY("revision_id","content_hash")
);
--> statement-breakpoint
CREATE TABLE "app"."import_item_resources" (
	"import_item_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"source_href" text DEFAULT '' NOT NULL,
	"alt" text DEFAULT '' NOT NULL,
	CONSTRAINT "import_item_resources_import_item_id_content_hash_pk" PRIMARY KEY("import_item_id","content_hash")
);
--> statement-breakpoint
CREATE TABLE "app"."resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"content_hash" text NOT NULL,
	"storage_key" text NOT NULL,
	"media_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "resources_content_hash_unique" UNIQUE("content_hash"),
	CONSTRAINT "resources_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "app"."chapter_revision_resources" ADD CONSTRAINT "chapter_revision_resources_revision_id_chapter_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "app"."chapter_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."chapter_revision_resources" ADD CONSTRAINT "chapter_revision_resources_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "app"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."import_item_resources" ADD CONSTRAINT "import_item_resources_import_item_id_import_items_id_fk" FOREIGN KEY ("import_item_id") REFERENCES "app"."import_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."import_item_resources" ADD CONSTRAINT "import_item_resources_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "app"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chapter_revision_resources_resource_idx" ON "app"."chapter_revision_resources" USING btree ("resource_id");