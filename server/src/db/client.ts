// DB connection module, adapted from dev-plan §16A-H.
// API and worker each build their own bounded pool; never a Pool per request.
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

export interface PoolOptions {
  connectionString: string;
  max: number;
  applicationName: string;
}

function parseDatabaseUrl(value: string): URL {
  try {
    const parsed = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
      throw new Error('Unsupported protocol');
    }
    return parsed;
  } catch {
    // Do not include the connection string in errors.
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
}

export function makePool(opts: PoolOptions): Pool {
  const url = parseDatabaseUrl(opts.connectionString);
  const tlsParameters = ['sslmode', 'sslcert', 'sslkey', 'sslrootcert'];
  if (tlsParameters.some((key) => url.searchParams.has(key))) {
    throw new Error('Configure TLS with DB_TLS and DB_CA_FILE instead');
  }

  const tlsMode = process.env.DB_TLS ?? 'verify-full';
  if (!['verify-full', 'disable'].includes(tlsMode)) {
    throw new Error('DB_TLS must be verify-full or disable');
  }

  return new Pool({
    connectionString: opts.connectionString,
    max: opts.max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 5_000,
    idle_in_transaction_session_timeout: 15_000,
    application_name: opts.applicationName,
    // DB_TLS=disable is only acceptable for documented loopback dev (§16A-G)
    ssl: tlsMode === 'disable'
      ? false
      : {
          rejectUnauthorized: true,
          ...(process.env.DB_CA_FILE
            ? { ca: readFileSync(process.env.DB_CA_FILE, 'utf8') }
            : {}),
        },
  });
}

export function makeDb(pool: Pool) {
  return drizzle({ client: pool });
}

export async function checkDatabase(pool: Pool): Promise<void> {
  await pool.query('SELECT 1');
}

export async function closePool(pool: Pool): Promise<void> {
  await pool.end();
}
