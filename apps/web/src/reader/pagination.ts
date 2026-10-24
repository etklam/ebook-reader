// Pure pagination helpers (§21.1) — DOM logic lives in position.ts/components;
// these stay testable without a browser.
export function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(0, page), Math.max(0, pageCount - 1));
}

export function pageStep(pageWidth: number, gap: number): number {
  return pageWidth + gap;
}

/** Fraction of the page height taken by each page-turn band (§9.2). */
export const TAP_BAND = 0.25;

/**
 * Paginated tap zones, measured down the page rather than across it: the
 * bottom band turns forward, the top band turns back, the middle half summons
 * the chrome. `y` is the tap's offset inside the page box.
 *
 * A box with no measured height (the first tap of a chapter that has not laid
 * itself out) resolves to the chrome: a tap must never be read as a blind page
 * turn, because a turn moves the saved position and a chrome toggle does not.
 *
 * Kept as the default layout's definition; `zoneAt` generalizes it.
 */
export function tapZone(y: number, height: number): 'prev' | 'next' | 'chrome' {
  if (!(height > 0)) return 'chrome';
  const fraction = y / height;
  if (fraction < TAP_BAND) return 'prev';
  if (fraction > 1 - TAP_BAND) return 'next';
  return 'chrome';
}

/** Grids the reader can choose between. Nothing denser than 3×3: on a 390px
 *  phone a third of the width is 130px, which a thumb can hit; a 4×6 cell is
 *  97×140 with no visible edge to aim at, so the reader would be guessing. */
export type ZoneLayout = '1x3' | '2x2' | '3x3';
export const ZONE_LAYOUTS: Record<ZoneLayout, { cols: number; rows: number }> = {
  '1x3': { cols: 1, rows: 3 },
  '2x2': { cols: 2, rows: 2 },
  '3x3': { cols: 3, rows: 3 },
};
export function zoneCount(layout: ZoneLayout): number {
  const { cols, rows } = ZONE_LAYOUTS[layout];
  return cols * rows;
}

/**
 * Which cell a tap landed in, row-major, or null when the box cannot be
 * measured.
 *
 * null rather than a fallback cell, for the same reason `tapZone` answers
 * 'chrome' on a zero height: the first tap of a chapter that has not laid
 * itself out must never be read as a page turn, because a turn moves the saved
 * position and the caller is the only thing that knows what is safe instead.
 */
export function zoneAt(
  x: number, y: number, width: number, height: number, layout: ZoneLayout,
): number | null {
  if (!(width > 0) || !(height > 0)) return null;
  const { cols, rows } = ZONE_LAYOUTS[layout];
  // Clamped because a tap on the very edge reports a coordinate equal to the
  // box size, which would otherwise index one cell past the end.
  const col = Math.min(cols - 1, Math.max(0, Math.floor((x / width) * cols)));
  const row = Math.min(rows - 1, Math.max(0, Math.floor((y / height) * rows)));
  return row * cols + col;
}

// Debounce that coalesces rapid layout-changing inputs (§11.3) and calls the
// trailing edge once the storm settles.
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) & { cancel(): void } {
  let t: ReturnType<typeof setTimeout> | null = null;
  const wrapped = (...args: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      t = null;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = () => {
    if (t) clearTimeout(t);
    t = null;
  };
  return wrapped;
}
