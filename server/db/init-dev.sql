-- Dev bootstrap: runs once on an EMPTY data dir via docker-entrypoint-initdb.d.
-- Creates the low-privilege roles from dev-plan §16A-F. Passwords are dev-only.
-- Schemas are owned by ebook_migrator; runtime roles get table grants only
-- after migrations run (db/grants.sql).
CREATE ROLE ebook_migrator LOGIN PASSWORD 'dev-migrator-pass';
CREATE ROLE ebook_api LOGIN PASSWORD 'dev-api-pass';
CREATE ROLE ebook_worker LOGIN PASSWORD 'dev-worker-pass';

-- POSTGRES_DB already created ebook_dev (owned by the bootstrap superuser);
-- hand ownership to the migrator and continue there.
ALTER DATABASE ebook_dev OWNER TO ebook_migrator;
\connect ebook_dev
CREATE SCHEMA app AUTHORIZATION ebook_migrator;
CREATE SCHEMA drizzle AUTHORIZATION ebook_migrator;

-- No schema CREATE for PUBLIC (16A-B); runtime roles are table-level consumers.
REVOKE CREATE ON SCHEMA app, drizzle FROM PUBLIC;
