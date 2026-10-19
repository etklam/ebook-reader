ALTER TABLE app.works ADD COLUMN toc_version text NOT NULL DEFAULT 'initial';
--> statement-breakpoint
-- Statement triggers bump each affected work once, including bulk imports and
-- restores. UUID generations cannot be reused when edit_version rolls back.
CREATE FUNCTION app.bump_toc_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE app.works SET toc_version = gen_random_uuid()::text
      WHERE id IN (SELECT DISTINCT work_id FROM old_chapters);
  ELSIF TG_OP = 'INSERT' THEN
    UPDATE app.works SET toc_version = gen_random_uuid()::text
      WHERE id IN (SELECT DISTINCT work_id FROM new_chapters);
  ELSE
    UPDATE app.works SET toc_version = gen_random_uuid()::text
      WHERE id IN (SELECT work_id FROM old_chapters UNION SELECT work_id FROM new_chapters);
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER chapters_toc_insert AFTER INSERT ON app.chapters
REFERENCING NEW TABLE AS new_chapters
FOR EACH STATEMENT EXECUTE FUNCTION app.bump_toc_generation();
--> statement-breakpoint
CREATE TRIGGER chapters_toc_update AFTER UPDATE ON app.chapters
REFERENCING OLD TABLE AS old_chapters NEW TABLE AS new_chapters
FOR EACH STATEMENT EXECUTE FUNCTION app.bump_toc_generation();
--> statement-breakpoint
CREATE TRIGGER chapters_toc_delete AFTER DELETE ON app.chapters
REFERENCING OLD TABLE AS old_chapters
FOR EACH STATEMENT EXECUTE FUNCTION app.bump_toc_generation();
