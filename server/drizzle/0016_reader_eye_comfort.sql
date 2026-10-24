ALTER TABLE "app"."reader_preferences" ADD COLUMN "warmth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."reader_preferences" ADD COLUMN "night_from" integer DEFAULT 19 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."reader_preferences" ADD COLUMN "night_to" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."reader_preferences" ADD CONSTRAINT "reader_preferences_warmth_ck" CHECK ("app"."reader_preferences"."warmth" between 0 and 3);--> statement-breakpoint
ALTER TABLE "app"."reader_preferences" ADD CONSTRAINT "reader_preferences_night_ck" CHECK ("app"."reader_preferences"."night_from" between 0 and 23 and "app"."reader_preferences"."night_to" between 0 and 23);