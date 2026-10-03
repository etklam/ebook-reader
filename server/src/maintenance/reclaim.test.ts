// L1 unit tests for the storage orphan sweep's safety rules (Phase 3.3).
// The database-backed sweeps are covered by e2e-account.test.ts; here we pin
// the reachability and age logic with a fake storage and a stub db, because
// those two rules are what stand between a GC run and data loss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweepStorage } from './reclaim.ts';
import type { Storage } from '../storage.ts';

interface FakeFile { mtime: Date }

function fakeStorage(files: Record<string, FakeFile>): Storage & { gone: string[] } {
  const gone: string[] = [];
  return {
    gone,
    put: async () => { throw new Error('unused'); },
    get: async () => { throw new Error('unused'); },
    exists: async (key) => key in files,
    delete: async (key) => { gone.push(key); delete files[key]; },
    modifiedAt: async (key) => files[key]?.mtime ?? null,
    list: async () => Object.keys(files),
  };
}

// minimal db stub: returns rows per query text
function fakeDb(rows: { revisions: string[]; sources: string[]; published: string[] }) {
  return {
    execute: async (q: unknown) => {
      const text = JSON.stringify(q);
      if (text.includes('release_items')) {
        return { rows: rows.published.map((key) => ({ key })) };
      }
      if (text.includes('chapter_revisions')) {
        return { rows: rows.revisions.map((key) => ({ key })) };
      }
      return { rows: rows.sources.map((key) => ({ key })) };
    },
  } as unknown as Parameters<typeof sweepStorage>[0];
}

const old = new Date(Date.now() - 100 * 3600 * 1000);
const fresh = new Date();

test('never deletes an object a chapter revision still references', async () => {
  const files = { 'ab/keep.txt': { mtime: old }, 'ab/orphan.txt': { mtime: old } };
  const storage = fakeStorage(files);
  const r = await sweepStorage(
    fakeDb({ revisions: ['ab/keep.txt'], sources: [], published: [] }),
    storage, () => storage.list());
  assert.deepEqual(r.deleted, ['ab/orphan.txt']);
  assert.deepEqual(storage.gone, ['ab/orphan.txt']);
  assert.equal(r.retained, 1);
});

test('never deletes an object a source file still references', async () => {
  const files = { 'ab/src.txt': { mtime: old } };
  const storage = fakeStorage(files);
  const r = await sweepStorage(
    fakeDb({ revisions: [], sources: ['ab/src.txt'], published: [] }),
    storage, () => storage.list());
  assert.deepEqual(r.deleted, []);
  assert.equal(r.retained, 1);
});

test('leaves recent unreferenced objects alone (an import writes before it commits)', async () => {
  const files = { 'ab/inflight.txt': { mtime: fresh } };
  const storage = fakeStorage(files);
  const r = await sweepStorage(
    fakeDb({ revisions: [], sources: [], published: [] }),
    storage, () => storage.list(), { minAgeHours: 24 });
  assert.deepEqual(r.deleted, [], 'a just-written object must survive the sweep');
  assert.equal(r.retained, 1);
});

test('dry run reports without deleting', async () => {
  const files = { 'ab/orphan.txt': { mtime: old } };
  const storage = fakeStorage(files);
  const r = await sweepStorage(
    fakeDb({ revisions: [], sources: [], published: [] }),
    storage, () => storage.list(), { dryRun: true });
  assert.deepEqual(r.deleted, ['ab/orphan.txt']);
  assert.deepEqual(storage.gone, [], 'dry run must not touch storage');
});

test('missing objects are split by reader reachability', async () => {
  const storage = fakeStorage({});   // nothing on disk
  const r = await sweepStorage(
    fakeDb({
      revisions: ['ab/live.txt', 'ab/draft.txt'],
      sources: [],
      published: ['ab/live.txt'],
    }),
    storage, () => storage.list());
  assert.deepEqual(r.missingPublished, ['ab/live.txt'],
    'content under an active release is the critical case');
  assert.deepEqual(r.missingUnpublished, ['ab/draft.txt']);
});

test('deletion is bounded by limit so one run cannot run away', async () => {
  const files: Record<string, FakeFile> = {};
  for (let i = 0; i < 10; i++) files[`ab/o${i}.txt`] = { mtime: old };
  const storage = fakeStorage(files);
  const r = await sweepStorage(
    fakeDb({ revisions: [], sources: [], published: [] }),
    storage, () => storage.list(), { limit: 3 });
  assert.equal(r.deleted.length, 3);
  assert.equal(r.candidates, 10, 'the full candidate count is still reported');
});
