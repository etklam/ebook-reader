import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureScrollIndex } from './position.ts';

test('scroll lookup preserves first paragraph crossing anchor with logarithmic geometry reads', () => {
  let reads = 0;
  let height = 100;
  const paragraphs = Array.from({ length: 5000 }, (_, index) => ({
    getBoundingClientRect: () => { reads++; return { bottom: (index + 1) * height }; },
    getAttribute: () => String(index),
  }));
  let anchor = 444450;
  const container = { getBoundingClientRect: () => ({ top: anchor - 30, height: 100 }) } as HTMLElement;
  const root = { querySelectorAll: () => paragraphs } as unknown as HTMLElement;
  assert.equal(captureScrollIndex(container, root), 4444);
  assert.ok(reads <= 13, `geometry reads ${reads}`);
  // Reflow changes measured heights; no cached offsets may remain.
  height = 200; reads = 0;
  assert.equal(captureScrollIndex(container, root), 2222);
  assert.ok(reads <= 13);
  anchor = 1000001;
  assert.equal(captureScrollIndex(container, root), 4999);
  anchor = -10;
  assert.equal(captureScrollIndex(container, root), 0);
  assert.equal(captureScrollIndex(container, { querySelectorAll: () => [] } as unknown as HTMLElement), 0);
});
