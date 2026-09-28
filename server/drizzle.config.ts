import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  // Runs as ebook_migrator (dev: MIGRATOR_DATABASE_URL in .env via --env-file)
  dbCredentials: {
    url: process.env.MIGRATOR_DATABASE_URL
      ?? 'postgres://ebook_migrator:dev-migrator-pass@127.0.0.1:5432/ebook_dev',
  },
  schemaFilter: ['app'],
});
