// Auto-advance engine (RV-014). The scheduler and the container are injected,
// so the awkward parts — sub-pixel speeds, a tab that was backgrounded, and
// reaching the end of a chapter that is still growing — are testable without
// a browser.
//
// Run: pnpm --filter web test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAutoScroller, frameTravel, MAX_FRAME_MS, PAGE_DWELL, SCROLL_SPEEDS,
  type Scheduler,
} from './auto-advance.ts';

test('sub-pixel speeds accumulate instead of flooring to a standstill', () => {
  // 14 px/s over a 16 ms frame is 0.22 px: a renderer that floors each frame
  // on its own never moves the page at all
  let carry = 0;
  let moved = 0;
  for (let frame = 0; frame < 60; frame++) {
    const travel = frameTravel(carry, 16, SCROLL_SPEEDS[0]);
    carry = travel.carry;
    moved += travel.pixels;
  }
  // ~1 second of frames at the slowest speed is ~14px, not 0
  assert.ok(moved >= 13 && moved <= 14, `moved ${moved}px in ~1s`);
});

test('a long gap between frames is capped, not applied', () => {
  // requestAnimationFrame does not fire in a hidden tab. Without the cap,
  // coming back after a minute lands a minute of travel in one jump.
  const jump = frameTravel(0, 60_000, SCROLL_SPEEDS[4]);
  const capped = frameTravel(0, MAX_FRAME_MS, SCROLL_SPEEDS[4]);
  assert.equal(jump.pixels, capped.pixels);
  assert.ok(jump.pixels < 10, `one frame moved ${jump.pixels}px`);
  // a negative elapsed (a clock that went backwards) moves nothing
  assert.equal(frameTravel(0, -5000, SCROLL_SPEEDS[4]).pixels, 0);
});

/** A scheduler whose frames only run when the test says so. */
function fakeScheduler() {
  let next = 1;
  const queued = new Map<number, (now: number) => void>();
  const scheduler: Scheduler = {
    requestFrame(cb) { const id = next++; queued.set(id, cb); return id; },
    cancelFrame(id) { queued.delete(id); },
  };
  return {
    scheduler,
    get pending() { return queued.size; },
    /** run exactly one queued frame at `now` */
    frame(now: number) {
      const [id, cb] = [...queued.entries()][0] ?? [];
      if (id === undefined) return false;
      queued.delete(id);
      cb!(now);
      return true;
    },
  };
}

/** A container that scrolls until it hits `limit`. */
function fakeContainer(limit: number): HTMLElement {
  let top = 0;
  return {
    get scrollTop() { return top; },
    set scrollTop(v: number) { top = Math.min(v, limit); },
  } as unknown as HTMLElement;
}

test('scrolling advances the container and stops at the end exactly once', () => {
  const clock = fakeScheduler();
  const container = fakeContainer(500);
  let ended = 0;
  const scroller = createAutoScroller({
    getContainer: () => container,
    pixelsPerSecond: () => SCROLL_SPEEDS[4],
    onEnd: () => { ended++; },
    scheduler: clock.scheduler,
  });

  scroller.start();
  assert.equal(scroller.running, true);
  let now = 0;
  // the first frame establishes the baseline and must not teleport
  clock.frame(now);
  assert.equal(container.scrollTop, 0, 'the first frame has no elapsed time to spend');

  for (let i = 0; i < 200 && clock.pending; i++) {
    now += 50;
    clock.frame(now);
  }
  assert.equal(container.scrollTop, 500, 'reached the bottom');
  assert.equal(ended, 1, 'onEnd fires once, not on every frame past the end');
  assert.equal(scroller.running, false, 'and it stops itself');
});

test('stop halts immediately and start resets the frame baseline', () => {
  const clock = fakeScheduler();
  const container = fakeContainer(10_000);
  const scroller = createAutoScroller({
    getContainer: () => container,
    pixelsPerSecond: () => SCROLL_SPEEDS[2],
    onEnd: () => {},
    scheduler: clock.scheduler,
  });

  scroller.start();
  clock.frame(0);
  clock.frame(1000);
  const afterOneSecond = container.scrollTop;
  assert.ok(afterOneSecond > 0);

  scroller.stop();
  assert.equal(clock.pending, 0, 'no frame is left queued');
  assert.equal(scroller.running, false);

  // Restarting must not bill the reader for the time they were paused: the
  // baseline resets, so the first frame after resuming moves nothing.
  scroller.start();
  clock.frame(60_000);
  assert.equal(container.scrollTop, afterOneSecond, 'the pause was not banked');
});

test('start is idempotent, so a re-render cannot double the speed', () => {
  const clock = fakeScheduler();
  const scroller = createAutoScroller({
    getContainer: () => fakeContainer(10_000),
    pixelsPerSecond: () => SCROLL_SPEEDS[1],
    onEnd: () => {},
    scheduler: clock.scheduler,
  });
  scroller.start();
  scroller.start();
  scroller.start();
  assert.equal(clock.pending, 1, 'one frame queued, not three');
});

test('a container that disappears stops the scroller rather than throwing', () => {
  const clock = fakeScheduler();
  let container: HTMLElement | null = fakeContainer(1000);
  const scroller = createAutoScroller({
    getContainer: () => container,
    pixelsPerSecond: () => SCROLL_SPEEDS[3],
    onEnd: () => {},
    scheduler: clock.scheduler,
  });
  scroller.start();
  clock.frame(0);
  container = null;           // chapter unmounted mid-scroll
  clock.frame(100);
  assert.equal(scroller.running, false);
  assert.equal(clock.pending, 0);
});

test('the two speed tables line up, and both run slow-to-fast', () => {
  assert.equal(SCROLL_SPEEDS.length, PAGE_DWELL.length,
    'a speed level must mean something in both reading modes');
  for (let i = 1; i < SCROLL_SPEEDS.length; i++) {
    assert.ok(SCROLL_SPEEDS[i] > SCROLL_SPEEDS[i - 1], 'scroll speeds ascend');
    // dwell is the inverse: a higher level holds each page for less time
    assert.ok(PAGE_DWELL[i] < PAGE_DWELL[i - 1], 'page dwell descends');
  }
});
