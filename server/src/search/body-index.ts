// Immutable-object candidate index. Bloom filters may admit extra chapters but
// cannot discard a real substring match. The canonical matcher owns snippets,
// paragraph positions, whitespace and image semantics. Short queries fall back.
import { createHash } from 'node:crypto';

const MAGIC = Buffer.from('SBI2');
const FILTER_BYTES = 16 * 1024;
export const BODY_INDEX_BYTES = 4 + 32 + FILTER_BYTES;

function hashes(term: string): number[] {
  let a = 2166136261, b = 5381;
  for (const char of term) {
    const point = char.codePointAt(0)!;
    a = Math.imul(a ^ point, 16777619) >>> 0;
    b = (Math.imul(b, 33) ^ point) >>> 0;
  }
  return [a, b, (a + Math.imul(b, 3)) >>> 0].map(hash => hash % (FILTER_BYTES * 8));
}
function grams(text: string): string[] {
  const chars = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const result = new Set<string>();
  for (let i = 0; i + 2 < chars.length; i++) result.add(chars.slice(i, i + 3));
  return [...result];
}
export function buildBodyIndex(body: string): Buffer {
  const filter = Buffer.alloc(FILTER_BYTES);
  const seen = new Set<string>();
  let previous = '';
  const text = body.toLowerCase().replace(/\s+/g, ' ').trim();
  // Match JavaScript's UTF-16 indexOf semantics, including partial surrogate
  // substrings. Using code points here could create a false negative.
  for (let i = 0; i < text.length; i++) {
    const gram = previous + text[i];
    previous = gram.slice(-2);
    if (gram.length < 3 || seen.has(gram)) continue;
    seen.add(gram);
    // A very diverse object gets an all-positive filter rather than unbounded
    // index-building memory. This loses speed, never search correctness.
    if (seen.size > 100_000) { filter.fill(255); break; }
    for (const bit of hashes(gram)) filter[bit >> 3] |= 1 << (bit & 7);
  }
  return Buffer.concat([MAGIC, createHash('sha256').update(filter).digest(), filter]);
}
export function bodyIndexMayContain(index: Buffer, variants: readonly string[]): boolean {
  if (index.length !== BODY_INDEX_BYTES || !index.subarray(0, 4).equals(MAGIC)) return true;
  const filter = index.subarray(36);
  if (!index.subarray(4, 36).equals(createHash('sha256').update(filter).digest())) return true;
  return variants.some(variant => {
    // Substring queries must not be trimmed or otherwise transformed here:
    // the canonical matcher compares the literal variant against normalized text.
    const terms = grams(variant);
    return !terms.length || terms.every(gram => hashes(gram).every(bit => (filter[bit >> 3] & (1 << (bit & 7))) !== 0));
  });
}
