// Bottom toolbar (§9.3): compact set only — prev / TOC / settings / next.
// Safe-area aware via CSS; hidden until chrome is toggled.
export function ReaderToolbar({
  visible, hasPrev, hasNext, progress, onPrev, onNext, onToc, onSettings, onBookmark,
}: {
  visible: boolean;
  hasPrev: boolean;
  hasNext: boolean;
  progress: string;
  onPrev(): void;
  onNext(): void;
  onToc(): void;
  onSettings(): void;
  onBookmark?(): void;
}) {
  return (
    <nav className="reader-toolbar" data-visible={visible || undefined} aria-label="閱讀控制">
      <button className="reader-btn" aria-label="上一章" onClick={onPrev} disabled={!hasPrev}>上一章</button>
      <button className="reader-btn" aria-label="目錄" onClick={onToc}>目錄</button>
      <span className="reader-progress">{progress}</span>
      {onBookmark && <button className="reader-btn" aria-label="加入書籤" onClick={onBookmark}>書籤</button>}
      <button className="reader-btn" aria-label="設定" onClick={onSettings}>設定</button>
      <button className="reader-btn" aria-label="下一章" onClick={onNext} disabled={!hasNext}>下一章</button>
    </nav>
  );
}
