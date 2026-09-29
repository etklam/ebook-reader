// EPUB parsing (dev-plan §08, §19). The spine — not filename order, not the
// TOC — defines reading order (IMP-16). Security at the trust boundary: zip
// bomb caps, entry-name validation, and allowlist sanitization of every XHTML
// before its text is staged. Output shape matches parseTxt's StagedChapter.
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import { JSDOM } from 'jsdom';
import DOMPurify from 'dompurify';
import { parseLabel } from './parse-label.ts';
import type { StagedChapter } from './txt-parser.ts';

// §20 starting quotas
const MAX_ENTRIES = 5_000;
const MAX_TOTAL_UNCOMPRESSED = 250 * 1024 * 1024;
const MAX_RATIO = 100; // compressed:uncompressed
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;

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
    ALLOWED_ATTR: ['href', 'src', 'id', 'class'],
    // no absolute http(s)/data URIs: remote resources never auto-load (§19)
    ALLOWED_URI_REGEXP: /^(?!(?:https?|data|javascript|vbscript|file):)/i,
  });
}

// block-level text extraction from sanitized XHTML
function extractBody(doc: Document): { title: string | null; body: string } {
  const blocks = [...doc.querySelectorAll('h1, h2, h3, p, blockquote, li')];
  let title: string | null = null;
  const paras: string[] = [];
  for (const el of blocks) {
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (title === null && /^H[123]$/.test(el.tagName)) title = text;
    if (el.tagName === 'LI') continue; // ponytail: list items flattened out for M2; revisit when a sample needs them
    paras.push(text);
  }
  return { title, body: paras.join('\n\n') };
}

export interface ParsedEpub {
  chapters: StagedChapter[];
  warnings: string[];
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
    const { title: heading, body } = extractBody(dom.window.document);
    const labelRaw = labels.get(href) ?? '';
    const title = heading ?? labelRaw;
    const chWarnings: string[] = [];
    let needsReview = false;
    if (body === '') { chWarnings.push('non_text_section'); needsReview = true; }
    if (!labelRaw) chWarnings.push('no_toc_label');

    chapters.push({
      position: chapters.length,
      volumeLabel: null,
      labelRaw,
      parsed: labelRaw ? parseLabel(labelRaw) : null,
      title,
      body,
      warnings: chWarnings,
      needsReview,
    });
  }

  if (chapters.length === 0) throw new EpubParseError('EPUB_NO_SPINE', 'spine 沒有可用的內容文件');
  return { chapters, warnings };
}
