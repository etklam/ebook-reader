// Real handler + scrypt, fixed in-memory DB. Measures hashing-path parity,
// not production/network timing or a proof of constant-time account lookup.
import { authRoutes } from '../src/routes/auth.ts';
import { hashPassword } from '../src/auth/password.ts';
import { writeFile } from 'node:fs/promises';
if (!process.argv[2]) throw new Error('usage: node scripts/perf-login-timing.mjs output.json');
const hash = await hashPassword('correct-password');
let exists = false;
const db = { select() { const query = { from() { return query; }, where() { return query; },
  async limit() { return exists ? [{ id: 'user', passwordHash: hash }] : []; } }; return query; } };
const app = authRoutes({ db, config: { trustProxy: false, registrationMode: 'closed', authRateLimit: {
  windowMs: 60000, maxPerIp: 1000, maxPerAccount: 1000,
} } });
const times = { missing: [], wrongPassword: [] };
for (let i = 0; i < 102; i++) for (const key of ['missing', 'wrongPassword']) {
  exists = key === 'wrongPassword';
  const start = performance.now();
  const res = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'test@example.com', password: 'incorrect-password' }) });
  if (res.status !== 401 || (await res.json()).error !== 'invalid_credentials') throw new Error('unexpected login result');
  if (i >= 2) times[key].push(performance.now() - start);
}
const cases = Object.fromEntries(Object.entries(times).map(([key, values]) => {
  values.sort((a,b)=>a-b);return [key,{samples:values.length,medianMs:values[50],p95Ms:values[95]}];
}));
const result={recordedAt:new Date().toISOString(),node:process.version,environment:'local handler, real scrypt, stub DB, alternating paths, 2 warmups each; no network or production limiter throughput',cases};
await writeFile(process.argv[2],JSON.stringify(result,null,2));console.log(JSON.stringify(result));
