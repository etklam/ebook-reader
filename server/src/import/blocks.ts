// Canonical body block markers (ADR-08).
//
// ADR-07 fixed the canonical body as paragraphs joined by "\n\n", each a plain
// text node. That left no way to represent an image, so EPUB parsing flattened
// images away entirely and IMP-17 (resource-aware revision detection) was
// unimplementable — there was no resource layer to detect a change in.
//
// Rather than move the canonical model to HTML — which would reopen every
// sanitization question ADR-07 closed — a paragraph may now be *exactly* one
// marker. Anything that is not a marker is still plain text, byte for byte, so
// every existing chapter keeps its current meaning and the reader's paragraph
// anchoring is unaffected.
//
//   [[img:<64-hex sha256>|<alt>]]   a resource reference
//   [[note:<n>]]                    endnote marker (see footnotes below)
//
// The reference is the content hash, not a storage key or URL: the body stays
// stable across storage migrations and is content-addressed like the resource
// table itself.

/** A whole paragraph that is an image reference. */
export interface ImageBlock {
  kind: 'image';
  contentHash: string;
  alt: string;
}

/** A whole paragraph of prose. */
export interface TextBlock {
  kind: 'text';
  text: string;
}

export type Block = ImageBlock | TextBlock;

// anchored and strict: a paragraph that merely *contains* bracket text is prose
const IMG_RE = /^\[\[img:([0-9a-f]{64})(?:\|([\s\S]*))?\]\]$/;

export function imageMarker(contentHash: string, alt = ''): string {
  // alt is sanitized to a single line: a newline would split the paragraph and
  // silently turn half the marker into prose
  const safeAlt = alt.replace(/\s+/g, ' ').replace(/[[\]|]/g, '').trim().slice(0, 300);
  return safeAlt ? `[[img:${contentHash}|${safeAlt}]]` : `[[img:${contentHash}]]`;
}

export function parseBlock(paragraph: string): Block {
  const m = paragraph.match(IMG_RE);
  if (m) return { kind: 'image', contentHash: m[1], alt: (m[2] ?? '').trim() };
  return { kind: 'text', text: paragraph };
}

/** Canonical body → blocks. Mirrors the reader's own split (\n\n). */
export function parseBlocks(body: string): Block[] {
  if (body === '') return [];
  return body.split('\n\n').map(parseBlock);
}

/** Content hashes referenced by a canonical body, in first-appearance order. */
export function referencedHashes(body: string): string[] {
  const seen = new Set<string>();
  for (const block of parseBlocks(body)) {
    if (block.kind === 'image') seen.add(block.contentHash);
  }
  return [...seen];
}
