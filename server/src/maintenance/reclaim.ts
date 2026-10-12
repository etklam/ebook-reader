// Reclamation jobs (M7 Phase 3.3). Two unbounded growths the system had:
//
//   1. app.sessions kept every expired and revoked row forever.
//   2. storage objects written by a failed import were never collected
//      (storage.ts noted "GC is M7" and it had not been written).
//
// Both are idempotent and safe to run while the worker is processing: they only
// touch rows and objects that nothing can still reference. The storage sweep in
// particular refuses to delete anything reachable from a chapter revision or a
// published release — losing a referenced body would be worse than leaking disk.
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { Storage } from '../storage.ts';

export interface SessionSweepResult {
  deleted: number;
}

/** Keep the rolling yearly ranking plus one day of boundary grace. */
export async function sweepWorkClicks(db: NodePgDatabase): Promise<SessionSweepResult> {
  const rows = await db.execute(sql`
    delete from app.work_clicks where ctid in (
      select ctid from app.work_clicks
      where day < (now() at time zone 'Asia/Taipei')::date - 365
      order by day limit 10000
    ) returning work_id`);
  return { deleted: rows.rows.length };
}

/**
 * Delete sessions that can never authenticate again: expired past the grace
 * period, or revoked and no longer interesting for support questions.
 *
 * A grace period is kept rather than deleting on expiry so that "why was I
 * logged out?" is still answerable for a while.
 */
export async function sweepSessions(
  db: NodePgDatabase,
  opts: { graceDays?: number; limit?: number } = {},
): Promise<SessionSweepResult> {
  const graceDays = opts.graceDays ?? 30;
  const limit = opts.limit ?? 10_000;
  const rows = await db.execute(sql`
    with doomed as (
      select id from app.sessions
      where (expires_at < now() - make_interval(days => ${graceDays}))
         or (revoked_at is not null and revoked_at < now() - make_interval(days => ${graceDays}))
      limit ${limit}
    )
    delete from app.sessions s using doomed d where s.id = d.id returning s.id`);
  return { deleted: rows.rows.length };
}

export interface ResetSweepResult {
  deleted: number;
}

/** Spent or long-expired password reset tokens have no further use. */
export async function sweepPasswordResets(
  db: NodePgDatabase,
  opts: { graceDays?: number } = {},
): Promise<ResetSweepResult> {
  const graceDays = opts.graceDays ?? 30;
  const rows = await db.execute(sql`
    delete from app.password_resets
    where (used_at is not null and used_at < now() - make_interval(days => ${graceDays}))
       or expires_at < now() - make_interval(days => ${graceDays})
    returning token_hash`);
  return { deleted: rows.rows.length };
}

export interface StorageSweepResult {
  /** keys considered for deletion */
  candidates: number;
  deleted: string[];
  /** kept because something still references them */
  retained: number;
  /**
   * Referenced-but-absent objects, split by reachability. The distinction is
   * the whole point: a missing object under a PUBLISHED release means readers
   * get content_unavailable right now and it must page someone, while a
   * missing object on an unpublished draft revision is usually just residue
   * (e.g. an import run against a throwaway storage root). Reporting both at
   * one severity would train an operator to ignore the alert.
   */
  missingPublished: string[];
  missingUnpublished: string[];
}

/**
 * Collect storage objects left behind by failed or superseded imports.
 *
 * The reachability rule is deliberately conservative: an object is deletable
 * only when nothing in chapter_revisions.content_key, source_files.storage_key
 * or resources.storage_key refers to it. chapter_revisions are immutable and
 * referenced by release snapshots and member bookmarks, so anything they name
 * must survive — §12 says orphan cleanup "不能刪掉仍被舊修訂或已發布內容引用的
 * 資源". All three reference sources must be consulted; missing one would make
 * the sweep delete live content.
 *
 * `minAgeHours` keeps very recent objects even when unreferenced: an import
 * writes its objects before committing the rows that reference them, so a
 * sweep racing a live import would otherwise delete the bodies out from under
 * it.
 */
export async function sweepStorage(
  db: NodePgDatabase,
  storage: Storage,
  listKeys: () => Promise<string[]>,
  opts: { minAgeHours?: number; dryRun?: boolean; limit?: number } = {},
): Promise<StorageSweepResult> {
  const minAgeHours = opts.minAgeHours ?? 24;
  const limit = opts.limit ?? 5_000;
  const dryRun = opts.dryRun ?? false;

  const referenced = new Set<string>();
  const revisionKeys = await db.execute(sql`select content_key as key from app.chapter_revisions`);
  for (const r of revisionKeys.rows) referenced.add((r as { key: string }).key);
  const sourceKeys = await db.execute(sql`select storage_key as key from app.source_files`);
  for (const r of sourceKeys.rows) referenced.add((r as { key: string }).key);
  // Resource objects (ADR-08). Without this the sweep saw every image as an
  // orphan and would have deleted the lot — the resources table is a third
  // reference source alongside revisions and source files.
  const resourceKeys = await db.execute(sql`select storage_key as key from app.resources`);
  for (const r of resourceKeys.rows) referenced.add((r as { key: string }).key);

  // keys reachable from an ACTIVE release — i.e. content the public can ask for
  const publishedKeys = new Set<string>();
  const published = await db.execute(sql`
    select distinct cr.content_key as key
    from app.release_items ri
    join app.works w on w.active_release_id = ri.release_id
    join app.chapter_revisions cr on cr.id = ri.revision_id
    union
    select distinct r.storage_key as key
    from app.release_items ri
    join app.works w on w.active_release_id = ri.release_id
    join app.chapter_revision_resources rr on rr.revision_id = ri.revision_id
    join app.resources r on r.id = rr.resource_id`);
  for (const r of published.rows) publishedKeys.add((r as { key: string }).key);

  // integrity check in the other direction: a referenced object that is gone
  // means a chapter cannot be read, which is a problem to report, not to fix
  // by deleting anything
  const missingPublished: string[] = [];
  const missingUnpublished: string[] = [];
  for (const key of referenced) {
    if (await storage.exists(key)) continue;
    (publishedKeys.has(key) ? missingPublished : missingUnpublished).push(key);
  }

  const onDisk = await listKeys();
  const cutoff = Date.now() - minAgeHours * 3600 * 1000;
  const deleted: string[] = [];
  let candidates = 0;
  let retained = 0;
  for (const key of onDisk) {
    if (referenced.has(key)) {
      retained += 1;
      continue;
    }
    const age = await storage.modifiedAt(key);
    if (age === null || age.getTime() > cutoff) {
      retained += 1;           // too new to be safely considered an orphan
      continue;
    }
    candidates += 1;
    if (deleted.length >= limit) continue;
    if (!dryRun) await storage.delete(key);
    deleted.push(key);
  }
  return { candidates, deleted, retained, missingPublished, missingUnpublished };
}
