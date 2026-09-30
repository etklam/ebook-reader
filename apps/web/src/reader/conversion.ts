// View-time Traditional/Simplified conversion (dev-plan §15, ADR-07):
// canonical paragraphs are never mutated — conversion is a pure string map
// applied per paragraph, so paragraph count and indexes are invariant.
// opencc-js is loaded lazily on first use to keep the initial bundle small.
export type ConversionMode = 'original' | 't' | 'cn';

type Converter = (s: string) => string;

const cache: { [k: string]: Converter } = {};

async function converter(mode: 't' | 'cn'): Promise<Converter> {
  if (cache[mode]) return cache[mode];
  const { Converter } = await import('opencc-js');
  // always derive from the original; never round-trip
  cache[mode] = Converter({ from: mode === 'cn' ? 't' : 'cn', to: mode }) as Converter;
  return cache[mode];
}

export async function convertParagraphs(
  paragraphs: readonly string[],
  mode: ConversionMode,
): Promise<string[]> {
  if (mode === 'original') return [...paragraphs];
  const c = await converter(mode);
  return paragraphs.map((p) => c(p));
}
