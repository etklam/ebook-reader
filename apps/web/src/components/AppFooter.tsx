// The site-wide home for the interface language.
//
// A footer, not a header: it is a preference you set once, so it does not earn
// space at the top of every screen, and a footer is where people already look
// for a language switcher. The reader has no global chrome at all, so it keeps
// its own copy of this control in the settings sheet (ReaderSettings.tsx).
import { LanguageChips } from '../i18n/I18nRoot.tsx';
import { t } from '../i18n/translate.ts';

export function AppFooter() {
  return (
    <footer className="app-footer">
      <div className="setting-row">
        <span className="setting-label">{t('語言')}</span>
        <LanguageChips />
      </div>
      {/* says what the switch does *not* touch, because the reader has a
          second, similar-looking 繁簡 control for the chapter text itself */}
      <p className="hint">{t('只影響介面文字；章節內文的繁簡在閱讀頁設定。')}</p>
    </footer>
  );
}
