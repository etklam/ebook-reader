// What a tap zone can be bound to (RV-017).
//
// Deliberately a closed list. Every entry here is something the reader can
// also reach another way — the toolbar, a sheet, or the keyboard — because a
// tap zone is not focusable and a screen-reader or keyboard user never gets
// one. No action may exist only as a zone.
import type { ZoneLayout } from './pagination.ts';
import { zoneCount } from './pagination.ts';

export type TapAction =
  | 'none'
  | 'chrome'
  | 'nextPage' | 'prevPage'
  | 'nextChapter' | 'prevChapter'
  | 'toc' | 'settings' | 'bookmark'
  | 'speech';

export const TAP_ACTIONS: readonly TapAction[] = [
  'none', 'chrome', 'nextPage', 'prevPage', 'nextChapter', 'prevChapter',
  'toc', 'settings', 'bookmark', 'speech',
];

/** Source-language names; translated where they are rendered. */
export const TAP_ACTION_LABEL: Record<TapAction, string> = {
  none: '不做任何事',
  chrome: '顯示／隱藏介面',
  nextPage: '下一頁',
  prevPage: '上一頁',
  nextChapter: '下一章',
  prevChapter: '上一章',
  toc: '開啟目錄與搜尋',
  settings: '開啟設定',
  bookmark: '加入書籤',
  speech: '朗讀開關',
};

/** The shipped behaviour, as a layout: bottom band forward, top band back,
 *  the middle half summons the chrome. A reader who has never opened this
 *  setting must get exactly what they had before. */
export const DEFAULT_LAYOUT: ZoneLayout = '1x3';
export const DEFAULT_ACTIONS: Record<ZoneLayout, TapAction[]> = {
  '1x3': ['prevPage', 'chrome', 'nextPage'],
  '2x2': ['prevPage', 'nextPage', 'prevPage', 'nextPage'],
  '3x3': [
    'prevPage', 'chrome', 'nextPage',
    'prevPage', 'chrome', 'nextPage',
    'prevPage', 'chrome', 'nextPage',
  ],
};

/**
 * Coerce stored bindings to something paintable.
 *
 * This runs on localStorage content, so the array may be the wrong length (the
 * reader changed layout on another device), contain actions that no longer
 * exist, or not be an array at all. A short array is padded from the default
 * rather than rejected: losing one cell's binding is better than silently
 * resetting the other eight.
 */
export function normalizeTapActions(raw: unknown, layout: ZoneLayout): TapAction[] {
  const defaults = DEFAULT_ACTIONS[layout];
  const stored = Array.isArray(raw) ? raw : [];
  return Array.from({ length: zoneCount(layout) }, (_, i) => {
    const candidate = stored[i];
    return TAP_ACTIONS.includes(candidate as TapAction)
      ? candidate as TapAction
      : defaults[i] ?? 'chrome';
  });
}

export function normalizeTapLayout(raw: unknown): ZoneLayout {
  return raw === '2x2' || raw === '3x3' || raw === '1x3' ? raw : DEFAULT_LAYOUT;
}
