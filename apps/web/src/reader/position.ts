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
  for (const p of paras) {
    if (p.getBoundingClientRect().bottom > line) return Number(p.getAttribute(PARA_ATTR));
  }
  const last = paras[paras.length - 1];
  return last ? Number(last.getAttribute(PARA_ATTR)) : 0;
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
export function columnGap(viewport: HTMLElement): number {
  const gap = getComputedStyle(viewport).columnGap;
  const px = Number.parseFloat(gap);
  return Number.isFinite(px) ? px : 0;
}

export function columnIndexForParagraph(
  root: HTMLElement,
  index: number,
  viewport: HTMLElement,
  currentOffset: number,
): number {
  const el = getParagraphElement(root, index);
  if (!el) return 0;
  const step = viewport.clientWidth + columnGap(viewport);
  const left = el.getBoundingClientRect().left - viewport.getBoundingClientRect().left + currentOffset;
  return Math.max(0, Math.round(left / step));
}

export function columnCount(strip: HTMLElement, viewport: HTMLElement): number {
  const step = viewport.clientWidth + columnGap(viewport);
  if (step <= 0) return 1;
  return Math.max(1, Math.round(strip.scrollWidth / step));
}

// First paragraph visible in the current column (paginated mode): visibility
// is horizontal here — earlier columns sit left of the viewport edge.
export function captureColumnParagraph(root: HTMLElement, viewport: HTMLElement): number {
  const vpLeft = viewport.getBoundingClientRect().left;
  const vpRight = vpLeft + viewport.clientWidth;
  const paras = root.querySelectorAll<HTMLElement>(`[${PARA_ATTR}]`);
  for (const p of paras) {
    const left = p.getBoundingClientRect().left;
    if (left >= vpLeft - 1 && left < vpRight) return Number(p.getAttribute(PARA_ATTR));
  }
  const final = paras[paras.length - 1];
  return final ? Number(final.getAttribute(PARA_ATTR)) : 0;
}
