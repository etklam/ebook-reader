import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speechChunks } from './speech-chunks.ts';

test('speech skips images without renumbering canonical paragraphs and starts at current paragraph', () => {
  const marker = `[[img:${'a'.repeat(64)}]]`;
  assert.deepEqual(speechChunks(`開頭\n\n${marker}\n\n現在${marker}正文\n\n結尾`, 1), [
    { text: '現在正文', paragraphIndex: 2 }, { text: '結尾', paragraphIndex: 3 },
  ]);
  assert.deepEqual(speechChunks(`開頭\n\n[[img:${'b'.repeat(64)}|插圖說明]]\n\n接續正文`, 1), [
    { text: '接續正文', paragraphIndex: 2 },
  ]);
});
test('long paragraph chunks retain paragraph identity and Unicode characters', () => {
  const paragraph = '聲😀'.repeat(220);
  const chunks = speechChunks(`前段\n\n${paragraph}\n\n後段`, 1);
  assert.equal(chunks.filter((chunk) => chunk.paragraphIndex === 1).map((chunk) => chunk.text).join(''), paragraph);
  assert.ok(chunks.every((chunk) => Array.from(chunk.text).length <= 180));
  assert.equal(chunks.at(-1)?.paragraphIndex, 2);
  assert.deepEqual(speechChunks('正文', 100), []);
});
