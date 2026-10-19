// The one piece of React state the UI language needs.
//
// `t()` is a plain function (translate.ts), so nothing below has to consume a
// context to be translated. This component exists only to repaint: it sits
// above <App/> and nothing in the tree is memoized, so setting its state
// re-renders every screen with the new language. A `key` remount would also
// work and would throw away scroll position, open sheets and half-typed forms —
// switching language should not cost you your place.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { applyDocumentLocale, loadLocale, LOCALE_LABEL, saveLocale, UI_LOCALES, type UiLocale } from './locale.ts';
import { setTranslationLocale, t } from './translate.ts';

interface LocaleContext {
  locale: UiLocale;
  /** Resolves once the new language is on screen. */
  setLocale(next: UiLocale): Promise<void>;
  /** A switch that is still fetching its converter. */
  switching: boolean;
}

const Ctx = createContext<LocaleContext>({
  locale: loadLocale(),
  setLocale: async () => {},
  switching: false,
});

export function useLocale(): LocaleContext {
  return useContext(Ctx);
}

export function I18nRoot({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<UiLocale>(() => loadLocale());
  const [switching, setSwitching] = useState(false);

  useEffect(() => { applyDocumentLocale(locale); }, [locale]);

  const setLocale = async (next: UiLocale) => {
    if (next === locale) return;
    setSwitching(true);
    try {
      // load first, then flip state: one repaint, already in the new language
      await setTranslationLocale(next);
      saveLocale(next);
      setLocaleState(next);
    } finally {
      setSwitching(false);
    }
  };

  return <Ctx.Provider value={{ locale, setLocale, switching }}>{children}</Ctx.Provider>;
}

/**
 * The language switcher. Same chip group as every other either/or choice in
 * the app (§21), so it reads as a setting and not as a special mechanism.
 */
export function LanguageChips({ label }: { label?: string }) {
  const { locale, setLocale, switching } = useLocale();
  return (
    <div className="setting-control" role="group" aria-label={label ?? t('介面語言')}>
      {UI_LOCALES.map((id) => {
        const selected = locale === id;
        return (
          <button
            key={id}
            className={`chip${selected ? ' selected' : ''}`}
            aria-pressed={selected}
            // the label is in its own script, so it must not be converted
            lang={id}
            disabled={switching && !selected}
            onClick={() => void setLocale(id)}
          >
            {selected ? '✓ ' : ''}{LOCALE_LABEL[id]}
          </button>
        );
      })}
    </div>
  );
}
