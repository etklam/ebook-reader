// Scoped integration regression: every database fixture lives in one rolled
// back transaction. Run after migrations; no shared rows are deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { makeDb } from '../src/db/client.ts';
import { chapters, chapterRevisions, works, users, sourceFiles, importJobs } from '../src/db/schema.ts';
import { localStorage } from '../src/storage.ts';
import { adminChapterRoutes } from '../src/routes/admin-chapters.ts';
import { adminWorkRoutes } from '../src/routes/admin-works.ts';
import { readerRoutes } from '../src/routes/reader.ts';
import { meRoutes } from '../src/routes/me.ts';
import { applyIncremental } from '../src/import/apply-incremental.ts';
import { revertImport } from '../src/import/revert.ts';
import { publishPreview } from '../src/publish/publish.ts';

const url = process.env.WORKER_DATABASE_URL;
test('merge preserves immutable ownership and only active chapters appear in head paths', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  const root = await mkdtemp(join(tmpdir(), 'chapter-integrity-'));
  const storage = localStorage(root);
  const rollback = new Error('rollback isolated chapter fixtures');
  try {
    await assert.rejects(makeDb(pool).transaction(async (tx) => {
      const db = tx as unknown as NodePgDatabase;
      const [work] = await tx.insert(works).values({ title: 'merge regression', workType: 'serial', serialStatus: 'ongoing' }).returning();
      const rows = [];
      for (let position = 1; position <= 4; position++) {
        const [chapter] = await tx.insert(chapters).values({ workId: work.id, labelRaw: String(position), editorialPosition: position }).returning();
        const contentKey = await storage.put(Buffer.from(`body ${position}\n\nsecond ${position}`), 'txt');
        const [revision] = await tx.insert(chapterRevisions).values({ chapterId: chapter.id, title: `chapter ${position}`, contentKey, bodyCompareHash: `hash${position}`, revisionHash: `revision${position}`, processorVersion: 'regression' }).returning();
        await tx.update(chapters).set({ headRevisionId: revision.id }).where(eq(chapters.id, chapter.id));
        rows.push({ ...chapter, headRevisionId: revision.id });
      }
      const app = new Hono<{ Variables: { role: string; userId: string } }>();
      app.use('*', async (c, next) => { c.set('role', 'admin'); c.set('userId', work.id); await next(); });
      app.route('/', adminChapterRoutes({ db, storage }));
      app.route('/', adminWorkRoutes({ db, storage }));
      app.route('/', readerRoutes({ db, storage }));
      app.route('/', meRoutes({ db }));
      const base = `/api/admin/chapter-editor/works/${work.id}/chapters`;
      const request = (path: string, body: unknown, method = 'POST') => app.request(path, {
        method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      let survivorRevision = rows[0].headRevisionId;
      for (const absorbed of rows.slice(1, 3)) {
        const response = await request(`${base}/${rows[0].id}/merge-next`, {
          expectedRevisionId: survivorRevision, nextChapterId: absorbed.id,
          expectedNextRevisionId: absorbed.headRevisionId, labelRaw: 'merged', title: 'merged chapter',
        });
        assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
        survivorRevision = (await response.json() as { revisionId: string }).revisionId;
      }
      const persisted = await tx.select().from(chapters).where(eq(chapters.workId, work.id));
      assert.equal(persisted.length, 4);
      for (const absorbed of rows.slice(1, 3)) {
        const saved = persisted.find((row) => row.id === absorbed.id)!;
        assert.equal(saved.mergedIntoChapterId, rows[0].id);
        assert.equal(saved.headRevisionId, absorbed.headRevisionId);
        assert.equal(saved.editorialPosition, absorbed.editorialPosition);
        const [originalRevision] = await tx.select().from(chapterRevisions).where(eq(chapterRevisions.id, absorbed.headRevisionId));
        assert.equal(originalRevision.chapterId, absorbed.id);
        assert.equal((await app.request(`${base}/${absorbed.id}/revisions/${absorbed.headRevisionId}`)).status, 200);
        assert.equal((await app.request(`${base}/${rows[0].id}/revisions/${absorbed.headRevisionId}`)).status, 404);
        assert.equal((await app.request(`${base}/${absorbed.id}`)).status, 404);
        assert.equal((await app.request(`/api/reader/chapters/${absorbed.id}`)).status, 404);
        assert.equal((await request('/api/me/reads', { chapterId: absorbed.id })).status, 404);
        assert.equal((await request(`${base}/${absorbed.id}`, { expectedRevisionId: absorbed.headRevisionId, labelRaw: 'edit', title: 'edit', body: 'edit' }, 'PATCH')).status, 404);
      }
      for (const path of [base, `/api/admin/preview/works/${work.id}/chapters`, `/api/reader/works/${work.id}/chapters`]) {
        const response = await app.request(path);
        assert.equal(response.status, 200);
        const data = await response.json() as { chapters: Array<{ id: string }> };
        assert.deepEqual(data.chapters.map((row) => row.id), [rows[0].id, rows[3].id]);
      }
      const preview = await publishPreview(db, storage, work.id);
      assert.ok(preview.ok);
      assert.equal(preview.chapterCount, 2);
      const head = await (await app.request(`/api/reader/chapters/${rows[0].id}`)).json() as { nextChapterId: string; body: string };
      assert.equal(head.nextChapterId, rows[3].id);
      assert.match(head.body, /body 1[\s\S]*body 2[\s\S]*body 3/);
      const split = await request(`${base}/${rows[0].id}/split`, {
        expectedRevisionId: survivorRevision, afterParagraph: 1, rightLabelRaw: 'split', rightTitle: 'split chapter',
      });
      assert.equal(split.status, 200, JSON.stringify(await split.clone().json()));
      const splitData = await split.json() as { chapterId: string };
      const shifted = await tx.select().from(chapters).where(eq(chapters.workId, work.id));
      assert.equal(shifted.find((row) => row.id === splitData.chapterId)!.editorialPosition, 2);
      assert.equal(shifted.find((row) => row.id === rows[1].id)!.editorialPosition, 3);
      assert.equal(shifted.find((row) => row.id === rows[2].id)!.editorialPosition, 4);
      assert.equal(shifted.find((row) => row.id === rows[3].id)!.editorialPosition, 5);
      // Even an empty incremental apply renumbers active rows: retained
      // tombstone slots must not collide with the compacted active order.
      const [user] = await tx.insert(users).values({ username: 'merge regression', email: `${work.id}@regression.invalid`, passwordHash: 'not-used', role: 'admin' }).returning();
      const [source] = await tx.insert(sourceFiles).values({ storageKey: `regression-${work.id}`, fileHash: work.id, sizeBytes: 0, mimeType: 'text/plain' }).returning();
      const [job] = await tx.insert(importJobs).values({ workId: work.id, sourceFileId: source.id, requestedByUserId: user.id, status: 'ready', processorVersion: 'regression' }).returning();
      const [beforeApply] = await tx.select().from(works).where(eq(works.id, work.id));
      const applied = await applyIncremental(db, job.id, { baseEditVersion: beforeApply.editVersion });
      assert.ok(applied.ok, JSON.stringify(applied));
      const reverted = await revertImport(db, job.id, { baseEditVersion: applied.newEditVersion });
      assert.ok(reverted.ok, JSON.stringify(reverted));
      const afterRevert = await tx.select().from(chapters).where(eq(chapters.workId, work.id));
      assert.equal(new Set(afterRevert.map((row) => row.editorialPosition)).size, afterRevert.length);
      for (const absorbed of rows.slice(1, 3)) {
        const saved = afterRevert.find((row) => row.id === absorbed.id)!;
        assert.equal(saved.editorialPosition, absorbed.editorialPosition + 1);
        assert.equal(saved.headRevisionId, absorbed.headRevisionId);
        assert.equal(saved.mergedIntoChapterId, rows[0].id);
      }
      throw rollback;
    }), (error) => error === rollback);
  } finally {
    await pool.end();
    await rm(root, { recursive: true, force: true });
  }
});
