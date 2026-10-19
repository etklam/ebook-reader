// Canonical public URL construction (SEO §03B).
//
// MUST STAY IN SYNC with apps/web/src/lib/slug.ts — the client builds the links
// and the sitemap builds the same URLs from the same rows; if the two disagree,
// every sitemap entry 301s to a slightly different path and the crawler sees
// two URLs for one page. The duplication is deliberate: `server` and `apps/web`
// share no package, and a shared one for ~40 lines is not worth the build graph.
//
// A path is `<slug>-<publicId>`. The slug carries the title keywords and is
// decorative; the public id alone identifies the row. A request whose slug has
// gone stale (the title was edited) still resolves, and the reader is then
// redirected to the current canonical path — so a published link never dies.

/** Hard cap on slug characters. CJK costs 9 bytes per character once
 *  percent-encoded, so a 40-character slug is already a ~360-byte path
 *  segment; past that the keywords are not earning their length. */
const SLUG_MAX = 40;

// Everything that is not a letter, a digit or a CJK character becomes a
// separator. Latin is lowercased; CJK has no case. Note \p{Script=Han} covers
// the Han ideographs, and the two Kana ranges cover titles with Japanese in
// them — both appear in this catalogue.
const KEEP = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Letter}\p{Number}]+/gu;

/**
 * Title or label → URL slug. Never throws, and may legitimately return '' for
 * a title made entirely of punctuation; callers fall back to the bare public id.
 */
export function slugify(input: string): string {
  const parts = (input ?? '').normalize('NFKC').toLowerCase().match(KEEP);
  if (!parts) return '';
  let slug = parts.join('-');
  if (slug.length > SLUG_MAX) {
    slug = slug.slice(0, SLUG_MAX);
    // never end on a half-eaten separator
    const cut = slug.lastIndexOf('-');
    if (cut > 0) slug = slug.slice(0, cut);
  }
  return slug.replace(/^-+|-+$/g, '');
}

/** `<slug>-<publicId>`, or the bare id when the title yields no slug. */
export function slugWithId(title: string, publicId: string): string {
  const slug = slugify(title);
  return slug ? `${slug}-${publicId}` : publicId;
}

export function workPath(work: { title: string; publicId: string }): string {
  return `/works/${slugWithId(work.title, work.publicId)}`;
}

/** The reader path. A chapter's slug comes from its label and title together,
 *  which is what a reader searching for "第十二章 落雨" actually types. */
export function readPath(
  work: { title: string; publicId: string },
  chapter?: { labelRaw?: string; title?: string; publicId: string } | null,
): string {
  const base = `/read/${slugWithId(work.title, work.publicId)}`;
  if (!chapter) return base;
  const label = [chapter.labelRaw ?? '', chapter.title ?? ''].filter(Boolean).join(' ');
  return `${base}/${slugWithId(label, chapter.publicId)}`;
}

const PUBLIC_ID_RE = /^[0-9a-f]{8}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pull the identifying key out of a `<slug>-<publicId>` segment.
 *
 * The slug may itself contain '-' (a Latin title, or punctuation between CJK
 * runs), so the key is the LAST dash-separated token, not the first. A bare
 * uuid is accepted too: every link published before this scheme existed is a
 * uuid, and they must keep working rather than 404.
 */
export function parseRef(segment: string): { publicId: string } | { workId: string } | null {
  const decoded = safeDecode(segment);
  if (UUID_RE.test(decoded)) return { workId: decoded.toLowerCase() };
  const last = decoded.slice(decoded.lastIndexOf('-') + 1).toLowerCase();
  return PUBLIC_ID_RE.test(last) ? { publicId: last } : null;
}

/**
 * Is the browser already on the canonical path?
 *
 * `location.pathname` is percent-encoded; a path built from a title is raw
 * text. Comparing them directly never matches for a CJK slug, which would make
 * every chapter load rewrite the address bar for nothing.
 */
export function samePath(current: string, canonical: string): boolean {
  return safeDecode(current) === canonical;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;   // a malformed escape is not a reason to throw on a route
  }
}
