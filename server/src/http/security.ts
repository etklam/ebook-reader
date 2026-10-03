// Security response headers (M7 hardening). The API serves JSON only, so the
// policy can be maximally restrictive: nothing it returns should ever be
// rendered as a document, framed, or sniffed into another content type.
//
// The web app is served by Vite in dev and by the reverse proxy in production,
// so its own CSP belongs there (§16: 部署 Docker Compose + reverse proxy) —
// these headers protect the API surface and any error page rendered from it.
import type { MiddlewareHandler } from 'hono';

export interface SecurityHeaderOptions {
  /** send HSTS — only correct once the proxy terminates TLS for every request */
  hsts: boolean;
}

export function securityHeaders(opts: SecurityHeaderOptions): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const h = c.res.headers;
    // JSON API: deny every rendering capability outright
    h.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('X-Frame-Options', 'DENY');
    h.set('Referrer-Policy', 'no-referrer');
    h.set('Cross-Origin-Resource-Policy', 'same-origin');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    // chapter bodies and member state must never land in a shared cache
    if (c.req.path.startsWith('/api/')) {
      h.set('Cache-Control', 'no-store');
    }
    if (opts.hsts) {
      h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  };
}
