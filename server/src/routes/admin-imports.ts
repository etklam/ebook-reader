// Admin import routes (M2 upload/preview/commit + M3 diff/apply +
// reanalyze). Admin-only; upload bounds and attempt limits come from the
// validated config. Responses are explicit DTOs (stabilization §9), never
// spread DB rows.
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createHash } from 'node:crypto';
import { eq, asc, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { works, sourceFiles, importJobs, importItems } from '../db/schema.ts';
import type { ApiConfig } from '../config.ts';
import type { Storage } from '../storage.ts';
import { processorVersion } from '../import/versions.ts';
import { commitImport } from '../import/commit.ts';
import { applyIncremental, diffImport } from '../import/apply-incremental.ts';
import { reanalyzeImport } from '../import/reanalyze.ts';
import { revertPlan, revertImport } from '../import/revert.ts';
import type {
  ImportJobResponse, ImportChapterPageResponse, ImportUploadResponse,
} from './dto.ts';

export interface ImportRoutesDeps {
  db: NodePgDatabase;
  storage: Storage;
  config: ApiConfig;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// middleware in the chain disables Hono's path-param inference; routes are
// always registered with ':id' so the cast is backed by the route itself
const routeId = (c: Context): string => c.req.param('id') as string;

export function adminImportRoutes(deps: ImportRoutesDeps): Hono<{ Variables: { userId: string; role: string } }> {
  const { db, storage, config } = deps;
  const app = new Hono<{ Variables: { userId: string; role: string } }>();

  // every /api/admin route is admin-only, enforced before any parsing
  app.use('/api/admin/*', requireAdmin);
  app.use('/api/admin/imports/*', bodyLimit({ maxSize: config.maxEpubBytes }));
  app.use('/api/admin/imports', bodyLimit({ maxSize: config.maxEpubBytes }));

  // upload: bounded, admin-only; storage keys are server-generated (never from
  // the client filename) and the raw bytes are never logged
  app.post('/api/admin/imports', async (c) => {
    const form = await c.req.parseBody().catch(() => null);
    const file = form?.file;
    if (!(file instanceof File)) return c.json({ error: 'file_required' }, 400);
    const field = (name: string): string | undefined => {
      const v = form?.[name];
      return typeof v === 'string' ? v : undefined;
    };

    const name = file.name ?? '';
    const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
    if (ext !== '.txt' && ext !== '.epub') {
      return c.json({ error: 'unsupported_format', allowed: ['.txt', '.epub'] }, 415);
    }
    const maxBytes = ext === '.txt' ? config.maxTxtBytes : config.maxEpubBytes;
    if (file.size > maxBytes) {
      return c.json({ error: 'file_too_large', max_bytes: maxBytes }, 413);
    }
    // trust the content type only to reject, never to accept something odd
    const type = file.type;
    if (type && !type.startsWith('text/') && !['application/epub+zip', 'application/octet-stream'].includes(type)) {
      return c.json({ error: 'unsupported_media_type', content_type: type }, 415);
    }

    let workId: string | null = null;
    const rawWorkId = field('workId');
    if (rawWorkId) {
      if (!UUID_RE.test(rawWorkId)) return c.json({ error: 'invalid_work_id' }, 400);
      const w = await db.select({ id: works.id }).from(works).where(eq(works.id, rawWorkId)).limit(1);
      if (w.length === 0) return c.json({ error: 'work_not_found' }, 404);
      workId = rawWorkId;
    }
    const rawEncoding = field('encoding');
    const requestedEncoding = rawEncoding ? rawEncoding.toLowerCase() : null;

    const buf = Buffer.from(await file.arrayBuffer());
    const mimeType = ext === '.epub' ? 'application/epub+zip' : 'text/plain';
    const storageKey = await storage.put(buf, ext.slice(1));
    const [src] = await db.insert(sourceFiles).values({
      workId,
      storageKey,
      fileHash: sha256(buf),
      sizeBytes: buf.length,
      mimeType,
    }).returning({ id: sourceFiles.id });

    // every upload is its own import job even for identical bytes — file-level
    // dedupe (via file_hash) is a later optimization, not job identity
    const [job] = await db.insert(importJobs).values({
      workId,
      sourceFileId: src.id,
      requestedByUserId: c.get('userId'),
      requestedEncoding,
      detectedFormat: ext === '.epub' ? 'epub' : 'txt',
      processorVersion: processorVersion(ext === '.epub' ? 'epub' : 'txt'),
    }).returning({ id: importJobs.id });

    const body: ImportUploadResponse = { importId: job.id, sourceFileId: src.id };
    return c.json(body, 201);
  });

  app.get('/api/admin/imports/:id', async (c) => {
    const [job] = await db.select().from(importJobs).where(eq(importJobs.id, routeId(c))).limit(1);
    if (!job) return c.json({ error: 'not_found' }, 404);
    const [file] = await db.select({
      fileHash: sourceFiles.fileHash,
      sizeBytes: sourceFiles.sizeBytes,
      mimeType: sourceFiles.mimeType,
      createdAt: sourceFiles.createdAt,
    }).from(sourceFiles).where(eq(sourceFiles.id, job.sourceFileId)).limit(1);
    const [counts] = await db.select({
      staged: sql<number>`count(*)::int`,
      needsReview: sql<number>`(count(*) filter (where ${importItems.needsReview}))::int`,
    }).from(importItems).where(eq(importItems.importJobId, job.id));
    const body: ImportJobResponse = {
      id: job.id,
      status: job.status,
      workId: job.workId,
      requestedEncoding: job.requestedEncoding,
      detectedFormat: job.detectedFormat,
      detectedEncoding: job.detectedEncoding,
      encodingResult: (job.encodingResult as ImportJobResponse['encodingResult']) ?? null,
      chapterCount: job.chapterCount,
      errorCode: job.errorCode,
      errorDetail: job.errorDetail,
      attemptCount: job.attemptCount,
      maxAttempts: config.maxAttempts,
      stagedChapters: counts.staged,
      stagedNeedsReview: counts.needsReview,
      committedWorkId: job.committedWorkId,
      committedChapterCount: job.committedChapterCount,
      applyMode: job.applyMode,
      appliedResult: job.appliedResult,
      createdAt: job.createdAt.toISOString(),
      completedAt: job.completedAt?.toISOString() ?? null,
      sourceFile: file ? {
        fileHash: file.fileHash,
        sizeBytes: file.sizeBytes,
        mimeType: file.mimeType,
        createdAt: file.createdAt.toISOString(),
      } : null,
    };
    return c.json(body);
  });

  app.get('/api/admin/imports/:id/chapters', async (c) => {
    const id = routeId(c);
    const job = await db.select({ id: importJobs.id }).from(importJobs).where(eq(importJobs.id, id)).limit(1);
    if (job.length === 0) return c.json({ error: 'not_found' }, 404);
    const page = Math.max(1, Number(c.req.query('page') ?? 1) || 1);
    const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
    const [total] = await db.select({ n: sql<number>`count(*)::int` })
      .from(importItems).where(eq(importItems.importJobId, id));
    const items = await db.select({
      position: importItems.position,
      volumeLabel: importItems.volumeLabel,
      labelRaw: importItems.labelRaw,
      parsedLabel: importItems.parsedLabel,
      title: importItems.title,
      snippet: importItems.snippet,
      warnings: importItems.warnings,
      needsReview: importItems.needsReview,
    }).from(importItems)
      .where(eq(importItems.importJobId, id))
      .orderBy(asc(importItems.position))
      .limit(limit).offset((page - 1) * limit);
    const body: ImportChapterPageResponse = {
      total: total.n, page, limit,
      chapters: items.map((i) => ({ ...i, warnings: i.warnings as string[] })),
    };
    return c.json(body);
  });

  app.post('/api/admin/imports/:id/commit', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await commitImport(db, routeId(c), {
      workId: typeof body.workId === 'string' ? body.workId : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      workType: typeof body.workType === 'string' ? body.workType : undefined,
    });
    if (!result.ok) return c.json({ error: result.error, detail: result.detail }, result.status);
    const { ok: _ok, status: _status, ...resp } = result;
    return c.json(resp);
  });

  // M3: live match preview against the target work — classifications, anchor
  // evidence, missing chapters. Nothing is applied.
  app.get('/api/admin/imports/:id/diff', async (c) => {
    const r = await diffImport(db, routeId(c));
    if (!r.ok) return c.json({ error: r.error, detail: (r as { detail?: string }).detail }, r.status);
    return c.json(r);
  });

  // M3: incremental apply. baseEditVersion is the optimistic concurrency check
  // (§12); unresolved items need resolutions or confirmAppend.
  app.post('/api/admin/imports/:id/apply', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!Number.isInteger(body?.baseEditVersion)) {
      return c.json({ error: 'base_edit_version_required' }, 400);
    }
    const idempotencyKey = c.req.header('idempotency-key')?.trim() || null;
    if (idempotencyKey !== null && idempotencyKey.length > 200) {
      return c.json({ error: 'invalid_idempotency_key' }, 400);
    }
    const result = await applyIncremental(db, routeId(c), {
      baseEditVersion: body.baseEditVersion as number,
      mode: body.mode === 'overwrite' ? 'overwrite' : 'incremental',
      confirmAppend: body.confirmAppend === true,
      resolutions: body.resolutions && typeof body.resolutions === 'object' ? body.resolutions : undefined,
      idempotencyKey,
    });
    if (!result.ok) return c.json(result, result.status);
    const { ok: _ok, status: _status, ...resp } = result;
    return c.json(resp);
  });

  // M4: revert preview — what a protected revert would undo, and whether the
  // work is still at the version this apply produced (§18 revert-plan)
  app.post('/api/admin/imports/:id/revert-plan', async (c) => {
    const result = await revertPlan(db, routeId(c));
    if (!result.ok) return c.json({ error: result.error, detail: (result as { detail?: string }).detail }, result.status);
    return c.json(result);
  });

  // M4: execute the protected revert (single transaction, VER-02 rules)
  app.post('/api/admin/imports/:id/revert', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!Number.isInteger(body?.baseEditVersion)) {
      return c.json({ error: 'base_edit_version_required' }, 400);
    }
    const result = await revertImport(db, routeId(c), { baseEditVersion: body.baseEditVersion as number });
    if (!result.ok) return c.json({ error: result.error, detail: result.detail }, result.status);
    return c.json(result);
  });

  // re-run parsing, optionally with an explicit encoding override (encoding
  // preview→review loop from dev-plan §07)
  app.post('/api/admin/imports/:id/reanalyze', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const encoding = typeof body.encoding === 'string' && body.encoding ? body.encoding.toLowerCase() : null;
    const result = await reanalyzeImport(db, storage, routeId(c), encoding, config.maxAttempts);
    if (!result.ok) return c.json({ error: result.error, detail: result.detail }, result.status);
    return c.json({ ok: true });
  });

  return app;
}

// shared admin guard (used by app.ts for any future admin routes)
export async function requireAdmin(c: Context, next: Next): Promise<Response | void> {
  if (c.get('role') !== 'admin') return c.json({ error: 'forbidden' }, 403);
  await next();
}
