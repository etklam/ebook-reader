// /healthz (lightweight process health) and /readyz (cheap DB + schema
// readiness). Readiness never runs migrations (stabilization §18).
import { Hono } from 'hono';
import type { Pool } from 'pg';
import { checkDatabase, checkReadiness } from '../db/client.ts';

export function healthRoutes(pool: Pool): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', async (c) => {
    try {
      await checkDatabase(pool);
      await checkReadiness(pool);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : 'db unreachable' }, 503);
    }
  });
  return app;
}
