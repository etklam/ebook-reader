// Paragraph anchoring (§12): the DOM renders one <p data-paragraph-index> per
// canonical paragraph. Capture/restore are pure DOM utilities, independent of
// React. Raw Ranges are never persisted — only paragraph indexes.
//
// Scroll mode scrolls the .reader-scroll container (not the window); all
// functions take that container explicitly.
export const PARA_ATTR = 'data-paragraph-index';

export function getParagraphElement(root: HTMLElement, index: number): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[${PARA_ATTR}="${index}"]`);
}

// Nearest paragraph to a vertical anchor line inside the container: the first
// paragraph whose bottom passes the line, i.e. the one being read.
export function captureScrollIndex(container: HTMLElement, root: HTMLElement, viewportAnchor = 0.3): number {
  const paras = root.querySelectorAll<HTMLElement>(`[${PARA_ATTR}]`);
  const cRect = container.getBoundingClientRect();
  const line = cRect.top + cRect.height * viewportAnchor;
  // Paragraph bottoms are ordered in vertical text flow. Read fresh geometry
  // in O(log n), so font/image reflow needs no stale height cache invalidation.
  let lo = 0;
  let hi = paras.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (paras[mid].getBoundingClientRect().bottom > line) hi = mid;
    else lo = mid + 1;
  }
  const paragraph = paras[Math.min(lo, paras.length - 1)];
  return paragraph ? Number(paragraph.getAttribute(PARA_ATTR)) : 0;
}

// Fraction within the captured paragraph, for smoother restore on reflow.
export function fractionInParagraph(container: HTMLElement, el: HTMLElement, viewportAnchor = 0.3): number {
  const cRect = container.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.height <= 0) return 0;
  const line = cRect.top + cRect.height * viewportAnchor;
  return Math.min(1, Math.max(0, (line - r.top) / r.height));
}

export function restoreScrollPosition(
  container: HTMLElement,
  root: HTMLElement,
  index: number,
  fraction = 0,
  viewportAnchor = 0.3,
): void {
  const el = getParagraphElement(root, index) ?? getParagraphElement(root, 0);
  if (!el) return;
  const cRect = container.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const target = container.scrollTop + (r.top - cRect.top) + fraction * r.height - cRect.height * viewportAnchor;
  container.scrollTop = Math.max(0, target);
}

// Paginated mode: the content box is a horizontal column strip inside a fixed
// viewport; columns advance by pageWidth + gap. Rect-based so it works under
// the strip's translateX transform (offset compensated explicitly).
//
// The gap is a property of the multi-column strip, not of the viewport that
// clips it. Reading it off the viewport returned `normal` → 0, so every column
// index and the page count were computed against a step one gap too short —
// an error that compounds with distance and lands a restore dozens of pages
// away in a long chapter.
export function columnGap(strip: HTMLElement): number {
  const px = Number.parseFloat(getComputedStyle(strip).columnGap);
  return Number.isFinite(px) ? px : 0;
}

// One column plus one gap, measured off the strip's own content box rather
// than off the viewport: those are the same width only while the strip carries
// no horizontal padding, and silently disagreeing with the layout is how a
// restore ends up pages away from where it aimed.
export function columnStep(strip: HTMLElement): number {
  const cs = getComputedStyle(strip);
  const pad = (Number.parseFloat(cs.paddingLeft) || 0) + (Number.parseFloat(cs.paddingRight) || 0);
  return strip.clientWidth - pad + columnGap(strip);
}

// Measured against the strip's own origin, not the viewport's. The strip's
// border box starts at column 0, and a translateX moves the strip and its
// paragraphs together — so this difference is invariant under the page
// transform and under where the strip sits horizontally. That matters once the
// strip is narrower than the viewport and centred in it (desktop): a
// viewport-relative reading would be skewed by the centring margin, and the
// caller no longer has to pass the current page offset back in to compensate.
export function columnIndexForParagraph(root: HTMLElement, index: number): number {
  const el = getParagraphElement(root, index);
  if (!el) return 0;
  const step = columnStep(root);
  if (step <= 0) return 0;
  const left = el.getBoundingClientRect().left - root.getBoundingClientRect().left;
  return Math.max(0, Math.round(left / step));
}

export function columnCount(strip: HTMLElement): number {
  const step = columnStep(strip);
  if (step <= 0) return 1;
  return Math.max(1, Math.round(strip.scrollWidth / step));
}

// First paragraph visible in the current column (paginated mode): visibility
// is horizontal here — earlier columns sit left of the clip edge.
//
// `clip` is the element that actually bounds one page. On a phone that is the
// whole viewport; on desktop it is the centred page box inside it. Passing the
// viewport there would count columns hidden in the centring margin as visible.
//
// The test is "does this paragraph still reach into the page", not "does it
// start inside it". A paragraph long enough to fragment across columns leaves
// the column it spills into with no paragraph *starting* in it; keying on the
// start meant such a column matched nothing and fell through to the last
// paragraph of the chapter, which both saved a wildly wrong reading position
// and threw page turns to the end of a long chapter.
export function captureColumnParagraph(root: HTMLElement, clip: HTMLElement): number {
  const vpLeft = clip.getBoundingClientRect().left;
  const vpRight = vpLeft + clip.clientWidth;
  const paras = root.querySelectorAll<HTMLElement>(`[${PARA_ATTR}]`);
  for (const p of paras) {
    // A fragmented element's rect spans its first and last fragment. Require
    // intersection on both sides so a paragraph in a later column is not
    // mistaken for one visible in this page.
    const rect = p.getBoundingClientRect();
    if (rect.right > vpLeft + 1 && rect.left < vpRight - 1) return Number(p.getAttribute(PARA_ATTR));
  }
  const final = paras[paras.length - 1];
  return final ? Number(final.getAttribute(PARA_ATTR)) : 0;
}
