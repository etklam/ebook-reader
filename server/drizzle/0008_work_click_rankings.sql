CREATE TABLE "app"."work_clicks" (
	"work_id" uuid NOT NULL,
	"visitor_hash" text NOT NULL,
	"day" date NOT NULL,
	CONSTRAINT "work_clicks_work_id_visitor_hash_day_pk" PRIMARY KEY("work_id","visitor_hash","day")
);
--> statement-breakpoint
ALTER TABLE "app"."work_clicks" ADD CONSTRAINT "work_clicks_work_id_works_id_fk" FOREIGN KEY ("work_id") REFERENCES "app"."works"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_clicks_day_work_idx" ON "app"."work_clicks" USING btree ("day","work_id");