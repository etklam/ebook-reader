-- Post-migration grants (dev-plan §16A-F). Applied by `pnpm db:migrate`.
-- Runtime roles: table-level DML only, no DDL, no schema CREATE.
GRANT USAGE ON SCHEMA app TO ebook_api, ebook_worker;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO ebook_api, ebook_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO ebook_api, ebook_worker;

-- Tables created by future migrations inherit the same grants.
ALTER DEFAULT PRIVILEGES FOR ROLE ebook_migrator IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ebook_api, ebook_worker;
ALTER DEFAULT PRIVILEGES FOR ROLE ebook_migrator IN SCHEMA app
  GRANT USAGE, SELECT ON SEQUENCES TO ebook_api, ebook_worker;
