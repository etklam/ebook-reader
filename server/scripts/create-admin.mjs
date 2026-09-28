// Bootstrap an admin account: node --env-file=.env scripts/create-admin.mjs <email> <password>
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { scrypt as _scrypt, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(_scrypt);
const N = 16384, R = 8, P = 1, KEYLEN = 64;

const [email, password] = process.argv.slice(2);
if (!email || !password || password.length < 8) {
  console.error('usage: create-admin.mjs <email> <password (min 8 chars)>');
  process.exit(1);
}

const salt = randomBytes(16);
const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P });
const hash = `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const res = await pool.query(
    `INSERT INTO app.users (id, username, email, password_hash, role)
     VALUES ($1, $2, $3, $4, 'admin')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin'
     RETURNING id`,
    [randomUUID(), email.split('@')[0], email.toLowerCase(), hash],
  );
  console.log('admin ready:', res.rows[0].id);
} finally {
  await pool.end();
}
