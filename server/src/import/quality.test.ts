import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { inspectImport } from './quality.ts';
import { parseLabel } from './parse-label.ts';

const item = (position: number, label: string, body: string, volumeLabel: string | null = null) => ({
  position, labelRaw: label, title: '', parsedLabel: parseLabel(label), volumeLabel,
  bodyHash: createHash('sha256').update(body).digest('hex'),
});

test('reports large gaps, empty chapters and repeated content without mutating the source', () => {
  const items = [item(0, '第一章', '甲。'), item(1, '第二百章', ''), item(2, '第二百零一章', '甲。')];
  const before = structuredClone(items);
  const result = inspectImport(items);
  assert.equal(result.counts.gaps, 1);
  assert.equal(result.counts.empty, 1);
  assert.equal(result.counts.duplicates, 1);
  assert.deepEqual(items, before);
});

test('chapter numbering may restart in another volume', () => {
  const result = inspectImport([item(0, '第一章', '甲。', '卷一'), item(1, '第一章', '乙。', '卷二')]);
  assert.equal(result.issueCount, 0);
});
