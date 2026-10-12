ALTER TABLE "app"."chapters" ADD COLUMN "merged_into_chapter_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."chapters" ADD CONSTRAINT "chapters_id_work_uq" UNIQUE("id","work_id");--> statement-breakpoint
ALTER TABLE "app"."chapters" ADD CONSTRAINT "chapters_merged_into_fk" FOREIGN KEY ("merged_into_chapter_id","work_id") REFERENCES "app"."chapters"("id","work_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chapters_merged_into_idx" ON "app"."chapters" USING btree ("merged_into_chapter_id");--> statement-breakpoint
ALTER TABLE "app"."chapters" ADD CONSTRAINT "chapters_merged_nonself_ck" CHECK ("app"."chapters"."merged_into_chapter_id" is null or "app"."chapters"."merged_into_chapter_id" <> "app"."chapters"."id");