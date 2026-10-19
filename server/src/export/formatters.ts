// Shared immutable-content loading and format-specific book serialization.
import JSZip from 'jszip';
import type { Storage } from '../storage.ts';

const IMAGE_RE = /\[\[img:([0-9a-f]{64})\]\]/gi;
export class ExportContentUnavailable extends Error {}
export class ExportTooLarge extends Error {}
// Input budget leaves room for Unicode strings, escaped XML, ZIP and response
// buffers in the 768Mi API container. Only one export is admitted at a time.
export const EXPORT_MAX_BYTES = 16 * 1024 * 1024;
export type ExportChapter = { chapterId: string; revisionId: string | null; labelRaw: string; title: string | null; contentKey: string | null };
export type ExportResource = { revisionId: string; hash: string; alt: string; mediaType: string | null; storageKey: string | null };
type LoadedResource = ExportResource & { mediaType: string; storageKey: string };
type ExportBook = {
  work: { id: string; title: string; author: string | null; description: string | null };
  versionLabel: string;
  modifiedAt: Date;
  chapters: Array<ExportChapter & { body: string; resources: LoadedResource[] }>;
  images: Map<string, LoadedResource & { bytes: Buffer }>;
};
export interface BookFormatter {
  mediaType: string;
  serialize(book: ExportBook): Promise<Uint8Array>;
}

function xml(value: string): string {
  // Bound replaceAll's temporary ropes for adversarially dense '&' text.
  const chunks: string[] = [];
  for (let start = 0; start < value.length; start += 16_384) {
    chunks.push(value.slice(start, start + 16_384).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;'));
  }
  return chunks.join('');
}

function* exportParagraphs(body: string) {
  const text = body.trim();
  let start = 0;
  for (const match of text.matchAll(/\n\s*\n/g)) {
    yield text.slice(start, match.index);
    start = match.index + match[0].length;
  }
  yield text.slice(start);
}

function imageExtension(mediaType: string): string | null {
  return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' } as Record<string, string>)[mediaType] ?? null;
}

export async function loadExportBook(
  metadata: Pick<ExportBook, 'work' | 'versionLabel' | 'modifiedAt'>,
  chapters: ExportChapter[], resources: ExportResource[], storage: Pick<Storage, 'get' | 'size'>, maxBytes = EXPORT_MAX_BYTES,
): Promise<ExportBook> {
  let loadedBytes = 0;
  const checkBudget = (bytes: number) => {
    loadedBytes += bytes;
    if (loadedBytes > maxBytes) throw new ExportTooLarge();
  };
  // Reject before loading all bodies/images. Resource rows may include unused
  // attachments; counting them conservatively keeps this check inexpensive.
  if (storage.size) {
    const keys = new Set([...chapters.map((c) => c.contentKey), ...resources.map((r) => r.storageKey)]);
    let total = 0;
    for (const key of keys) {
      if (!key) continue;
      try { total += await storage.size(key); } catch { throw new ExportContentUnavailable(); }
      if (total > maxBytes) throw new ExportTooLarge();
    }
  }
  const read = async (key: string) => {
    let bytes: Buffer;
    try { bytes = await storage.get(key); } catch { throw new ExportContentUnavailable(); }
    checkBudget(bytes.length);
    return bytes;
  };
  const book: ExportBook = { ...metadata, chapters: [], images: new Map() };
  const resourcesByRevision = new Map<string, Map<string, ExportResource>>();
  for (const resource of resources) {
    let byHash = resourcesByRevision.get(resource.revisionId);
    if (!byHash) resourcesByRevision.set(resource.revisionId, byHash = new Map());
    byHash.set(resource.hash.toLowerCase(), resource);
  }
  for (const chapter of chapters) {
    if (!chapter.contentKey || !chapter.revisionId) throw new ExportContentUnavailable();
    const body = (await read(chapter.contentKey)).toString('utf8');
    const chapterResources: LoadedResource[] = [];
    const byHash = resourcesByRevision.get(chapter.revisionId);
    for (const marker of body.matchAll(IMAGE_RE)) {
      const resource = byHash?.get(marker[1].toLowerCase());
      if (!resource?.mediaType || !resource.storageKey) throw new ExportContentUnavailable();
      const loaded = { ...resource, hash: resource.hash.toLowerCase(), mediaType: resource.mediaType, storageKey: resource.storageKey };
      chapterResources.push(loaded);
      if (!imageExtension(loaded.mediaType) || book.images.has(loaded.hash)) continue;
      const bytes = await read(loaded.storageKey);
      book.images.set(loaded.hash, { ...loaded, bytes });
    }
    book.chapters.push({ ...chapter, body, resources: chapterResources });
  }
  return book;
}

export const txtFormatter: BookFormatter = {
  mediaType: 'text/plain; charset=utf-8',
  async serialize({ work, versionLabel, chapters }) {
    const textChapters: string[] = [];
    for (const chapter of chapters) {
      const resourceByHash = new Map(chapter.resources.map((r) => [r.hash, r]));
      const source = chapter.body;
      const body = source.replace(IMAGE_RE, (_match, hash: string) => {
        const alt = resourceByHash.get(hash.toLowerCase())?.alt;
        return alt ? `［圖片：${alt}］` : '［圖片］';
      });
      textChapters.push(`\n\n${chapter.title || chapter.labelRaw}\n\n${body.trim()}`);
    }
    const chapterText = textChapters.join('\n\n');
    const metadata = [`作品名：${work.title}`, work.author && `作者：${work.author}`,
      work.description && `簡介：${work.description}`, `版本：${versionLabel}`].filter(Boolean).join('\n');
    const bytes = new TextEncoder().encode(`\uFEFF${metadata}\n${chapterText}\n`);
    return bytes;
  },
};

export const epubFormatter: BookFormatter = {
  mediaType: 'application/epub+zip',
  async serialize({ work, modifiedAt, chapters, images }) {
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
    zip.file('META-INF/container.xml', '<?xml version="1.0" encoding="UTF-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    const imageIds = new Map<string, { id: string; path: string; mediaType: string }>();
    for (const resource of images.values()) {
      const path = `images/${resource.hash}.${imageExtension(resource.mediaType)}`;
      zip.file(`OEBPS/${path}`, resource.bytes);
      imageIds.set(resource.hash, { id: `img-${resource.hash}`, path, mediaType: resource.mediaType });
    }
    const chapterDocs = [] as Array<{ id: string; path: string; title: string }>;
    for (const [i, chapter] of chapters.entries()) {
      const resourceByHash = new Map(chapter.resources.map((r) => [r.hash, r]));
      const body = chapter.body;
      const htmlChunks: string[] = [];
      let chunk: string[] = [];
      let chunkLength = 0;
      for (const paragraph of exportParagraphs(body)) {
        const content = paragraph.split(/(\[\[img:[0-9a-f]{64}\]\])/gi).map((part) => {
          const marker = part.match(/^\[\[img:([0-9a-f]{64})\]\]$/i);
          if (!marker) return xml(part).replace(/\r?\n/g, '<br />');
          const resource = resourceByHash.get(marker[1].toLowerCase());
          const image = imageIds.get(marker[1].toLowerCase());
          if (!image) return xml(resource?.alt ? `［圖片：${resource.alt}］` : '［圖片］');
          return `<img src="../${xml(image.path)}" alt="${xml(resource?.alt ?? '')}" />`;
        }).join('');
        const line = `<p>${content}</p>`;
        chunk.push(line); chunkLength += line.length;
        if (chunkLength >= 65_536) { htmlChunks.push(chunk.join('\n')); chunk = []; chunkLength = 0; }
      }
      if (chunk.length) htmlChunks.push(chunk.join('\n'));
      const html = htmlChunks.join('\n');
      const title = chapter.title || chapter.labelRaw;
      const path = `text/chapter-${i + 1}.xhtml`;
      zip.file(`OEBPS/${path}`, `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-Hant" xml:lang="zh-Hant"><head><title>${xml(title)}</title><meta charset="utf-8"/><link rel="stylesheet" type="text/css" href="../style.css"/></head><body><h1>${xml(title)}</h1>${html}</body></html>`);
      chapterDocs.push({ id: `chapter-${i + 1}`, path, title });
    }
    zip.file('OEBPS/style.css', 'body{line-height:1.8}p{text-indent:2em;margin:0 0 1em}img{max-width:100%;height:auto}');
    const nav = chapterDocs.map((chapter) => `<li><a href="${xml(chapter.path)}">${xml(chapter.title)}</a></li>`).join('');
    zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="zh-Hant" xml:lang="zh-Hant"><head><title>目錄</title></head><body><nav epub:type="toc" id="toc"><h1>目錄</h1><ol>${nav}</ol></nav></body></html>`);
    const manifest = [
      '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
      '<item id="style" href="style.css" media-type="text/css"/>',
      ...chapterDocs.map((chapter) => `<item id="${chapter.id}" href="${xml(chapter.path)}" media-type="application/xhtml+xml"/>`),
      ...[...imageIds.values()].map((image) => `<item id="${image.id}" href="${xml(image.path)}" media-type="${xml(image.mediaType)}"/>`),
    ].join('');
    const spine = chapterDocs.map((chapter) => `<itemref idref="${chapter.id}"/>`).join('');
    zip.file('OEBPS/package.opf', `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="zh-Hant"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">urn:uuid:${work.id}</dc:identifier><dc:title>${xml(work.title)}</dc:title><dc:language>zh-Hant</dc:language>${work.author ? `<dc:creator>${xml(work.author)}</dc:creator>` : ''}${work.description ? `<dc:description>${xml(work.description)}</dc:description>` : ''}<meta property="dcterms:modified">${modifiedAt.toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta></metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`);
    const bytes = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    return bytes;
  },
};
export const bookFormatters = { txt: txtFormatter, epub: epubFormatter };
