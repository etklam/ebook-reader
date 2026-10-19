// Central typed config (stabilization §2): every env var is validated once
// at startup and fails fast with an explicit message. Values that could carry
// credentials (DB URLs) are never echoed back in errors.
export type TlsMode = 'verify-full' | 'disable';

export interface ApiConfig {
  databaseUrl: string;
  port: number;
  /** interface to bind. Default 0.0.0.0 because a container behind the reverse
   *  proxy must accept connections from outside itself; a bare-metal
   *  deployment fronted by a proxy on the same host should set 127.0.0.1 so
   *  the API is not reachable directly. */
  bindHost: string;
  storageRoot: string;
  maxTxtBytes: number;
  maxEpubBytes: number;
  /** surfaces in the job-status DTO; the worker enforces it on claims */
  maxAttempts: number;
  tlsMode: TlsMode;
  dbCaFile: string | null;
  /** M6 Beta registration policy: no email/recovery infra → closed|invite only
   *  are safe; 'open' is available but must stay off until recovery exists */
  registrationMode: 'closed' | 'invite' | 'open';
  /** extra CSRF-allowed origins behind host-rewriting proxies (comma-separated);
   *  same-host origins are always allowed */
  csrfAllowedOrigins: string[];
  /** read X-Forwarded-For for rate-limit keys. Only safe when every request
   *  provably passes through our own proxy — otherwise it is a one-header
   *  bypass of every limit. */
  trustProxy: boolean;
  /** largest JSON/urlencoded body accepted outside the import upload routes */
  maxJsonBytes: number;
  /** auth throttling (M7). Per-process; see http/rate-limit.ts on replicas. */
  authRateLimit: { windowMs: number; maxPerIp: number; maxPerAccount: number };
  /** send HSTS. Off by default: on plain-HTTP dev it would pin localhost to
   *  https in the browser for a year. */
  hsts: boolean;
  /** record the caller's address in request logs. Off by default: it is
   *  personal data and a reading site does not need a location trail to run.
   *  Turn on for incident response. */
  logClientIp: boolean;
  /** Public origin, e.g. https://example.com — the absolute base for
   *  sitemap.xml entries, which the protocol requires to be absolute. Left
   *  unset the sitemap falls back to the request's own origin, which is right
   *  for dev but trusts the Host header, so production should set it. */
  siteOrigin: string | null;
}

export interface WorkerConfig {
  databaseUrl: string;
  storageRoot: string;
  pollMs: number;
  leaseMs: number;
  heartbeatMs: number;
  maxAttempts: number;
  storageConcurrency: number;
  tlsMode: TlsMode;
  dbCaFile: string | null;
}

type Env = Record<string, string | undefined>;

const TLS_MODES: readonly TlsMode[] = ['verify-full', 'disable'];

function requiredUrl(env: Env, key: string): string {
  const v = env[key];
  if (!v || !v.trim()) throw new Error(`config: ${key} is required`);
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Error(`config: ${key} must be a valid URL`);
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(`config: ${key} must be a postgres:// or postgresql:// URL`);
  }
  return v;
}

// optional http(s) origin: scheme + host only. A trailing path would silently
// double up in every sitemap URL, so it is rejected rather than trimmed.
function httpOrigin(env: Env, key: string): string | null {
  const raw = env[key]?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`config: ${key} must be a valid URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`config: ${key} must be an http:// or https:// URL`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`config: ${key} must be scheme + host only (no path)`);
  }
  return url.origin;
}

function int(env: Env, key: string, def: number, min: number, max: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`config: ${key} must be an integer (got "${Number.isNaN(n) ? 'NaN' : raw}")`);
  if (n < min || n > max) throw new Error(`config: ${key} must be between ${min} and ${max}`);
  return n;
}

// strict boolean parsing: a typo must fail at startup, never fall back to a
// weaker setting (an unnoticed `TRUST_PROXY=ture` would be silently insecure)
function bool(env: Env, key: string, def: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return def;
  if (['1', 'true', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'no'].includes(raw)) return false;
  throw new Error(`config: ${key} must be true or false`);
}

function tls(env: Env): { tlsMode: TlsMode; dbCaFile: string | null } {
  const mode = env.DB_TLS ?? 'verify-full';
  if (!TLS_MODES.includes(mode as TlsMode)) {
    throw new Error(`config: DB_TLS must be one of ${TLS_MODES.join(', ')}`);
  }
  return { tlsMode: mode as TlsMode, dbCaFile: env.DB_CA_FILE ?? null };
}

export function loadApiConfig(env: Env = process.env): ApiConfig {
  const registrationMode = env.REGISTRATION_MODE?.trim() || 'closed';
  if (!['closed', 'invite', 'open'].includes(registrationMode)) {
    throw new Error('config: REGISTRATION_MODE must be closed, invite or open');
  }
  return {
    databaseUrl: requiredUrl(env, 'DATABASE_URL'),
    port: int(env, 'PORT', 3000, 1, 65535),
    bindHost: env.BIND_HOST?.trim() || '0.0.0.0',
    storageRoot: env.STORAGE_ROOT?.trim() || './storage',
    // dev-plan §20 starting quotas; 1 GiB is the hard ceiling for overrides
    maxTxtBytes: int(env, 'IMPORT_MAX_TXT_BYTES', 30 * 1024 * 1024, 1, 1024 * 1024 * 1024),
    maxEpubBytes: int(env, 'IMPORT_MAX_EPUB_BYTES', 50 * 1024 * 1024, 1, 1024 * 1024 * 1024),
    maxAttempts: int(env, 'MAX_ATTEMPTS', 3, 1, 20),
    ...tls(env),
    registrationMode: registrationMode as 'closed' | 'invite' | 'open',
    csrfAllowedOrigins: (env.CSRF_ALLOWED_ORIGINS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: bool(env, 'TRUST_PROXY', false),
    maxJsonBytes: int(env, 'MAX_JSON_BYTES', 256 * 1024, 1024, 8 * 1024 * 1024),
    authRateLimit: {
      windowMs: int(env, 'AUTH_RATE_LIMIT_WINDOW_MS', 5 * 60_000, 1_000, 3_600_000),
      maxPerIp: int(env, 'AUTH_RATE_LIMIT_MAX_PER_IP', 60, 1, 10_000),
      maxPerAccount: int(env, 'AUTH_RATE_LIMIT_MAX_PER_ACCOUNT', 10, 1, 10_000),
    },
    hsts: bool(env, 'HSTS', false),
    logClientIp: bool(env, 'LOG_CLIENT_IP', false),
    siteOrigin: httpOrigin(env, 'SITE_ORIGIN'),
  };
}

export function loadWorkerConfig(env: Env = process.env): WorkerConfig {
  const leaseMs = int(env, 'WORKER_LEASE_MS', 300_000, 100, 3_600_000);
  // heartbeat defaults to a third of the lease so ~2 missed beats fit inside it
  const heartbeatMs = int(env, 'WORKER_HEARTBEAT_MS', Math.max(1, Math.floor(leaseMs / 3)), 1, leaseMs);
  return {
    databaseUrl: requiredUrl(env, 'WORKER_DATABASE_URL'),
    storageRoot: env.STORAGE_ROOT?.trim() || './storage',
    pollMs: int(env, 'WORKER_POLL_MS', 1_000, 10, 600_000),
    leaseMs,
    heartbeatMs,
    maxAttempts: int(env, 'MAX_ATTEMPTS', 3, 1, 20),
    storageConcurrency: int(env, 'STORAGE_WRITE_CONCURRENCY', 6, 1, 64),
    ...tls(env),
  };
}

export function loadMigratorUrl(env: Env = process.env): string {
  return requiredUrl(env, 'MIGRATOR_DATABASE_URL');
}
