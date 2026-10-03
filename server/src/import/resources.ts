// Resource-aware revision identity (ADR-08 / IMP-17).
//
// IMP-17 requires that "同正文但圖片／註腳目標有改須判為修訂" — prose unchanged
// but a referenced image changed must still count as a revision.
//
// How that is actually achieved: the canonical body embeds each image's
// content hash in its [[img:…]] marker (ADR-08), so changing an image changes
// the body text and body_compare_hash already differs. resourceDigest() is a
// second, independent signal rather than the primary mechanism — it catches a
// byte-identical body whose stored resource association differs, and it is
// what lets revision_hash match §10's definition ("含章名、清理後結構、資源引用
// 與內容"). Do not read this file as "resources are how IMP-17 works"; the
// marker is.
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

export interface StagedResourceLink {
  contentHash: string;
  sourceHref: string;
  alt: string;
}

/**
 * Order-independent digest of a revision's resource references.
 *
 * Sorted because reference order within a body is already captured by
 * body_compare_hash via the markers themselves; what this adds is "which
 * resources, with which alt text". Alt text is included because changing a
 * caption changes what the reader sees.
 */
export function resourceDigest(links: readonly StagedResourceLink[]): string {
  if (links.length === 0) return '';
  const canonical = [...links]
    .map((l) => `${l.contentHash}:${l.alt}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * The revision hash: title + prose + processor version + resource set.
 *
 * Centralized here because it is computed on three paths (first commit,
 * incremental insert, overwrite update) and they must agree — a divergence
 * would make the same content hash differently depending on how it arrived.
 */
export function revisionHash(parts: {
  title: string;
  bodyCompareHash: string;
  processorVersion: string;
  resourceLinks: readonly StagedResourceLink[];
}): string {
  return createHash('sha256')
    .update(`${parts.title}\n${parts.bodyCompareHash}\n${parts.processorVersion}\n`
      + `${resourceDigest(parts.resourceLinks)}`)
    .digest('hex');
}

/** Staged resource links for a set of import items, grouped by item id. */
export async function stagedLinksByItem(
  db: NodePgDatabase,
  importJobId: string,
): Promise<Map<string, StagedResourceLink[]>> {
  const rows = await db.execute(sql`
    select r.import_item_id as item_id, r.content_hash, r.source_href, r.alt
    from app.import_item_resources r
    join app.import_items i on i.id = r.import_item_id
    where i.import_job_id = ${importJobId}
    order by r.content_hash`);
  const out = new Map<string, StagedResourceLink[]>();
  for (const raw of rows.rows) {
    const row = raw as { item_id: string; content_hash: string; source_href: string; alt: string };
    const list = out.get(row.item_id) ?? [];
    list.push({ contentHash: row.content_hash, sourceHref: row.source_href, alt: row.alt });
    out.set(row.item_id, list);
  }
  return out;
}

/**
 * Copy staged associations onto the revisions that were just created.
 *
 * Resolves resources.id by content hash inside the same transaction, so a
 * revision can never reference a resource row that is not there.
 */
export async function attachRevisionResources(
  tx: NodePgDatabase,
  pairs: ReadonlyArray<{ revisionId: string; links: readonly StagedResourceLink[] }>,
): Promise<number> {
  const flat = pairs.flatMap((p) => p.links.map((l) => ({ revisionId: p.revisionId, link: l })));
  if (flat.length === 0) return 0;
  const hashes = [...new Set(flat.map((f) => f.link.contentHash))];
  const found = await tx.execute(sql`
    select id, content_hash from app.resources
    where content_hash = any(${sql.param(hashes)}::text[])`);
  const idByHash = new Map<string, string>();
  for (const raw of found.rows) {
    const row = raw as { id: string; content_hash: string };
    idByHash.set(row.content_hash, row.id);
  }
  const values = flat.flatMap((f) => {
    const resourceId = idByHash.get(f.link.contentHash);
    if (!resourceId) return [];     // body marker was omitted too; nothing to link
    return [{
      revisionId: f.revisionId,
      resourceId,
      contentHash: f.link.contentHash,
      sourceHref: f.link.sourceHref,
      alt: f.link.alt,
    }];
  });
  if (values.length === 0) return 0;
  for (let i = 0; i < values.length; i += 200) {
    const batch = values.slice(i, i + 200);
    await tx.execute(sql`
      insert into app.chapter_revision_resources
        (revision_id, resource_id, content_hash, source_href, alt)
      select * from unnest(
        ${sql.param(batch.map((v) => v.revisionId))}::uuid[],
        ${sql.param(batch.map((v) => v.resourceId))}::uuid[],
        ${sql.param(batch.map((v) => v.contentHash))}::text[],
        ${sql.param(batch.map((v) => v.sourceHref))}::text[],
        ${sql.param(batch.map((v) => v.alt))}::text[])
      on conflict (revision_id, content_hash) do nothing`);
  }
  return values.length;
}

/**
 * Resource digest of each chapter's HEAD revision, for a work.
 *
 * Returned per chapter id (not per revision) because the match engine compares
 * the source against what the site currently shows.
 */
export async function headResourceDigests(
  db: NodePgDatabase,
  workId: string,
): Promise<Map<string, string>> {
  const rows = await db.execute(sql`
    select c.id as chapter_id, rr.content_hash, rr.alt
    from app.chapters c
    join app.chapter_revision_resources rr on rr.revision_id = c.head_revision_id
    where c.work_id = ${workId}`);
  const grouped = new Map<string, StagedResourceLink[]>();
  for (const raw of rows.rows) {
    const row = raw as { chapter_id: string; content_hash: string; alt: string };
    const list = grouped.get(row.chapter_id) ?? [];
    list.push({ contentHash: row.content_hash, sourceHref: '', alt: row.alt });
    grouped.set(row.chapter_id, list);
  }
  const out = new Map<string, string>();
  for (const [chapterId, links] of grouped) out.set(chapterId, resourceDigest(links));
  return out;
}
