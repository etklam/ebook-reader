// Pure pagination helpers (§21.1) — DOM logic lives in position.ts/components;
// these stay testable without a browser.
export function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(0, page), Math.max(0, pageCount - 1));
}

export function pageStep(pageWidth: number, gap: number): number {
  return pageWidth + gap;
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
