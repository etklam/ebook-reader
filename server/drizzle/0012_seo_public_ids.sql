ALTER TABLE "app"."chapters" ADD COLUMN "public_id" text GENERATED ALWAYS AS (left(replace(id::text, '-', ''), 8)) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."works" ADD COLUMN "public_id" text GENERATED ALWAYS AS (left(replace(id::text, '-', ''), 8)) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."chapters" ADD CONSTRAINT "chapters_work_public_id_uq" UNIQUE("work_id","public_id");--> statement-breakpoint
ALTER TABLE "app"."works" ADD CONSTRAINT "works_public_id_uq" UNIQUE("public_id");