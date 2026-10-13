// Canonical paragraph indexes must match the reader, including image blocks.
function snippet(body: string, variants: readonly string[]) {
  // Image hashes/alt metadata are not prose; keep their paragraph position.
  if (/^\[\[img:[0-9a-f]{64}(?:\|[\s\S]*)?\]\]$/i.test(body.trim())) return null;
  const text = body.replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  let matchAt = -1;
  let matchLength = 0;
  for (const variant of variants) {
    const needle = variant.toLowerCase();
    const at = needle ? lower.indexOf(needle) : -1;
    if (at >= 0 && (matchAt < 0 || at < matchAt)) {
      matchAt = at;
      matchLength = needle.length;
    }
  }
  if (matchAt < 0) return null;
  const start = Math.max(0, matchAt - 72);
  const end = Math.min(text.length, matchAt + matchLength + 112);
  const prefix = start > 0 ? '…' : '';
  return {
    snippet: `${prefix}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
    matchStart: prefix.length + matchAt - start,
    matchLength,
  };
}

export function findChapterMatch(body: string, title: string, variants: readonly string[]) {
  const paragraphs = body.split('\n\n');
  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
    const found = snippet(paragraphs[paragraphIndex], variants);
    if (found) return { ...found, paragraphIndex };
  }
  const found = snippet(title, variants);
  return found ? { ...found, paragraphIndex: 0 } : null;
}
