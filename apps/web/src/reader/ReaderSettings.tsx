// ReaderSettingsPanel (§10, §14): theme / font size / line height / paragraph
// spacing / conversion / mode. Layout-affecting controls route through
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

export function ReaderSettingsPanel({
  settings, onChange, onLayoutChange,
}: {
  settings: ReaderSettings;
  onChange(patch: Partial<ReaderSettings>): void;
  onLayoutChange(patch: Partial<ReaderSettings>): void;
}) {
  const row = (label: string, control: React.ReactNode) => (
    <div className="setting-row">
      <span className="setting-label">{label}</span>
      <div className="setting-control">{control}</div>
    </div>
  );

  return (
    <div data-testid="reader-settings">
      {row('主題', THEMES.map((t) => (
        <button
          key={t.id}
          className={`reader-btn chip${settings.theme === t.id ? ' active' : ''}`}
          aria-pressed={settings.theme === t.id}
          onClick={() => onChange({ theme: t.id })}
        >
          {t.label}
        </button>
      )))}

      {row('字號', (
        <>
          <button className="reader-btn chip" aria-label="縮小字號" onClick={() => onLayoutChange({ fontSize: Math.max(FONT_SIZE_MIN, settings.fontSize - 2) })}>A−</button>
          <span className="setting-value">{settings.fontSize}px</span>
          <button className="reader-btn chip" aria-label="放大字號" onClick={() => onLayoutChange({ fontSize: Math.min(FONT_SIZE_MAX, settings.fontSize + 2) })}>A＋</button>
        </>
      ))}

      {row('行距', (
        <select className="setting-select" value={settings.lineHeight} aria-label="行距"
          onChange={(e) => onLayoutChange({ lineHeight: Number(e.target.value) })}>
          <option value="1.6">緊</option>
          <option value="1.9">標準</option>
          <option value="2.2">寬</option>
        </select>
      ))}

      {row('段距', (
        <select className="setting-select" value={settings.paragraphSpacing} aria-label="段落間距"
          onChange={(e) => onLayoutChange({ paragraphSpacing: Number(e.target.value) })}>
          <option value="0.4">緊</option>
          <option value="0.9">標準</option>
          <option value="1.4">寬</option>
        </select>
      ))}

      {row('繁簡', CONVERSIONS.map((c) => (
        <button
          key={c.id}
          className={`reader-btn chip${settings.conversion === c.id ? ' active' : ''}`}
          aria-pressed={settings.conversion === c.id}
          onClick={() => onLayoutChange({ conversion: c.id })}
        >
          {c.label}
        </button>
      )))}

      {row('排版', (
        <>
          <button className={`reader-btn chip${settings.mode === 'scroll' ? ' active' : ''}`} aria-pressed={settings.mode === 'scroll'}
            onClick={() => onLayoutChange({ mode: 'scroll' })}>捲動</button>
          <button className={`reader-btn chip${settings.mode === 'paginated' ? ' active' : ''}`} aria-pressed={settings.mode === 'paginated'}
            onClick={() => onLayoutChange({ mode: 'paginated' })}>分頁</button>
        </>
      ))}
    </div>
  );
}
