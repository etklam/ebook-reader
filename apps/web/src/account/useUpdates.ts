// Followed-work update count for the bottom nav badge (§51). One request per
// session, shared by every surface through the same module store useMe uses —
// a badge is not worth a fetch on every navigation. Surfaces that change the
// seen state (opening a work, following, unfollowing) call refreshUpdates().
import { useEffect, useSyncExternalStore } from 'react';
import { getFollows } from '../api/client.ts';

let current: number | null = null;   // null = unknown / not a member
let generation = 0;
let inFlight: { generation: number; promise: Promise<void> } | null = null;
const listeners = new Set<() => void>();

function set(n: number | null): void {
  if (n === current) return;
  current = n;
  for (const l of listeners) l();
}

export function refreshUpdates(force = false): Promise<void> {
  if (inFlight && !force) return inFlight.promise;
  const requestGeneration = ++generation;
  const promise = getFollows()
    .then((r) => { if (requestGeneration === generation) set(r.follows.filter((f) => f.hasUpdate).length); })
    // a badge is decoration over the truth; never surface its failure
    .catch(() => { if (requestGeneration === generation) set(null); })
    .finally(() => {
      if (inFlight?.generation === requestGeneration) inFlight = null;
    });
  inFlight = { generation: requestGeneration, promise };
  return promise;
}

export function clearUpdates(): void {
  generation++;
  inFlight = null;
  set(null);
}

/** number of followed works with unseen chapters; null while unknown */
export function useUpdateCount(isMember: boolean): number | null {
  const subscribe = (cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };
  const value = useSyncExternalStore(subscribe, () => current);
  useEffect(() => {
    if (isMember && current === null) void refreshUpdates();
  }, [isMember]);
  return isMember ? value : null;
}
