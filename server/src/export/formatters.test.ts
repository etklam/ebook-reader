import assert from 'node:assert/strict';
import { test } from 'node:test';
import JSZip from 'jszip';
import { bookFormatters, ExportContentUnavailable, loadExportBook } from './formatters.ts';

const hash = 'a'.repeat(64);
const metadata = {
  work: { id: 'book', title: 'A & B', author: 'Author', description: null },
  versionLabel: 'v2', modifiedAt: new Date('2020-02-03T04:05:06.789Z'),
};
const chapter = { chapterId: 'chapter', revisionId: 'revision', labelRaw: '1', title: 'Title', contentKey: 'body' };
const resource = { revisionId: 'revision', hash, alt: 'A < picture', mediaType: 'image/png', storageKey: 'image' };
const imageBytes = Buffer.from([0, 1, 2, 3]);
const storage = {
  async get(key: string) {
    if (key === 'body') return Buffer.from(`Hello\n\n[[img:${hash}]]`);
    if (key === 'image') return imageBytes;
    throw new Error('missing');
  },
};

test('formatters preserve text, image contents and links, and selected publication time', async () => {
  const book = await loadExportBook(metadata, [chapter], [resource], storage);
  const txt = Buffer.from(await bookFormatters.txt.serialize(book)).toString('utf8');
  assert.ok(txt.startsWith('\uFEFF作品名：A & B'));
  assert.ok(txt.includes('版本：v2'));
  assert.ok(txt.includes('［圖片：A < picture］'));
  const zip = await JSZip.loadAsync(await bookFormatters.epub.serialize(book));
  const opf = await zip.file('OEBPS/package.opf')!.async('string');
  assert.ok(opf.includes('2020-02-03T04:05:06Z'));
  assert.ok(opf.includes('A &amp; B'));
  const html = await zip.file('OEBPS/text/chapter-1.xhtml')!.async('string');
  assert.ok(html.includes(`src="../images/${hash}.png"`));
  assert.ok(html.includes('alt="A &lt; picture"'));
  assert.deepEqual(await zip.file(`OEBPS/images/${hash}.png`)!.async('nodebuffer'), imageBytes);
});

test('missing selected chapters and referenced images fail consistently before formatting', async () => {
  await assert.rejects(loadExportBook(metadata, [{ ...chapter, contentKey: null }], [], storage), ExportContentUnavailable);
  await assert.rejects(loadExportBook(metadata, [{ ...chapter, contentKey: 'missing' }], [], storage), ExportContentUnavailable);
  await assert.rejects(loadExportBook(metadata, [chapter], [], storage), ExportContentUnavailable);
  await assert.rejects(loadExportBook(metadata, [chapter], [{ ...resource, storageKey: 'missing' }], storage), ExportContentUnavailable);
  await assert.rejects(loadExportBook(metadata, [chapter], [{ ...resource, mediaType: null }], storage), ExportContentUnavailable);
});

test('case insensitive image markers resolve the same resource', async () => {
  const book = await loadExportBook(metadata, [chapter], [resource], {
    get: async (key) => key === 'body' ? Buffer.from(`[[IMG:${hash.toUpperCase()}]]`) : imageBytes,
  });
  assert.equal(book.images.size, 1);
  assert.match(Buffer.from(await bookFormatters.txt.serialize(book)).toString('utf8'), /A < picture/);
  const zip = await JSZip.loadAsync(await bookFormatters.epub.serialize(book));
  assert.match(await zip.file('OEBPS/text/chapter-1.xhtml')!.async('string'), /<img src=/);
});
