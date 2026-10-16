import { completionStatus, splitKeywords, type ImportMetadata } from './metadata.ts';
// EPUB parsing (dev-plan §08, §19). The spine — not filename order, not the
// TOC — defines reading order (IMP-16). Security at the trust boundary: zip
// bomb caps, entry-name validation, and allowlist sanitization of every XHTML
// before its text is staged. Output shape matches parseTxt's StagedChapter.
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { JSDOM } from 'jsdom';
import DOMPurify from 'dompurify';
import { createHash } from 'node:crypto';
import { parseLabel } from './parse-label.ts';
import type { StagedChapter } from './txt-parser.ts';
import { imageMarker } from './blocks.ts';

// §20 starting quotas
const MAX_ENTRIES = 5_000;
const MAX_TOTAL_UNCOMPRESSED = 250 * 1024 * 1024;
const MAX_RATIO = 100; // compressed:uncompressed
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;

// --- resource limits (ADR-08) -------------------------------------------------
const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;
const MAX_RESOURCES_PER_BOOK = 2_000;
const MAX_RESOURCE_TOTAL_BYTES = 150 * 1024 * 1024;

/**
 * Raster formats only, by design.
 *
 * SVG is deliberately excluded: an SVG is a document that can carry script and
 * external references, and we serve resources from our own origin. Supporting
 * it safely would mean sanitizing SVG as markup — reopening exactly the
 * question ADR-07 closed by making the canonical model plain text. Unsupported
 * types are reported as a warning, never silently dropped.
 */
const ALLOWED_MEDIA = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

const EXT_MEDIA = new Map<string, string>([
  ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'],
  ['png', 'image/png'], ['gif', 'image/gif'], ['webp', 'image/webp'],
]);

/** A resource extracted from the source, ready to be stored content-addressed. */
export interface ExtractedResource {
  contentHash: string;
  mediaType: string;
  /** file extension for the storage object */
  ext: string;
  bytes: Buffer;
}

/** Where a chapter body's marker came from, for traceability (§08). */
export interface ResourceRef {
  contentHash: string;
  sourceHref: string;
  alt: string;
}

export type EpubError =
  | 'EPUB_MALFORMED'
  | 'EPUB_ZIP_BOMB'
  | 'EPUB_PATH_TRAVERSAL'
  | 'EPUB_NO_SPINE';

export class EpubParseError extends Error {
  code: EpubError;
  constructor(code: EpubError, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true });
const forceArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// resolve href relative to the OPF (or container) path
function resolve(opfDir: string, href: string): string {
  const clean = decodeURIComponent(href.split('#')[0]);
  if (clean.startsWith('/')) return clean.slice(1);
  const parts = (opfDir ? opfDir.split('/') : []).concat(clean.split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out.join('/');
}

function sanitizeXhtml(raw: string): string {
  const window = new JSDOM('').window;
  const purify = DOMPurify(window);
  return purify.sanitize(raw, {
    ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'em', 'strong', 'br', 'a', 'img', 'blockquote', 'aside', 'li', 'ul', 'ol'],
    // 'alt' matters: it is the only accessible description of an image and
    // without it in the allowlist every extracted alt came through empty
    ALLOWED_ATTR: ['href', 'src', 'id', 'class', 'alt'],
    // no absolute http(s)/data URIs: remote resources never auto-load (§19)
    ALLOWED_URI_REGEXP: /^(?!(?:https?|data|javascript|vbscript|file):)/i,
  });
}

// --- footnotes (§08) ------------------------------------------------------------
// EPUB footnotes are a noteref anchor pointing at an aside/div elsewhere in the
// document. Previously the aside text was not in the extracted block set at all,
// so the note simply vanished — silent content loss. Notes are now collected
// and appended as numbered endnote paragraphs, with the inline reference
// rewritten to a readable 「[註 n]」 marker.
//
// This preserves the content and the correspondence. It is NOT an interactive
// footnote: there is no popover and no back-link, which stays out of scope
// until a real sample demands it (see dev-plan §26 / ADR-08).
const NOTE_SELECTOR = 'aside, [class*="footnote"], [class*="note"]';

interface Footnotes {
  /** element ids that are note bodies, so block extraction can skip them */
  noteBodyIds: Set<string>;
  /** note id → assigned number */
  numbering: Map<string, number>;
  /** collected note text, in assigned order */
  texts: string[];
}

function collectFootnotes(doc: Document): Footnotes {
  const noteBodyIds = new Set<string>();
  const numbering = new Map<string, number>();
  const texts: string[] = [];

  // A note body is an aside/note-ish element that something links to by id.
  const linkedIds = new Set<string>();
  for (const a of doc.querySelectorAll('a[href^="#"]')) {
    linkedIds.add((a.getAttribute('href') ?? '').slice(1));
  }
  for (const el of doc.querySelectorAll(NOTE_SELECTOR)) {
    const id = el.getAttribute('id');
    if (!id || !linkedIds.has(id)) continue;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    noteBodyIds.add(id);
    numbering.set(id, texts.length + 1);
    texts.push(text);
  }
  return { noteBodyIds, numbering, texts };
}

// Replace each noteref anchor with a readable inline marker, in place, so the
// surrounding paragraph's text comes out with the marker already embedded.
function inlineNoteMarkers(doc: Document, notes: Footnotes): void {
  for (const a of doc.querySelectorAll('a[href^="#"]')) {
    const target = (a.getAttribute('href') ?? '').slice(1);
    const n = notes.numbering.get(target);
    if (n === undefined) continue;
    a.replaceWith(doc.createTextNode(`[註 ${n}]`));
  }
}

// block-level text extraction from sanitized XHTML. Images become their own
// canonical paragraph marker at the position they appeared.
function extractBody(
  doc: Document,
  images: Map<string, ResourceRef>,   // src attribute (resolved) → ref
  notes: Footnotes,
): { title: string | null; body: string } {
  const blocks = [...doc.querySelectorAll('h1, h2, h3, p, blockquote, li, img')];
  let title: string | null = null;
  const paras: string[] = [];

  for (const el of blocks) {
    if (el.tagName === 'IMG') {
      const key = el.getAttribute('data-resolved-src') ?? '';
      const ref = images.get(key);
      // an image we could not extract (unsupported type, too large, missing)
      // leaves no marker — the warning for it is raised by the extractor
      if (!ref) continue;
      // Every occurrence emits a marker. Deliberately NOT deduplicated: an
      // author who placed the same ornament three times meant three. Dedupe
      // belongs in storage (one object per content hash), not in the body.
      paras.push(imageMarker(ref.contentHash, ref.alt));
      continue;
    }
    // skip note bodies: they are appended as endnotes instead of appearing
    // mid-prose where the publisher happened to place the markup
    if (el.closest(NOTE_SELECTOR)?.getAttribute('id')
      && notes.noteBodyIds.has(el.closest(NOTE_SELECTOR)!.getAttribute('id')!)) {
      continue;
    }
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (title === null && /^H[123]$/.test(el.tagName)) title = text;
    if (el.tagName === 'LI') continue; // ponytail: list items flattened out for M2; revisit when a sample needs them
    paras.push(text);
  }

  for (const [i, note] of notes.texts.entries()) {
    paras.push(`[註 ${i + 1}] ${note}`);
  }
  return { title, body: paras.join('\n\n') };
}

export interface ParsedEpub {
  metadata: ImportMetadata;
  chapters: StagedChapter[];
  warnings: string[];
  /** deduplicated resource bytes to store, content-addressed */
  resources: ExtractedResource[];
}

export async function parseEpub(bytes: Buffer): Promise<ParsedEpub> {
  const zip = await JSZip.loadAsync(bytes).catch(() => {
    throw new EpubParseError('EPUB_MALFORMED', '不是可讀的 ZIP');
  });

  // --- zip safety (§19): entries, ratio, total size, path traversal ---------
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ENTRIES) {
    throw new EpubParseError('EPUB_ZIP_BOMB', `條目數 ${entries.length} 超過上限`);
  }
  let total = 0;
  for (const e of entries) {
    if (e.dir) continue;
    if (e.name.startsWith('/') || e.name.split('/').includes('..')) {
      throw new EpubParseError('EPUB_PATH_TRAVERSAL', `可疑路徑：${e.name.slice(0, 40)}`);
    }
    // _data is JSZip-internal but the only place central-directory sizes live
    // before decompression — exactly what a bomb check needs
    const meta = (e as unknown as { _data?: { uncompressedSize: number; compressedSize: number } })._data;
    const size = meta?.uncompressedSize ?? 0;
    const ratio = meta ? size / Math.max(1, meta.compressedSize) : 1;
    if (ratio > MAX_RATIO) {
      throw new EpubParseError('EPUB_ZIP_BOMB', `壓縮比異常：${e.name.slice(0, 40)}`);
    }
    total += size;
    if (total > MAX_TOTAL_UNCOMPRESSED || size > MAX_ENTRY_BYTES) {
      throw new EpubParseError('EPUB_ZIP_BOMB', '解壓縮總量超過上限');
    }
  }

  // --- container → OPF --------------------------------------------------------
  const containerFile = zip.file('META-INF/container.xml');
  if (!containerFile) throw new EpubParseError('EPUB_MALFORMED', '缺少 META-INF/container.xml');
  const container = xml.parse(await containerFile.async('string'));
  const rootfiles = forceArray(container?.container?.rootfiles?.rootfile);
  const opfPath = rootfiles[0]?.['@full-path'];
  if (typeof opfPath !== 'string') throw new EpubParseError('EPUB_MALFORMED', 'container.xml 沒有 rootfile');
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';

  const opfFile = zip.file(opfPath);
  if (!opfFile) throw new EpubParseError('EPUB_MALFORMED', `找不到 OPF：${opfPath}`);
  const opf = xml.parse(await opfFile.async('string'));
  const bookMetadata = opf?.package?.metadata;
  const metadataText = (value: unknown): string => forceArray(value)
    .map((v) => typeof v === 'object' && v !== null ? String((v as Record<string, unknown>)['#text'] ?? '') : String(v ?? ''))
    .join('、').trim();
  const descriptionDom = new JSDOM(metadataText(bookMetadata?.description));
  const description = descriptionDom.window.document.body.textContent?.trim() ?? '';
  descriptionDom.window.close();
  const statusMeta = forceArray(bookMetadata?.meta).filter((m) =>
    /^(status|serialStatus|狀態|状态|連載狀態|连载状态)$/i.test(String(m?.['@name'] ?? m?.['@property'] ?? '')));
  // dc:subject is the de-facto genre/tag field; keep it as a suggestion so the
  // admin does not have to retype what the packager already recorded.
  const keywords = splitKeywords(metadataText(bookMetadata?.subject));
  const metadata: ImportMetadata = {
    title: metadataText(bookMetadata?.title).slice(0, 300) || undefined,
    author: metadataText(bookMetadata?.creator).slice(0, 300) || undefined,
    description: description.slice(0, 5000) || undefined,
    serialStatus: completionStatus(statusMeta.map((m) => m['@content'] ?? m['#text'] ?? '').join(' ')),
    keywords: keywords.length ? keywords : undefined,
  };

  const manifestItems = new Map<string, { href: string; type: string; properties: string }>();
  for (const item of forceArray(opf?.package?.manifest?.item)) {
    manifestItems.set(item['@id'], {
      href: String(item['@href'] ?? ''),
      type: String(item['@media-type'] ?? ''),
      properties: String(item['@properties'] ?? ''),
    });
  }

  const spineRefs = forceArray(opf?.package?.spine?.itemref);
  if (spineRefs.length === 0) throw new EpubParseError('EPUB_NO_SPINE', 'spine 沒有任何 itemref');

  // --- TOC labels: nav.xhtml preferred, NCX fallback (§08) --------------------
  const labels = new Map<string, string>(); // resolved href (no fragment) → label
  const navItem = [...manifestItems.values()].find((i) => i.properties.split(/\s+/).includes('nav'));
  if (navItem) {
    const navFile = zip.file(resolve(opfDir, navItem.href));
    if (navFile) {
      const dom = new JSDOM(sanitizeXhtml(await navFile.async('string')), { contentType: 'text/html' });
      for (const a of dom.window.document.querySelectorAll('nav a[href], ol a[href], ul a[href]')) {
        const href = resolve(opfDir, a.getAttribute('href') ?? '');
        const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (href && text && !labels.has(href)) labels.set(href, text);
      }
    }
  } else {
    const ncxId = opf?.package?.spine?.['@toc'];
    const ncxItem = ncxId ? manifestItems.get(String(ncxId)) : undefined;
    if (ncxItem) {
      const ncxFile = zip.file(resolve(opfDir, ncxItem.href));
      if (ncxFile) {
        const ncx = xml.parse(await ncxFile.async('string'));
        for (const np of forceArray(ncx?.ncx?.navMap?.navPoint)) {
          const src = np?.content?.['@src'];
          const text = np?.navLabel?.text;
          if (typeof src === 'string' && typeof text === 'string') {
            const href = resolve(opfDir, src);
            if (!labels.has(href)) labels.set(href, String(text).trim());
          }
        }
      }
    }
  }

  // --- walk the spine: reading order, deduped, nav document skipped ----------
  const warnings: string[] = [];
  const chapters: StagedChapter[] = [];
  const seen = new Set<string>();
  // content-addressed so the same image referenced from ten chapters is read,
  // hashed and stored once
  const resources = new Map<string, ExtractedResource>();
  let resourceTotalBytes = 0;

  /** read, validate and hash one referenced image; null when unusable */
  const extractImage = async (resolvedHref: string): Promise<ExtractedResource | null> => {
    const file = zip.file(resolvedHref);
    if (!file) {
      warnings.push(`圖片引用的檔案不存在：${resolvedHref.slice(0, 60)}`);
      return null;
    }
    const declared = [...manifestItems.values()].find((i) => resolve(opfDir, i.href) === resolvedHref)?.type;
    const ext = resolvedHref.split('.').pop()?.toLowerCase() ?? '';
    const mediaType = (declared && ALLOWED_MEDIA.has(declared)) ? declared : EXT_MEDIA.get(ext);
    if (!mediaType || !ALLOWED_MEDIA.has(mediaType)) {
      warnings.push(`不支援的圖片格式（已略過，不支援 SVG）：${resolvedHref.slice(0, 60)}`);
      return null;
    }
    const bytes = await file.async('nodebuffer');
    if (bytes.length > MAX_RESOURCE_BYTES) {
      warnings.push(`圖片超過單檔上限（已略過）：${resolvedHref.slice(0, 60)}`);
      return null;
    }
    const contentHash = createHash('sha256').update(bytes).digest('hex');
    const existing = resources.get(contentHash);
    if (existing) return existing;
    if (resources.size >= MAX_RESOURCES_PER_BOOK
      || resourceTotalBytes + bytes.length > MAX_RESOURCE_TOTAL_BYTES) {
      warnings.push('圖片數量或總量超過上限，其餘圖片已略過');
      return null;
    }
    const res: ExtractedResource = {
      contentHash,
      mediaType,
      ext: ALLOWED_MEDIA.get(mediaType)!,
      bytes,
    };
    resources.set(contentHash, res);
    resourceTotalBytes += bytes.length;
    return res;
  };

  const navIds = new Set(
    [...manifestItems.entries()].filter(([, i]) => i.properties.split(/\s+/).includes('nav')).map(([id]) => id),
  );

  for (const ref of spineRefs) {
    const id = String(ref['@idref'] ?? '');
    const item = manifestItems.get(id);
    if (!item) {
      warnings.push(`spine 引用了不存在的 manifest 項：${id}`);
      continue;
    }
    if (navIds.has(id)) continue; // the nav document is navigation, not content
    if (String(ref['@linear'] ?? 'yes') === 'no') {
      warnings.push(`非線性項目被跳過：${item.href.slice(0, 40)}`);
      continue;
    }
    const href = resolve(opfDir, item.href);
    if (!href.toLowerCase().endsWith('.xhtml') && !href.toLowerCase().endsWith('.html') && !href.toLowerCase().endsWith('.htm')) {
      warnings.push(`spine 內非 XHTML 項目被跳過：${href.slice(0, 40)}`);
      continue;
    }
    if (seen.has(href)) {
      warnings.push(`spine 重複引用同一文件（只保留一次）：${href.slice(0, 40)}`);
      continue;
    }
    seen.add(href);

    const file = zip.file(href);
    if (!file) {
      warnings.push(`manifest 引用的檔案不存在：${href.slice(0, 40)}`);
      continue;
    }

    const clean = sanitizeXhtml(await file.async('string'));
    const dom = new JSDOM(clean, { contentType: 'text/html' });
    const doc = dom.window.document;

    // resolve every <img src> against this document's directory before the DOM
    // is read, so extractBody can look each one up by its resolved key
    const docDir = href.includes('/') ? href.slice(0, href.lastIndexOf('/')) : '';
    const images = new Map<string, ResourceRef>();
    for (const img of doc.querySelectorAll('img[src]')) {
      const src = img.getAttribute('src') ?? '';
      const resolvedHref = resolve(docDir, src);
      img.setAttribute('data-resolved-src', resolvedHref);
      if (images.has(resolvedHref)) continue;
      const res = await extractImage(resolvedHref);
      if (!res) continue;
      images.set(resolvedHref, {
        contentHash: res.contentHash,
        sourceHref: resolvedHref,
        alt: (img.getAttribute('alt') ?? '').replace(/\s+/g, ' ').trim(),
      });
    }

    const notes = collectFootnotes(doc);
    inlineNoteMarkers(doc, notes);
    const { title: heading, body } = extractBody(doc, images, notes);
    const labelRaw = labels.get(href) ?? '';
    const title = heading ?? labelRaw;
    const chWarnings: string[] = [];
    let needsReview = false;
    if (body === '') { chWarnings.push('non_text_section'); needsReview = true; }
    if (!labelRaw) chWarnings.push('no_toc_label');
    if (notes.texts.length > 0) chWarnings.push('footnotes_appended');

    chapters.push({
      position: chapters.length,
      volumeLabel: null,
      labelRaw,
      parsed: labelRaw ? parseLabel(labelRaw) : null,
      title,
      body,
      warnings: chWarnings,
      needsReview,
      resources: [...images.values()],
    });
  }

  if (chapters.length === 0) throw new EpubParseError('EPUB_NO_SPINE', 'spine 沒有可用的內容文件');
  return { chapters, warnings, resources: [...resources.values()], metadata };
}
