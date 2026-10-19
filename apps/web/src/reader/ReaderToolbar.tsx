// Bottom chrome (§9.3, §04). Three stacked bands, each with one job, because
// the spec is explicit that page turns and chapter turns must never collapse
// into the same ambiguous control:
//   1. page turns + page position — paginated mode only
//   2. chapter turns + where you are in the work
//   3. the five primary tools: 返回｜目錄｜書籤｜繁簡｜設定
// Safe-area aware via CSS; hidden until chrome is toggled.
import { Icon } from '../components/Icon.tsx';
import type { ConversionMode } from './conversion.ts';
import { t } from '../i18n/translate.ts';

// Source-language names, translated where they are rendered: a constant is
// evaluated at import and would not follow a language switch.
const CONVERSION_GLYPH: Record<ConversionMode, string> = { original: '原', t: '繁', cn: '简' };
const CONVERSION_NAME: Record<ConversionMode, string> = { original: '原文', t: '繁體', cn: '簡體' };
const CONVERSION_NEXT: Record<ConversionMode, ConversionMode> = { original: 't', t: 'cn', cn: 'original' };

export function ReaderToolbar({
  visible, hasPrev, hasNext, progress, paginated, page, pageCount, conversion,
  onPrev, onNext, onPrevPage, onNextPage, onToc, onSettings, onBookmark, onBack, onConversion,
}: {
  visible: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  progress: string;
  paginated: boolean;
  page: number;
  pageCount: number;
  conversion: ConversionMode;
  onPrev(): void;
  onNext(): void;
  onPrevPage(): void;
  onNextPage(): void;
  onToc(): void;
  onSettings(): void;
  onBookmark(): void;
  onBack(): void;
  onConversion(next: ConversionMode): void;
}) {
  return (
    <nav className="reader-toolbar" data-visible={visible || undefined} aria-label={t('閱讀控制')}>
      {paginated && (
        <div className="tb-pages">
          <button className="pill-btn" onClick={onPrevPage} disabled={page <= 0}>{t('上一頁')}</button>
          <span className="tb-pageinfo" aria-live="polite">{page + 1} / {pageCount}</span>
          <button className="pill-btn" onClick={onNextPage} disabled={page >= pageCount - 1}>{t('下一頁')}</button>
        </div>
      )}

      <div className="tb-chapters">
        <button className="step-btn" onClick={onPrev} disabled={!hasPrev}>{t('上一章')}</button>
        <span className="reader-progress">{progress}</span>
        <button className="step-btn" onClick={onNext} disabled={!hasNext}>{t('下一章')}</button>
      </div>

      <div className="tb-main">
        <button className="tool-btn" aria-label={t('返回')} onClick={onBack}>
          <Icon name="back" />{t('返回')}
        </button>
        <button className="tool-btn" onClick={onToc}>
          <Icon name="toc" />{t('目錄')}
        </button>
        <button className="tool-btn" aria-label={t('加入書籤')} onClick={onBookmark}>
          <Icon name="bookmark" />{t('書籤')}
        </button>
        <button
          className="tool-btn"
          aria-label={t('內文繁簡轉換（目前：{mode}）', { mode: t(CONVERSION_NAME[conversion]) })}
          onClick={() => onConversion(CONVERSION_NEXT[conversion])}
        >
          {/* the glyph is a sample of the script it switches to, so it is the
              one label on this bar that is never translated */}
          <span className="tool-glyph" aria-hidden="true">{CONVERSION_GLYPH[conversion]}</span>{t('繁簡')}
        </button>
        <button className="tool-btn" onClick={onSettings}>
          <Icon name="settings" />{t('設定')}
        </button>
      </div>
    </nav>
  );
}
