// Reader settings + local reading position (M5: localStorage only — account
// sync is M6). Position contract: chapter_id + revision_id + paragraph_index;
// page numbers are never persisted (§06).
import type { ConversionMode } from './conversion.ts';
import type { AdvanceSpeed } from './auto-advance.ts';
import type { ZoneLayout } from './pagination.ts';
import {
  DEFAULT_ACTIONS, DEFAULT_LAYOUT, normalizeTapActions, normalizeTapLayout, type TapAction,
} from './tap-actions.ts';

export type ReadingMode = 'scroll' | 'paginated';
/** A theme that can actually be painted. */
export type Theme = 'light' | 'sepia' | 'dark';
/**
 * What the reader picked. 'system' follows the OS; 'schedule' follows the
 * clock. Both are *choices of theme*, not switches layered on top of one —
 * a theme has exactly one source, or two of them fight over every repaint.
 */
export type ThemeChoice = Theme | 'system' | 'schedule';

/** Warm overlay strength. A level rather than a free number: the panel is
 *  chips, and four named steps are easier to return to than a slider. */
export type Warmth = 0 | 1 | 2 | 3;

export interface ReaderSettings {
  theme: ThemeChoice;
  fontSize: number;      // px
  lineHeight: number;    // unitless
  paragraphSpacing: number; // em
  mode: ReadingMode;
  conversion: ConversionMode;
  /** blue-light overlay; 0 is off */
  warmth: Warmth;
  /** hands-free advance speed. A speed, not an on/off: whether it is running
   *  is session state, because a book that starts scrolling by itself the next
   *  time it is opened is a surprise, not a preference. */
  autoSpeed: AdvanceSpeed;
  /** at the end of a chapter, carry on into the next one */
  autoContinue: boolean;
  /** tap-zone grid, and what each cell does (row-major) */
  tapLayout: ZoneLayout;
  tapActions: TapAction[];
  /** hour (0-23, device local) the 'schedule' theme turns dark */
  nightFrom: number;
  /** hour (0-23, device local) it turns light again */
  nightTo: number;
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
  warmth: 0,
  autoSpeed: 2,
  autoContinue: false,
  tapLayout: DEFAULT_LAYOUT,
  tapActions: DEFAULT_ACTIONS[DEFAULT_LAYOUT],
  nightFrom: 19,
  nightTo: 7,
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
  return stored === 'light' || stored === 'sepia' || stored === 'dark'
    || stored === 'system' || stored === 'schedule'
    ? stored
    : DEFAULT_SETTINGS.theme;
}

/**
 * Is `hour` inside the night window? The window wraps midnight in the normal
 * case (19→7), so this cannot be a plain range test. A window whose ends are
 * equal means "never", not "always": a reader who sets both to the same hour
 * has not asked to be in the dark permanently.
 */
export function isNightHour(hour: number, from: number, to: number): boolean {
  if (from === to) return false;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/** Pure: what to actually paint, given the choice, the OS setting and the
 *  clock. `hour` is the device's local hour; the caller owns the clock so this
 *  stays testable. */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean,
  clock?: { hour: number; nightFrom: number; nightTo: number }): Theme {
  if (choice === 'system') return prefersDark ? 'dark' : 'light';
  if (choice === 'schedule') {
    // Without a clock there is nothing to schedule against; fall back to the
    // OS rather than guessing, so a caller that forgets degrades to 'system'
    // instead of pinning every reader to light.
    if (!clock) return prefersDark ? 'dark' : 'light';
    return isNightHour(clock.hour, clock.nightFrom, clock.nightTo) ? 'dark' : 'light';
  }
  return choice;
}

/** Multiply filters for the warm overlay, indexed by `Warmth`.
 *  Level 0 paints nothing at all — an overlay at rgb(255,255,255) is a no-op
 *  that still costs a compositing layer over the whole reader. */
export const WARMTH_FILTERS: Record<Warmth, string | null> = {
  0: null,
  1: 'rgb(255, 247, 232)',
  2: 'rgb(255, 238, 210)',
  3: 'rgb(255, 226, 184)',
};

export function normalizeSettings(raw: unknown): ReaderSettings {
  const r = (raw ?? {}) as Partial<ReaderSettings> & { v?: unknown };
  const num = (v: unknown, def: number) => {
    if (v === null || v === undefined || v === '') return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };
  const tapLayout = normalizeTapLayout(r.tapLayout);
  return {
    theme: normalizeTheme(r),
    fontSize: clamp(num(r.fontSize, DEFAULT_SETTINGS.fontSize), FONT_SIZE_MIN, FONT_SIZE_MAX),
    lineHeight: clamp(num(r.lineHeight, DEFAULT_SETTINGS.lineHeight), 1.4, 2.6),
    paragraphSpacing: clamp(num(r.paragraphSpacing, DEFAULT_SETTINGS.paragraphSpacing), 0, 3),
    mode: r.mode === 'paginated' ? 'paginated' : 'scroll',
    conversion: r.conversion === 't' || r.conversion === 'cn' ? r.conversion : 'original',
    // Settings arrive from localStorage and from the account sync, so every
    // one of these is untrusted input: a stored warmth of 9 or a nightFrom of
    // -3 must land on something paintable rather than on a blank screen.
    warmth: ([0, 1, 2, 3] as const).includes(r.warmth as Warmth)
      ? r.warmth as Warmth : DEFAULT_SETTINGS.warmth,
    nightFrom: hour(r.nightFrom, DEFAULT_SETTINGS.nightFrom),
    nightTo: hour(r.nightTo, DEFAULT_SETTINGS.nightTo),
    autoSpeed: ([0, 1, 2, 3, 4] as const).includes(r.autoSpeed as AdvanceSpeed)
      ? r.autoSpeed as AdvanceSpeed : DEFAULT_SETTINGS.autoSpeed,
    autoContinue: r.autoContinue === true,
    tapLayout, tapActions: normalizeTapActions(r.tapActions, tapLayout),
  };
}

/** Whole hours only, 0-23. A fractional or out-of-range value is not clamped
 *  into something adjacent — it is not a time, so it falls back to the default. */
function hour(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
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
