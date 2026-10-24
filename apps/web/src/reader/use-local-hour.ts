// The device's local hour, re-read when it changes (RV-016).
//
// The 'schedule' theme has to flip while the book is open — a reader at 18:59
// should not have to reopen the chapter at 19:00 — which is the same argument
// use-system-dark.ts makes for following the OS live.
import { useEffect, useState } from 'react';

/** Never sleep longer than this. A timer armed for 59 minutes is wrong after
 *  a DST change, a manual clock correction, or a laptop waking from suspend;
 *  re-checking at least this often makes all three self-heal without any of
 *  them needing to be detected. */
const MAX_SLEEP_MS = 5 * 60_000;

export function useLocalHour(): number {
  const [hour, setHour] = useState(() => new Date().getHours());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const now = new Date();
      setHour(now.getHours());
      const toNextHour = (60 - now.getMinutes()) * 60_000 - now.getSeconds() * 1000;
      timer = setTimeout(tick, Math.min(Math.max(toNextHour, 1_000), MAX_SLEEP_MS));
    };
    tick();
    // A backgrounded tab's timers are throttled or frozen, so the hour can be
    // stale by the time the reader looks again; re-read on the way back rather
    // than trusting the timer to have fired.
    const onVisible = () => { if (!document.hidden) setHour(new Date().getHours()); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return hour;
}
