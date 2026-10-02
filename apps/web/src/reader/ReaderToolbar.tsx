// Bottom chrome (§9.3, §04). Three stacked bands, each with one job, because
// the spec is explicit that page turns and chapter turns must never collapse
// into the same ambiguous control:
//   1. page turns + page position — paginated mode only
//   2. chapter turns + where you are in the work
//   3. the five primary tools: 返回｜目錄｜書籤｜繁簡｜設定
// Safe-area aware via CSS; hidden until chrome is toggled.
import { Icon } from '../components/Icon.tsx';
import type { ConversionMode } from './conversion.ts';

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
    <nav className="reader-toolbar" data-visible={visible || undefined} aria-label="閱讀控制">
      {paginated && (
        <div className="tb-pages">
          <button className="pill-btn" onClick={onPrevPage} disabled={page <= 0}>上一頁</button>
          <span className="tb-pageinfo" aria-live="polite">{page + 1} / {pageCount}</span>
          <button className="pill-btn" onClick={onNextPage} disabled={page >= pageCount - 1}>下一頁</button>
        </div>
      )}

      <div className="tb-chapters">
        <button className="step-btn" onClick={onPrev} disabled={!hasPrev}>上一章</button>
        <span className="reader-progress">{progress}</span>
        <button className="step-btn" onClick={onNext} disabled={!hasNext}>下一章</button>
      </div>

      <div className="tb-main">
        <button className="tool-btn" aria-label="返回" onClick={onBack}>
          <Icon name="back" />返回
        </button>
        <button className="tool-btn" onClick={onToc}>
          <Icon name="toc" />目錄
        </button>
        <button className="tool-btn" aria-label="加入書籤" onClick={onBookmark}>
          <Icon name="bookmark" />書籤
        </button>
        <button
          className="tool-btn"
          aria-label={`繁簡轉換（目前：${CONVERSION_NAME[conversion]}）`}
          onClick={() => onConversion(CONVERSION_NEXT[conversion])}
        >
          <span className="tool-glyph" aria-hidden="true">{CONVERSION_GLYPH[conversion]}</span>繁簡
        </button>
        <button className="tool-btn" onClick={onSettings}>
          <Icon name="settings" />設定
        </button>
      </div>
    </nav>
  );
}
