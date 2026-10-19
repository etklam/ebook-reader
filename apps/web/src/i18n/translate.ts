// UI translation. `t('目錄')` — the Traditional string *is* the key.
//
// Why keys-are-source: every string in this app was already written in
// Traditional Chinese, and the second locale is Simplified, which is a
// mechanical transform of the first (opencc + the UI vocabulary map). Inventing
// abstract keys and a parallel Simplified file would mean hand-maintaining ~500
// strings twice to produce text a converter gets right, and every missed key
// would render as `reader.toc.title` to a reader. Here a missed `t()` renders as
// Traditional — degraded, never broken.
//
// What this costs: a third locale that is *not* a Chinese script (English) needs
// real dictionaries. The seam for that is `OVERRIDES` below — a per-locale map
// consulted before the converter — so adding one is additive, not a rewrite.
//
// `t` is a module function rather than a hook so it can be called from
// module-level constants and non-component helpers. Locale changes still
// repaint: setLocale is state on I18nRoot, which sits above the whole tree and
// re-renders it (nothing here is memoized).
import { DEFAULT_LOCALE, type UiLocale } from './locale.ts';
import { applyVocabulary } from './vocabulary.ts';

export type Params = Record<string, string | number>;

/** Hand-written text for cases the converter cannot reach. Empty today: the
 *  vocabulary map covers Simplified at the word level, which is where the
 *  differences actually are. A whole-string entry belongs here when a locale
 *  needs different *phrasing*, not different characters. */
const OVERRIDES: Partial<Record<UiLocale, Record<string, string>>> = {};

type Convert = (s: string) => string;

let locale: UiLocale = DEFAULT_LOCALE;
let convert: Convert | null = null;
const cache = new Map<string, string>();

/** `{name}` placeholders, so a number can sit mid-sentence without splitting
 *  the sentence into fragments that no translator could reassemble. */
function interpolate(text: string, params: Params): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in params ? String(params[key]) : whole);
}

export function t(source: string, params?: Params): string {
  let text = source;
  if (locale !== DEFAULT_LOCALE) {
    const hit = cache.get(source);
    if (hit !== undefined) {
      text = hit;
    } else {
      const override = OVERRIDES[locale]?.[source];
      // No converter yet (still loading, or it failed to load): render the
      // source. Traditional text in a Simplified UI is a worse experience than
      // success and a better one than an empty button.
      text = override ?? (convert ? convert(applyVocabulary(source)) : source);
      if (override || convert) cache.set(source, text);
    }
  }
  return params ? interpolate(text, params) : text;
}

export function currentLocale(): UiLocale {
  return locale;
}

/**
 * Point `t` at a locale, loading what it needs first. Resolves only once `t`
 * can actually return that locale's text, so callers can switch state
 * afterwards and get one repaint instead of a flash of the old language.
 *
 * The Traditional default needs nothing loaded, so it costs no bytes and no
 * await — the common case does not pay for the feature.
 */
export async function setTranslationLocale(next: UiLocale): Promise<void> {
  if (next !== DEFAULT_LOCALE && !convert) {
    try {
      // `opencc-js/t2cn` is the one-direction build (~110 KB vs ~1.2 MB for the
      // full bundle): the UI only ever goes Traditional → Simplified.
      const { Converter } = await import('opencc-js/t2cn');
      convert = Converter({ from: 't', to: 'cn' }) as Convert;
    } catch {
      // offline or a blocked chunk: keep rendering Traditional rather than
      // failing the switch and leaving the user on a dead screen
      convert = null;
    }
  }
  if (next !== locale) cache.clear();
  locale = next;
}

/** Test seam: inject a converter instead of loading opencc. */
export function __setTranslationInternals(next: UiLocale, converter: Convert | null): void {
  locale = next;
  convert = converter;
  cache.clear();
}
