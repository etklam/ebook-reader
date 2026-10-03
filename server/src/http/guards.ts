// Authorization guards. These live outside the route modules on purpose: the
// admin guard must be mounted once on the parent app so that adding a new
// /api/admin/* route module cannot forget it (dev-plan §02: "所有管理 API 都
// 必須驗證權限；不能只靠前端隱藏").
import type { Context, Next } from 'hono';

export async function requireAdmin(c: Context, next: Next): Promise<Response | void> {
  if (c.get('role') !== 'admin') return c.json({ error: 'forbidden' }, 403);
  await next();
}
