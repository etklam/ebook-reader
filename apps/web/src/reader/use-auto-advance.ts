// Hands-free advance, wired to the reader (RV-014).
//
// Owns three things the pure engine deliberately does not: the screen wake
// lock, pausing on interaction, and turning page dwell into page turns.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createAutoScroller, PAGE_DWELL, SCROLL_SPEEDS, type AdvanceSpeed,
} from './auto-advance.ts';

type WakeLock = { release(): Promise<void>; released: boolean };

/** Keep the screen on while advancing. The whole point of the feature is that
 *  nobody is touching the phone, which is also exactly what makes it sleep.
 *  Unsupported browsers get nothing — the caller surfaces that, rather than
 *  this pretending it worked. */
function useWakeLock(active: boolean): { supported: boolean; held: boolean } {
  const [held, setHeld] = useState(false);
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;

  useEffect(() => {
    if (!active || !supported) { setHeld(false); return; }
    let lock: WakeLock | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        lock = await (navigator as unknown as {
          wakeLock: { request(type: 'screen'): Promise<WakeLock> };
        }).wakeLock.request('screen');
        if (cancelled) { void lock.release(); return; }
        setHeld(true);
      } catch { setHeld(false); }   // denied, or no screen (e.g. a background tab)
    };
    void acquire();

    // The platform drops the lock whenever the page is hidden and does not
    // give it back on its own.
    const onVisible = () => { if (!document.hidden && !cancelled) void acquire(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => undefined);
      setHeld(false);
    };
  }, [active, supported]);

  return { supported, held };
}

export interface AutoAdvance {
  running: boolean;
  /** paused by the reader touching something, as opposed to stopped */
  paused: boolean;
  start(): void;
  stop(): void;
  toggle(): void;
  /** the reader interacted: hold, but keep the session alive */
  pause(): void;
  resume(): void;
  wakeLockSupported: boolean;
}

export function useAutoAdvance(input: {
  speed: AdvanceSpeed;
  mode: 'scroll' | 'paginated';
  viewportRef: React.RefObject<HTMLDivElement | null>;
  /** paginated: advance one page. Returns false when already on the last. */
  stepPage(direction: 1): boolean;
  /** scroll: reached the bottom of the chapter */
  onChapterEnd(): void;
  /** speaking and auto-advancing at once means two things moving the page at
   *  different speeds; the caller reports whether speech owns it */
  suspended: boolean;
}): AutoAdvance {
  const { speed, mode, viewportRef, stepPage, onChapterEnd, suspended } = input;
  const [running, setRunning] = useState(false);
  const [paused, setPaused] = useState(false);
  const latest = useRef({ speed, stepPage, onChapterEnd });
  latest.current = { speed, stepPage, onChapterEnd };

  const active = running && !paused && !suspended;
  const wake = useWakeLock(active);

  // scroll mode
  useEffect(() => {
    if (!active || mode !== 'scroll') return;
    const scroller = createAutoScroller({
      getContainer: () => viewportRef.current,
      pixelsPerSecond: () => SCROLL_SPEEDS[latest.current.speed],
      onEnd: () => { setRunning(false); latest.current.onChapterEnd(); },
      scheduler: {
        requestFrame: (cb) => requestAnimationFrame(cb),
        cancelFrame: (handle) => cancelAnimationFrame(handle),
      },
    });
    scroller.start();
    return () => scroller.stop();
  }, [active, mode, viewportRef]);

  // paginated mode
  useEffect(() => {
    if (!active || mode !== 'paginated') return;
    const dwell = PAGE_DWELL[latest.current.speed] * 1000;
    const timer = setInterval(() => {
      if (!latest.current.stepPage(1)) {
        setRunning(false);
        latest.current.onChapterEnd();
      }
    }, dwell);
    return () => clearInterval(timer);
  }, [active, mode, speed]);

  // A hidden tab cannot advance anything — rAF stops and an interval is
  // throttled — so pause explicitly rather than letting it drift.
  useEffect(() => {
    if (!running) return;
    const onVisibility = () => { if (document.hidden) setPaused(true); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [running]);

  const stop = useCallback(() => { setRunning(false); setPaused(false); }, []);

  return {
    running,
    paused,
    start: useCallback(() => { setRunning(true); setPaused(false); }, []),
    stop,
    toggle: useCallback(() => {
      setRunning((on) => !on);
      setPaused(false);
    }, []),
    // Pause, never stop: a reader who glances away and taps the screen wants
    // to carry on from here, not to lose the session and re-arm it.
    pause: useCallback(() => setPaused(true), []),
    resume: useCallback(() => setPaused(false), []),
    wakeLockSupported: wake.supported,
  };
}
