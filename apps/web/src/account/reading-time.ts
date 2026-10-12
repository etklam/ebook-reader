import { useEffect } from 'react';

const HEARTBEAT_MS = 30_000;
const IDLE_MS = 90_000;

/** Mount from ReaderPage while a signed-in member is reading a loaded chapter. */
export function useReadingTimeTracker(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let lastActivity = Date.now();
    let accountedThrough = lastActivity;

    const report = (seconds: number) => {
      if (seconds < 1) return;
      void fetch('/api/me/reading-stats/activity', {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seconds: Math.min(60, seconds) }),
      }).catch(() => undefined);
    };
    const flush = (now: number) => {
      const activeThrough = Math.min(now, lastActivity + IDLE_MS);
      const seconds = Math.floor((activeThrough - accountedThrough) / 1000);
      if (seconds > 0) report(seconds);
      accountedThrough = Math.max(accountedThrough, activeThrough);
    };
    const interact = () => {
      const now = Date.now();
      if (now - lastActivity > IDLE_MS) {
        if (document.visibilityState === 'visible') flush(now);
        accountedThrough = now;
      }
      lastActivity = now;
    };
    const heartbeat = window.setInterval(() => {
      if (document.visibilityState === 'visible') flush(Date.now());
    }, HEARTBEAT_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        flush(Date.now());
        accountedThrough = Date.now();
      } else {
        lastActivity = Date.now();
        accountedThrough = lastActivity;
      }
    };

    for (const event of ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll']) {
      window.addEventListener(event, interact, { passive: true });
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (document.visibilityState === 'visible') flush(Date.now());
      window.clearInterval(heartbeat);
      for (const event of ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll']) {
        window.removeEventListener(event, interact);
      }
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled]);
}
