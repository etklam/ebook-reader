// Search normalization (§16): Traditional/Simplified-equivalent metadata
// search at query time. The keyword is matched against both script variants;
// stored rows are never converted. opencc-js loads lazily on first search.
type Converter = (s: string) => string;

const cache: { t2cn?: Converter; cn2t?: Converter } = {};

async function converters(): Promise<{ t2cn: Converter; cn2t: Converter }> {
  if (!cache.t2cn || !cache.cn2t) {
    const { Converter } = await import('opencc-js');
    cache.t2cn = Converter({ from: 't', to: 'cn' }) as Converter;
    cache.cn2t = Converter({ from: 'cn', to: 't' }) as Converter;
  }
  return { t2cn: cache.t2cn!, cn2t: cache.cn2t! };
}

// deterministic, order-preserving variant set: original + opposite scripts.
// T→S→T round trips are avoided by deriving each variant from the original.
export async function variantsForSearch(q: string): Promise<string[]> {
  const { t2cn, cn2t } = await converters();
  const set = new Set<string>([q, t2cn(q), cn2t(q)]);
  return [...set];
}
