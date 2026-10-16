// Reader settings + local reading position (M5: localStorage only — account
// sync is M6). Position contract: chapter_id + revision_id + paragraph_index;
// page numbers are never persisted (§06).
import type { ConversionMode } from './conversion.ts';

export type ReadingMode = 'scroll' | 'paginated';
/** A theme that can actually be painted. */
export type Theme = 'light' | 'sepia' | 'dark';
/** What the reader picked. 'system' resolves to light or dark at render time. */
export type ThemeChoice = Theme | 'system';

export interface ReaderSettings {
  theme: ThemeChoice;
  fontSize: number;      // px
  lineHeight: number;    // unitless
  paragraphSpacing: number; // em
  mode: ReadingMode;
  conversion: ConversionMode;
}

export const FONT_SIZE_MIN = 14;
export const FONT_SIZE_MAX = 28;

export const DEFAULT_SETTINGS: ReaderSettings = {
  theme: 'system',
  fontSize: 18,
  lineHeight: 1.9,
  paragraphSpacing: 0.9,
  mode: 'scroll',
  conversion: 'original',
};

const SETTINGS_KEY = 'ebook:reader-settings';
// v2 added the 'system' theme choice. The version marker exists only so the
// migration below can tell a stored 'light' apart from "never chose anything".
const SETTINGS_VERSION = 2;
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

// 'system' is the default, so the reader inherits the OS light/dark setting
// instead of always opening white. A v1 payload stored 'light' whether or not
// anyone picked it — it was the old default — so a v1 'light' is treated as
// "never chose" and migrated to 'system'. 護眼 and 深色 were never defaults,
// which makes them unambiguous choices, and they survive untouched.
function normalizeTheme(r: Partial<ReaderSettings> & { v?: unknown }): ThemeChoice {
  const stored = r.theme;
  const version = Number(r.v) || 1;
  if (version < SETTINGS_VERSION && (stored === 'light' || stored === undefined)) return 'system';
  return stored === 'light' || stored === 'sepia' || stored === 'dark' || stored === 'system'
    ? stored
    : DEFAULT_SETTINGS.theme;
}

/** Pure: what to actually paint, given the choice and the current OS setting. */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): Theme {
  if (choice === 'system') return prefersDark ? 'dark' : 'light';
  return choice;
}

export function normalizeSettings(raw: unknown): ReaderSettings {
  const r = (raw ?? {}) as Partial<ReaderSettings> & { v?: unknown };
  const num = (v: unknown, def: number) => {
    if (v === null || v === undefined || v === '') return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };
  return {
    theme: normalizeTheme(r),
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
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...s, v: SETTINGS_VERSION }));
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

// A deep link into a paragraph: `#p=<index>&rev=<uuid>` (written by the
// bookmarks list). The revision is carried so the reader can tell an exact
// landing from an approximate one after the chapter was revised.
export function parsePositionHash(hash: string): { paragraphIndex: number; revisionId: string } | null {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const raw = p.get('p');
  const revisionId = p.get('rev');
  if (raw === null || !revisionId) return null;   // Number(null) is 0, not absent
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 0) return null;
  return { paragraphIndex: index, revisionId };
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
