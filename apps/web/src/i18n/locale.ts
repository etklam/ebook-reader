// Which language the *interface* is in. Separate from the reader's 繁簡 setting
// (reader/conversion.ts), which is about the chapter text: someone can read an
// author's Traditional original with a Simplified interface, and the reverse.
export type UiLocale = 'zh-Hant' | 'zh-Hans';

export const UI_LOCALES: readonly UiLocale[] = ['zh-Hant', 'zh-Hans'];

/** Each locale names itself in its own script — a language switcher written in
 *  a language you do not read is no use to the person who needs it. */
export const LOCALE_LABEL: Record<UiLocale, string> = {
  'zh-Hant': '繁體中文',
  'zh-Hans': '简体中文',
};

/** For `toLocaleString` / `og:locale` / `<html lang>`. */
export const LOCALE_TAG: Record<UiLocale, string> = {
  'zh-Hant': 'zh-Hant',
  'zh-Hans': 'zh-Hans',
};

export const DEFAULT_LOCALE: UiLocale = 'zh-Hant';

const KEY = 'ebook:ui-locale';

export function isUiLocale(value: unknown): value is UiLocale {
  return value === 'zh-Hant' || value === 'zh-Hans';
}

/**
 * Pure: the locale implied by a list of BCP-47 tags the browser reports.
 *
 * Only an explicitly Simplified tag switches the UI — `zh-Hans`, or one of the
 * regions that imply it. A bare `zh` is left to the default: it says the user
 * reads Chinese, not which script, and guessing wrong on a site whose content
 * is Traditional is the worse error. Everything non-Chinese also lands on the
 * default, since Traditional is all this build ships.
 */
export function localeFromTags(tags: readonly string[]): UiLocale {
  for (const raw of tags) {
    const tag = raw.toLowerCase();
    if (!tag.startsWith('zh')) continue;
    if (/\bhans\b/.test(tag) || /-(cn|sg|my)\b/.test(tag)) return 'zh-Hans';
    if (/\bhant\b/.test(tag) || /-(tw|hk|mo)\b/.test(tag)) return 'zh-Hant';
  }
  return DEFAULT_LOCALE;
}

/** A stored choice wins over the browser's: it is the one the user made here. */
export function loadLocale(): UiLocale {
  try {
    const stored = localStorage.getItem(KEY);
    if (isUiLocale(stored)) return stored;
  } catch {
    // private mode / storage disabled — fall through to detection
  }
  if (typeof navigator === 'undefined') return DEFAULT_LOCALE;
  return localeFromTags(navigator.languages ?? [navigator.language]);
}

export function saveLocale(locale: UiLocale): void {
  try {
    localStorage.setItem(KEY, locale);
  } catch {
    // a locale that cannot be remembered is still worth applying this session
  }
}

/** `<html lang>` drives font selection, hyphenation and what a screen reader
 *  pronounces, so it has to follow the switcher and not index.html. */
export function applyDocumentLocale(locale: UiLocale): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = LOCALE_TAG[locale];
}
