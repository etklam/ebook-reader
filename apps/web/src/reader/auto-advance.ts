// Hands-free advance (RV-014): smooth scrolling in scroll mode, timed page
// turns in paginated mode.
//
// Frame-driven rather than `scrollBy({ behavior: 'smooth' })`. DESIGN.md keeps
// reader content un-animated so the paragraph anchor stays measurable, and the
// browser silently drops a smooth scroll while a long chapter is still laying
// itself out — i.e. it fails in exactly the case this feature is for.
//
// The scheduler is injected so the whole thing runs under node:test. Nothing
// here touches React.

/** px per second, by level. The slowest is readable prose speed for CJK at
 *  the default size; the fastest is skimming. Named levels rather than a free
 *  number: a reader who finds their speed wants to get back to it. */
export const SCROLL_SPEEDS = [14, 22, 34, 52, 80] as const;
/** seconds a page is held, by the same level index. */
export const PAGE_DWELL = [26, 18, 12, 8, 5] as const;
export type AdvanceSpeed = 0 | 1 | 2 | 3 | 4;

export interface Scheduler {
  requestFrame(cb: (now: number) => void): number;
  cancelFrame(handle: number): void;
}

/**
 * A frame's worth of travel, with the two corrections that make slow speeds
 * and backgrounded tabs behave.
 *
 * `carry` accumulates the sub-pixel remainder: at 14 px/s a 16 ms frame is
 * 0.22 px, and a renderer that floors each frame independently never moves at
 * all. `MAX_FRAME_MS` caps the gap because requestAnimationFrame does not fire
 * in a hidden tab — without the cap, coming back after a minute would apply a
 * minute of travel in one jump and throw the reader down the chapter.
 */
export const MAX_FRAME_MS = 100;

export function frameTravel(carry: number, elapsedMs: number, pixelsPerSecond: number):
{ pixels: number; carry: number } {
  const dt = Math.min(Math.max(elapsedMs, 0), MAX_FRAME_MS);
  const total = carry + (pixelsPerSecond * dt) / 1000;
  const pixels = Math.floor(total);
  return { pixels, carry: total - pixels };
}

export interface AutoScroller {
  start(): void;
  stop(): void;
  readonly running: boolean;
}

/**
 * Scroll `getContainer()` forward at a steady rate until it will not move any
 * further, then call `onEnd`.
 *
 * "Will not move" is measured rather than computed from scrollHeight: a
 * chapter that is still loading images grows underneath us, and comparing
 * scrollTop before and after the write is the only check that stays true while
 * that happens.
 */
export function createAutoScroller(options: {
  getContainer(): HTMLElement | null;
  pixelsPerSecond(): number;
  onEnd(): void;
  scheduler: Scheduler;
}): AutoScroller {
  const { getContainer, pixelsPerSecond, onEnd, scheduler } = options;
  let handle: number | null = null;
  let last: number | null = null;
  let carry = 0;

  const step = (now: number) => {
    handle = null;
    const container = getContainer();
    if (!container) { stop(); return; }
    const elapsed = last === null ? 0 : now - last;
    last = now;
    const travel = frameTravel(carry, elapsed, pixelsPerSecond());
    carry = travel.carry;
    if (travel.pixels > 0) {
      const before = container.scrollTop;
      container.scrollTop = before + travel.pixels;
      if (container.scrollTop === before) { stop(); onEnd(); return; }
    }
    handle = scheduler.requestFrame(step);
  };

  function stop() {
    if (handle !== null) scheduler.cancelFrame(handle);
    handle = null;
    last = null;
    carry = 0;
  }

  return {
    start() {
      if (handle !== null) return;
      last = null;
      carry = 0;
      handle = scheduler.requestFrame(step);
    },
    stop,
    get running() { return handle !== null; },
  };
}
