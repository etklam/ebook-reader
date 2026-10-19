// Smoke-check the real production web server, not Vite. Usage: BASE_URL=... pnpm ops:check-web
import assert from 'node:assert/strict';
const base = process.env.BASE_URL ?? 'http://127.0.0.1:18080';
function security(response) {
  assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(response.headers.get('permissions-policy'));
  assert.ok(!/nginx\//.test(response.headers.get('server') ?? ''));
}
for (const path of ['/', '/index.html', '/read/nonexistent-work']) {
  const response = await fetch(base + path); assert.equal(response.status, 200); security(response);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
}
const html = await (await fetch(base + '/')).text();
const asset = html.match(/(?:src|href)="(\/assets\/[^\"]+\.js)"/)?.[1];
assert.ok(asset, 'built HTML must reference a hashed JavaScript asset');
const response = await fetch(base + asset, { headers: { 'accept-encoding': 'gzip' } });
assert.equal(response.status, 200); security(response);
assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
assert.equal(response.headers.get('content-encoding'), 'gzip');
const missing = await fetch(base + '/assets/nonexistent.js'); assert.equal(missing.status, 404); security(missing);
const api = await fetch(base + '/api/me'); assert.ok([200, 401].includes(api.status));
assert.equal(api.headers.get('cache-control'), 'no-store');
console.log('PASS HTML, SPA fallback, hashed asset cache/gzip, asset 404 and API proxy headers');
