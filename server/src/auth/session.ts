// Session tokens: random 32 bytes in the cookie; only the sha256 is stored.
import { createHash, randomBytes } from 'node:crypto';

export const SESSION_COOKIE = 'ebook_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function tokenId(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newSession(): { token: string; id: string; expiresAt: Date } {
  const token = randomBytes(32).toString('base64url');
  return { token, id: tokenId(token), expiresAt: new Date(Date.now() + SESSION_TTL_MS) };
}

export function cookieOpts() {
  return {
    httpOnly: true,
    sameSite: 'Lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  };
}
