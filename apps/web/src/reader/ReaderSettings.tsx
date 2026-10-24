// ReaderSettingsPanel (§10, §14): theme / font size / line height / paragraph
// spacing / conversion / mode. Every control is the same chip group — the panel
// used to mix chips and native selects, which made two identical choices look
// like different kinds of decision. Layout-affecting controls route through
// onLayoutChange so the anchor is captured before re-render (§11.3).
import { FONT_SIZE_MAX, FONT_SIZE_MIN, type ReaderSettings } from './reader-state.ts';
import type { ConversionMode } from './conversion.ts';
import { LanguageChips } from '../i18n/I18nRoot.tsx';
import { t } from '../i18n/translate.ts';

// Chip labels stay in the source language in these tables and are translated
// where they are rendered: a module-level constant runs once at import, so a
// translated constant would not follow a language switch.
const THEMES: Array<{ id: ReaderSettings['theme']; label: string }> = [
  // first, and the default: the reader opens in whatever the OS is already set to
  { id: 'system', label: '跟隨系統' },
  // a theme in its own right, not a switch layered over the others: whatever
  // paints the reader, exactly one thing decides it
  { id: 'schedule', label: '定時' },
  { id: 'light', label: '亮色' },
  { id: 'sepia', label: '護眼' },
  { id: 'dark', label: '深色' },
];

// Named steps rather than a slider: a reader who finds the right amount of
// warmth wants to get back to it, and "中" is findable where 37% is not.
const WARMTHS: Array<{ v: ReaderSettings['warmth']; label: string }> = [
  { v: 0, label: '關' },
  { v: 1, label: '低' },
  { v: 2, label: '中' },
  { v: 3, label: '高' },
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

  // Same stepper idiom as the font size control. Hours wrap rather than clamp:
  // a night window that starts at 23:00 and one that starts at 00:00 are both
  // ordinary, so there is no end of the range to stop at.
  const hourStepper = (name: string, value: number, apply: (hour: number) => void) => (
    <span className="hour-stepper" key={name}>
      <button className="chip" aria-label={t('{name}提早一小時', { name })}
        onClick={() => apply((value + 23) % 24)}>−</button>
      <span className="setting-value" aria-live="polite">
        {name} {String(value).padStart(2, '0')}:00
      </span>
      <button className="chip" aria-label={t('{name}延後一小時', { name })}
        onClick={() => apply((value + 1) % 24)}>＋</button>
    </span>
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
          {selected ? '✓ ' : ''}{t(it.label)}
        </button>
      );
    });

  return (
    <div data-testid="reader-settings">
      {/* written out rather than passed through `row`, because LanguageChips
          brings its own labelled group — `row` would nest a second one */}
      <div className="setting-row">
        <span className="setting-label">{t('語言')}</span>
        <LanguageChips label={t('介面語言')} />
      </div>

      {row(t('主題'), group(
        THEMES.map((theme) => ({ value: theme.id, label: theme.label })),
        settings.theme,
        (theme) => onChange({ theme }),
      ), t('主題'))}

      {/* only meaningful under the 定時 theme, so it appears with it rather
          than sitting inert in the panel the rest of the time */}
      {settings.theme === 'schedule' && row(t('入夜時間'), (
        <>
          {hourStepper(t('入夜'), settings.nightFrom, (nightFrom) => onChange({ nightFrom }))}
          <span className="setting-value" aria-hidden="true">–</span>
          {hourStepper(t('天亮'), settings.nightTo, (nightTo) => onChange({ nightTo }))}
        </>
      ), t('入夜時間'))}

      {row(t('暖色濾鏡'), group(
        WARMTHS.map((w) => ({ value: w.v, label: w.label })),
        settings.warmth,
        (warmth) => onChange({ warmth }),
      ), t('暖色濾鏡'))}

      {row(t('字號'), (
        <>
          <button className="chip" aria-label={t('縮小字號')} disabled={settings.fontSize <= FONT_SIZE_MIN}
            onClick={() => onLayoutChange({ fontSize: Math.max(FONT_SIZE_MIN, settings.fontSize - 2) })}>A−</button>
          <span className="setting-value" aria-live="polite">{settings.fontSize}px</span>
          <button className="chip" aria-label={t('放大字號')} disabled={settings.fontSize >= FONT_SIZE_MAX}
            onClick={() => onLayoutChange({ fontSize: Math.min(FONT_SIZE_MAX, settings.fontSize + 2) })}>A＋</button>
        </>
      ))}

      {row(t('行距'), group(
        LINE_HEIGHTS.map((l) => ({ value: l.v, label: l.label })),
        settings.lineHeight,
        (lineHeight) => onLayoutChange({ lineHeight }),
      ), t('行距'))}

      {row(t('段距'), group(
        PARA_SPACING.map((p) => ({ value: p.v, label: p.label })),
        settings.paragraphSpacing,
        (paragraphSpacing) => onLayoutChange({ paragraphSpacing }),
      ), t('段落間距'))}

      {/* the chapter text, not the interface — the 語言 row above is the UI */}
      {row(t('內文繁簡'), group(
        CONVERSIONS.map((c) => ({ value: c.id, label: c.label })),
        settings.conversion,
        (conversion) => onLayoutChange({ conversion }),
      ), t('內文繁簡轉換'))}

      {row(t('排版'), group(
        [{ value: 'scroll' as const, label: '捲動' }, { value: 'paginated' as const, label: '分頁' }],
        settings.mode,
        (mode) => onLayoutChange({ mode }),
      ), t('排版方式'))}

      {/* the tap bands are invisible by design, so the one place that explains
          them is here, next to the switch that turns the mode on */}
      {settings.mode === 'paginated' && (
        <p className="hint sheet-hint">
          {t('分頁模式：輕觸畫面下方往下一頁、上方回上一頁、中間呼出工具列；左右滑動同樣可以翻頁。')}
        </p>
      )}

      <p className="hint sheet-hint">
        {t('設定會記在這台裝置上；登入後也會同步到帳號。繁簡只影響顯示，原文內容不變。')}
      </p>
      {/* shown only where there is plausibly a keyboard — on a phone this line
          is noise, and the gesture it would describe is a swipe */}
      <p className="hint kbd-hint">
        {t('鍵盤：')}<kbd>←</kbd> <kbd>→</kbd> {t('翻頁或換章、')}<kbd>{t('空白鍵')}</kbd> {t('捲動一屏、')}
        <kbd>Home</kbd> <kbd>End</kbd> {t('到章首章尾、')}<kbd>Esc</kbd> {t('收起工具列。')}
      </p>
    </div>
  );
}
