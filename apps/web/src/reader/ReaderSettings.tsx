// ReaderSettingsPanel (§10, §14): theme / font size / line height / paragraph
// spacing / conversion / mode. Every control is the same chip group — the panel
// used to mix chips and native selects, which made two identical choices look
// like different kinds of decision. Layout-affecting controls route through
// onLayoutChange so the anchor is captured before re-render (§11.3).
import { FONT_SIZE_MAX, FONT_SIZE_MIN, type ReaderSettings } from './reader-state.ts';
import type { ConversionMode } from './conversion.ts';

const THEMES: Array<{ id: ReaderSettings['theme']; label: string }> = [
  { id: 'light', label: '亮色' },
  { id: 'sepia', label: '護眼' },
  { id: 'dark', label: '深色' },
];

const CONVERSIONS: Array<{ id: ConversionMode; label: string }> = [
  { id: 'original', label: '原文' },
  { id: 't', label: '繁體' },
  { id: 'cn', label: '簡體' },
];

const LINE_HEIGHTS = [
  { v: 1.6, label: '緊' },
  { v: 1.9, label: '標準' },
  { v: 2.2, label: '寬' },
];

const PARA_SPACING = [
  { v: 0.4, label: '緊' },
  { v: 0.9, label: '標準' },
  { v: 1.4, label: '寬' },
];

export function ReaderSettingsPanel({
  settings, onChange, onLayoutChange,
}: {
  settings: ReaderSettings;
  onChange(patch: Partial<ReaderSettings>): void;
  onLayoutChange(patch: Partial<ReaderSettings>): void;
}) {
  const row = (label: string, control: React.ReactNode, groupLabel?: string) => (
    <div className="setting-row" key={label}>
      <span className="setting-label">{label}</span>
      <div className="setting-control" role={groupLabel ? 'group' : undefined} aria-label={groupLabel}>
        {control}
      </div>
    </div>
  );

  // the ✓ is part of the chip's selected state everywhere else on the site
  // (§21: never colour alone) — this panel used to signal it with colour and
  // weight only
  const group = <T,>(items: Array<{ value: T; label: string }>, current: T, apply: (v: T) => void) =>
    items.map((it) => {
      const selected = current === it.value;
      return (
        <button
          key={String(it.value)}
          className={`chip${selected ? ' selected' : ''}`}
          aria-pressed={selected}
          onClick={() => apply(it.value)}
        >
          {selected ? '✓ ' : ''}{it.label}
        </button>
      );
    });

  return (
    <div data-testid="reader-settings">
      {row('主題', group(
        THEMES.map((t) => ({ value: t.id, label: t.label })),
        settings.theme,
        (theme) => onChange({ theme }),
      ), '主題')}

      {row('字號', (
        <>
          <button className="chip" aria-label="縮小字號" disabled={settings.fontSize <= FONT_SIZE_MIN}
            onClick={() => onLayoutChange({ fontSize: Math.max(FONT_SIZE_MIN, settings.fontSize - 2) })}>A−</button>
          <span className="setting-value" aria-live="polite">{settings.fontSize}px</span>
          <button className="chip" aria-label="放大字號" disabled={settings.fontSize >= FONT_SIZE_MAX}
            onClick={() => onLayoutChange({ fontSize: Math.min(FONT_SIZE_MAX, settings.fontSize + 2) })}>A＋</button>
        </>
      ))}

      {row('行距', group(
        LINE_HEIGHTS.map((l) => ({ value: l.v, label: l.label })),
        settings.lineHeight,
        (lineHeight) => onLayoutChange({ lineHeight }),
      ), '行距')}

      {row('段距', group(
        PARA_SPACING.map((p) => ({ value: p.v, label: p.label })),
        settings.paragraphSpacing,
        (paragraphSpacing) => onLayoutChange({ paragraphSpacing }),
      ), '段落間距')}

      {row('繁簡', group(
        CONVERSIONS.map((c) => ({ value: c.id, label: c.label })),
        settings.conversion,
        (conversion) => onLayoutChange({ conversion }),
      ), '繁簡轉換')}

      {row('排版', group(
        [{ value: 'scroll' as const, label: '捲動' }, { value: 'paginated' as const, label: '分頁' }],
        settings.mode,
        (mode) => onLayoutChange({ mode }),
      ), '排版方式')}

      <p className="hint sheet-hint">
        設定會記在這台裝置上；登入後也會同步到帳號。繁簡只影響顯示，原文內容不變。
      </p>
      {/* shown only where there is plausibly a keyboard — on a phone this line
          is noise, and the gesture it would describe is a swipe */}
      <p className="hint kbd-hint">
        鍵盤：<kbd>←</kbd> <kbd>→</kbd> 翻頁或換章、<kbd>空白鍵</kbd> 捲動一屏、
        <kbd>Home</kbd> <kbd>End</kbd> 到章首章尾、<kbd>Esc</kbd> 收起工具列。
      </p>
    </div>
  );
}
