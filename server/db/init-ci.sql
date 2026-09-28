-- CI bootstrap: same shape as init-dev.sql with CI passwords.
-- POSTGRES_DB already created ebook_dev; hand it to the migrator.
CREATE ROLE ebook_migrator LOGIN PASSWORD 'ci-migrator';
CREATE ROLE ebook_api LOGIN PASSWORD 'ci-api';
CREATE ROLE ebook_worker LOGIN PASSWORD 'ci-worker';

ALTER DATABASE ebook_dev OWNER TO ebook_migrator;
\connect ebook_dev
CREATE SCHEMA app AUTHORIZATION ebook_migrator;
CREATE SCHEMA drizzle AUTHORIZATION ebook_migrator;
REVOKE CREATE ON SCHEMA app, drizzle FROM PUBLIC;
