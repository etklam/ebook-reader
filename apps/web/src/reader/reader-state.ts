// Reader settings + local reading position (M5: localStorage only — account
// sync is M6). Position contract: chapter_id + revision_id + paragraph_index;
// page numbers are never persisted (§06).
import type { ConversionMode } from './conversion.ts';

export type ReadingMode = 'scroll' | 'paginated';
export type Theme = 'light' | 'sepia' | 'dark';

export interface ReaderSettings {
  theme: Theme;
  fontSize: number;      // px
  lineHeight: number;    // unitless
  paragraphSpacing: number; // em
  mode: ReadingMode;
  conversion: ConversionMode;
}

export const FONT_SIZE_MIN = 14;
export const FONT_SIZE_MAX = 28;

export const DEFAULT_SETTINGS: ReaderSettings = {
  theme: 'light',
  fontSize: 18,
  lineHeight: 1.9,
  paragraphSpacing: 0.9,
  mode: 'scroll',
  conversion: 'original',
};

const SETTINGS_KEY = 'ebook:reader-settings';
const posKey = (workId: string) => `ebook:pos:${workId}`;

export interface ReadingPosition {
  chapterId: string;
  revisionId: string;
  paragraphIndex: number;
  /** 0..1 within the paragraph; lets scroll mode land close on reflow */
  fraction?: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function normalizeSettings(raw: unknown): ReaderSettings {
  const r = (raw ?? {}) as Partial<ReaderSettings>;
  const num = (v: unknown, def: number) => {
    if (v === null || v === undefined || v === '') return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };
  return {
    theme: r.theme === 'sepia' || r.theme === 'dark' ? r.theme : DEFAULT_SETTINGS.theme,
    fontSize: clamp(num(r.fontSize, DEFAULT_SETTINGS.fontSize), FONT_SIZE_MIN, FONT_SIZE_MAX),
    lineHeight: clamp(num(r.lineHeight, DEFAULT_SETTINGS.lineHeight), 1.4, 2.6),
    paragraphSpacing: clamp(num(r.paragraphSpacing, DEFAULT_SETTINGS.paragraphSpacing), 0, 3),
    mode: r.mode === 'paginated' ? 'paginated' : 'scroll',
    conversion: r.conversion === 't' || r.conversion === 'cn' ? r.conversion : 'original',
  };
}

export function loadSettings(): ReaderSettings {
  try {
    return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}'));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: ReaderSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export function loadPosition(workId: string): ReadingPosition | null {
  try {
    const raw = JSON.parse(localStorage.getItem(posKey(workId)) ?? 'null') as ReadingPosition | null;
    if (!raw || typeof raw.chapterId !== 'string' || typeof raw.revisionId !== 'string') return null;
    if (!Number.isInteger(raw.paragraphIndex) || raw.paragraphIndex < 0) return null;
    return raw;
  } catch {
    return null;
  }
}

export function savePosition(workId: string, pos: ReadingPosition): void {
  localStorage.setItem(posKey(workId), JSON.stringify(pos));
}

// Revision changed under the same chapter: keep the paragraph if it still
// exists, else clamp (§06) — approximate restoration is detectable because
// callers compare pos.revisionId with the loaded revisionId.
export function remapPosition(pos: ReadingPosition, revisionId: string, paragraphCount: number): ReadingPosition {
  return {
    ...pos,
    revisionId,
    paragraphIndex: clamp(pos.paragraphIndex, 0, Math.max(0, paragraphCount - 1)),
    fraction: typeof pos.fraction === 'number' ? clamp(pos.fraction, 0, 1) : undefined,
  };
}
