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
 */
export function tapZone(y: number, height: number): 'prev' | 'next' | 'chrome' {
  if (!(height > 0)) return 'chrome';
  const fraction = y / height;
  if (fraction < TAP_BAND) return 'prev';
  if (fraction > 1 - TAP_BAND) return 'next';
  return 'chrome';
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
