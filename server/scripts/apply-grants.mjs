// Applies db/grants.sql via node (host psql not required).
// Run by `pnpm db:migrate` right after drizzle-kit migrate.
import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.MIGRATOR_DATABASE_URL, max: 1 });
try {
  const sql = await readFile(new URL('../db/grants.sql', import.meta.url), 'utf8');
  await pool.query(sql);
  console.log('grants applied');
} finally {
  await pool.end();
}
