import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { I18nRoot } from './i18n/I18nRoot.tsx';
import { applyDocumentLocale, loadLocale } from './i18n/locale.ts';
import { setTranslationLocale } from './i18n/translate.ts';
import { installServiceWorkerEscapeHatch, registerServiceWorker } from './pwa.ts';
import './styles/tokens.css';
import './styles/app.css';
import './styles/reader.css';

// The UI language is settled before the first render, so a Simplified reader
// never sees a frame of Traditional. For the Traditional default this loads
// nothing and resolves on the next microtask.
const locale = loadLocale();
applyDocumentLocale(locale);
void setTranslationLocale(locale).then(() => {
  createRoot(document.getElementById('root')!).render(
    <I18nRoot><App /></I18nRoot>,
  );
});

installServiceWorkerEscapeHatch();
registerServiceWorker();
