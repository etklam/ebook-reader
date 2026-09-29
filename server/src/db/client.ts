// DB connection module, adapted from dev-plan §16A-H.
// API and worker each build their own bounded pool; never a Pool per request.
// TLS comes from validated config (src/config.ts), not from env read here.
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { TlsMode } from '../config.ts';

export interface PoolOptions {
  connectionString: string;
  max: number;
  applicationName: string;
  /** API keeps the 5s default (§16A-G); worker raises it for staging writes */
  statementTimeoutMillis?: number;
  tlsMode: TlsMode;
  dbCaFile?: string | null;
}

function parseDatabaseUrl(value: string): URL {
  try {
    const parsed = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
      throw new Error('Unsupported protocol');
    }
    const tlsParameters = ['sslmode', 'sslcert', 'sslkey', 'sslrootcert'];
    if (tlsParameters.some((key) => parsed.searchParams.has(key))) {
      throw new Error('TLS-in-URL');
    }
    return parsed;
  } catch {
    // Do not include the connection string in errors.
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
}

export function makePool(opts: PoolOptions): Pool {
  parseDatabaseUrl(opts.connectionString); // fail fast on malformed URLs

  return new Pool({
    connectionString: opts.connectionString,
    max: opts.max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: opts.statementTimeoutMillis ?? 5_000,
    idle_in_transaction_session_timeout: 15_000,
    application_name: opts.applicationName,
    // DB_TLS=disable is only acceptable for documented loopback dev (§16A-G)
    ssl: opts.tlsMode === 'disable'
      ? false
      : {
          rejectUnauthorized: true,
          ...(opts.dbCaFile ? { ca: readFileSync(opts.dbCaFile, 'utf8') } : {}),
        },
  });
}

export function makeDb(pool: Pool) {
  return drizzle({ client: pool });
}

export async function checkDatabase(pool: Pool): Promise<void> {
  await pool.query('SELECT 1');
}

// Cheap readiness probe (stabilization §18): the schema must exist and match
// the shape the API expects. No migrations ever run from readiness.
export async function checkReadiness(pool: Pool): Promise<void> {
  const res = await pool.query(
    `select to_regclass('app.import_jobs') is not null
       and to_regclass('app.chapter_revisions') is not null as ready`);
  if (!res.rows[0]?.ready) throw new Error('expected schema is not migrated');
}

export async function closePool(pool: Pool): Promise<void> {
  await pool.end();
}
