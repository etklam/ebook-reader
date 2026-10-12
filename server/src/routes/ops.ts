// Operational status (M7 Phase 4). Admin-only facts an operator or an
// alerting script needs, in one request.
//
// Deliberately NOT folded into /readyz. Readiness answers "should this process
// receive traffic?" — if a stalled import worker made the API unready, the
// reverse proxy would take the whole site offline over a condition that stops
// nobody from reading. Worker health is an alert, not a readiness failure.
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export interface OpsDeps {
  db: NodePgDatabase;
}

export interface OpsStatus {
  now: string;
  queue: {
    queued: number;
    processing: number;
    failed: number;
    /** processing jobs whose lease has expired — a worker died mid-job */
    staleLeases: number;
    /** age in seconds of the oldest queued job; null when the queue is empty */
    oldestQueuedAgeSec: number | null;
    /** last time any worker touched a lease; null when nothing has ever run */
    lastWorkerHeartbeat: string | null;
  };
  content: {
    works: number;
    publishedWorks: number;
    chapters: number;
    resources: number;
  };
  sessions: {
    active: number;
    /** rows that the reclamation sweep could remove */
    sweepable: number;
  };
  /** non-empty means something needs attention; the CLI exits non-zero on it */
  warnings: string[];
}

export async function collectOpsStatus(db: NodePgDatabase): Promise<OpsStatus> {
  const [queue] = (await db.execute(sql`
    select
      count(*) filter (where status = 'queued')::int queued,
      count(*) filter (where status = 'processing')::int processing,
      count(*) filter (where status = 'failed')::int failed,
      count(*) filter (where status = 'processing'
                         and lease_expires_at is not null
                         and lease_expires_at < now())::int stale_leases,
      extract(epoch from (now() - min(created_at) filter (where status = 'queued')))::int oldest_queued_age,
      max(lease_expires_at) filter (where lease_owner is not null) last_lease
    from app.import_jobs`)).rows as unknown as Array<{
      queued: number; processing: number; failed: number; stale_leases: number;
      oldest_queued_age: number | null; last_lease: Date | null;
    }>;

  const [content] = (await db.execute(sql`
    select
      (select count(*)::int from app.works) works,
      (select count(*)::int from app.works
        where visibility = 'public' and active_release_id is not null) published_works,
      (select count(*)::int from app.chapters where merged_into_chapter_id is null) chapters,
      (select count(*)::int from app.resources) resources`)).rows as unknown as Array<{
      works: number; published_works: number; chapters: number; resources: number;
    }>;

  const [sessions] = (await db.execute(sql`
    select
      count(*) filter (where revoked_at is null and expires_at > now())::int active,
      count(*) filter (where expires_at < now() - interval '30 days'
                         or (revoked_at is not null
                             and revoked_at < now() - interval '30 days'))::int sweepable
    from app.sessions`)).rows as unknown as Array<{ active: number; sweepable: number }>;

  const warnings: string[] = [];
  if (queue.stale_leases > 0) {
    warnings.push(`${queue.stale_leases} import job(s) hold an expired lease — a worker died mid-job`);
  }
  if (queue.failed > 0) {
    warnings.push(`${queue.failed} import job(s) in failed state — check error_code and retry or cancel`);
  }
  // A queue that is not draining is the signal that the worker process is gone.
  // 15 minutes is well past any normal parse of a book-sized file.
  if (queue.oldest_queued_age !== null && queue.oldest_queued_age > 900) {
    warnings.push(`oldest queued import is ${Math.round(queue.oldest_queued_age / 60)} min old — is the worker running?`);
  }

  return {
    now: new Date().toISOString(),
    queue: {
      queued: queue.queued,
      processing: queue.processing,
      failed: queue.failed,
      staleLeases: queue.stale_leases,
      oldestQueuedAgeSec: queue.oldest_queued_age,
      lastWorkerHeartbeat: queue.last_lease ? new Date(queue.last_lease).toISOString() : null,
    },
    content: {
      works: content.works,
      publishedWorks: content.published_works,
      chapters: content.chapters,
      resources: content.resources,
    },
    sessions: { active: sessions.active, sweepable: sessions.sweepable },
    warnings,
  };
}

export function opsRoutes(deps: OpsDeps): Hono<{ Variables: { userId: string; role: string } }> {
  const { db } = deps;
  const app = new Hono<{ Variables: { userId: string; role: string } }>();
  // mounted under /api/admin/*, so the parent app's admin guard applies
  app.get('/api/admin/ops/status', async (c) => c.json(await collectOpsStatus(db)));
  return app;
}
