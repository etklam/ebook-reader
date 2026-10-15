import { splitParagraphs } from './paragraphs.ts';

/** Keep canonical paragraph indices even when image-only paragraphs are skipped. */
export function speechChunks(text: string, startParagraph = 0): Array<{ text: string; paragraphIndex: number }> {
  return splitParagraphs(text).flatMap((paragraph, paragraphIndex) => {
    if (paragraphIndex < Math.max(0, startParagraph)) return [];
    if (/^\[\[img:[0-9a-f]{64}(?:\|[\s\S]*)?\]\]$/i.test(paragraph.trim())) return [];
    const plain = paragraph.replace(/\[\[img:[0-9a-f]{64}(?:\|[\s\S]*?)?\]\]/gi, '').trim();
    return Array.from(plain).reduce<string[]>((chunks, character, index) => {
      const chunk = Math.floor(index / 180);
      chunks[chunk] = (chunks[chunk] ?? '') + character;
      return chunks;
    }, []).map((chunk) => ({ text: chunk, paragraphIndex }));
  });
}
