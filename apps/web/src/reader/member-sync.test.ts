import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProgressSync } from './member-sync.ts';
import type { ReadingPosition } from './reader-state.ts';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const position = (paragraphIndex: number): ReadingPosition => ({ chapterId: 'chapter', revisionId: 'revision', paragraphIndex });

test('concurrent flush initializes once and coalesces the newest pending anchor', async (t) => {
  let anchor = position(1);
  let reads = 0;
  const writes: Array<{ baseVersion: number; paragraphIndex: number; resolve: (r: Response) => void }> = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    if (!init.method) { reads++; return Response.json({ progress: { syncVersion: 4 } }); }
    return new Promise<Response>((resolve) => writes.push({ ...JSON.parse(init.body as string), resolve }));
  });
  const conflicts: ReadingPosition[] = [];
  const sync = createProgressSync('single-flight', () => anchor, p => conflicts.push(p), () => assert.fail('unexpected error'));
  sync.flush(); await tick();
  anchor = position(2); sync.flush(); anchor = position(20); sync.flush();
  assert.equal(reads, 1); assert.equal(writes.length, 1);
  writes[0].resolve(Response.json({ syncVersion: 5 })); await tick();
  assert.deepEqual(writes.map(w => [w.paragraphIndex, w.baseVersion]), [[1, 4], [20, 5]]);
  writes[1].resolve(Response.json({ syncVersion: 6 })); await tick();
  sync.flush(); await tick(); assert.equal(writes.length, 2);
  assert.deepEqual(conflicts, []); sync.cancel();
});

test('cancel during initialization prevents a write and callbacks', async (t) => {
  let release!: (r: Response) => void;
  let writes = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    if (init.method) writes++;
    return new Promise<Response>(resolve => { release = resolve; });
  });
  const sync = createProgressSync('cancel-init', () => position(1), () => assert.fail(), () => assert.fail());
  sync.flush(); await tick(); sync.cancel();
  release(Response.json({ progress: null })); await tick();
  sync.flush(); await tick(); assert.equal(writes, 0);
});

test('cancel suppresses an already in-flight conflict callback', async (t) => {
  let release!: (r: Response) => void;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    if (!init.method) return Response.json({ progress: null });
    return new Promise<Response>(resolve => { release = resolve; });
  });
  const sync = createProgressSync('cancel-response', () => position(1), () => assert.fail(), () => assert.fail());
  sync.flush(); await tick(); sync.cancel();
  release(Response.json({ progress: { ...position(0), syncVersion: 1 } }, { status: 409 })); await tick();
});

test('departing reader drains final anchor before a new instance initializes', async (t) => {
  let anchor = position(1);
  const events: string[] = [];
  const writes: Array<(r: Response) => void> = [];
  let serverVersion = 0;
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    if (!init.method) { events.push(`read:${serverVersion}`); return Response.json({ progress: { syncVersion: serverVersion } }); }
    const body = JSON.parse(init.body as string); events.push(`write:${body.paragraphIndex}:${body.baseVersion}`);
    return new Promise<Response>(resolve => writes.push(resolve));
  });
  const first = createProgressSync('handover', () => anchor, () => assert.fail(), () => assert.fail());
  first.flush(); await tick(); anchor = position(2); first.flush(); first.finish();
  const second = createProgressSync('handover', () => position(3), () => assert.fail(), () => assert.fail());
  second.flush(); await tick(); assert.equal(writes.length, 1);
  serverVersion = 1; writes[0](Response.json({ syncVersion: 1 })); await tick();
  serverVersion = 2; writes[1](Response.json({ syncVersion: 2 })); await tick();
  assert.deepEqual(events, ['read:0', 'write:1:0', 'write:2:1', 'read:2', 'write:3:2']);
  writes[2](Response.json({ syncVersion: 3 })); await tick(); second.cancel();
});

test('real conflict discards queued anchors; network error retries on a later flush', async (t) => {
  let call = 0; let errors = 0; const conflicts: ReadingPosition[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    if (!init.method) return Response.json({ progress: null });
    call++;
    if (call === 1) throw new Error('offline');
    if (call === 2) return Response.json({ progress: { ...position(9), syncVersion: 5 } }, { status: 409 });
    assert.equal(JSON.parse(init.body as string).baseVersion, 5);
    return Response.json({ syncVersion: 6 });
  });
  const sync = createProgressSync('retry', () => position(2), p => conflicts.push(p), () => errors++);
  sync.flush(); await tick(); assert.equal(errors, 1);
  sync.flush(); await tick(); assert.equal(conflicts[0].paragraphIndex, 9);
  sync.flush(); await tick(); assert.equal(call, 3); sync.cancel();
});
