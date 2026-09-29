// Password hashing with node:crypto scrypt — no extra dependency.
// Format: scrypt$N$r$p$saltB64$hashB64 (parameters stored for future upgrades).
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';

const N = 16384, R = 8, P = 1, KEYLEN = 64;

function scryptAsync(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// Robust against malformed/corrupted stored hashes (stabilization §16): a
// bad row must fail closed (false), never crash the login path.
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const Nn = Number(n), Rr = Number(r), Pp = Number(p);
  if (!Number.isInteger(Nn) || !Number.isInteger(Rr) || !Number.isInteger(Pp) || Nn <= 0 || Rr <= 0 || Pp <= 0) {
    return false;
  }
  try {
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    if (salt.length === 0 || expected.length === 0 || expected.length > 1024) return false;
    const key = await scryptAsync(password.normalize('NFKC'), salt, expected.length, { N: Nn, r: Rr, p: Pp });
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}
