// Session hook: /api/me on mount, manual refresh after login/logout.
import { useEffect, useSyncExternalStore } from 'react';
import { getMe } from '../api/client.ts';
import type { Me } from '../api/types.ts';

// module-level cache so navigation doesn't refetch /api/me everywhere
let current: Me | null | undefined; // undefined = not yet loaded
const listeners = new Set<() => void>();

function setMe(me: Me | null | undefined): void {
  current = me;
  for (const l of listeners) l();
}

export function refreshMe(): Promise<Me | null> {
  return getMe().then(({ user }) => {
    setMe(user);
    return user;
  }).catch(() => {
    setMe(null);
    return null;
  });
}

export function useMe(): { me: Me | null; loading: boolean } {
  const subscribe = (cb: () => void) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  };
  const value = useSyncExternalStore(subscribe, () => current);
  useEffect(() => {
    if (current === undefined) void refreshMe();
  }, []);
  return { me: value ?? null, loading: value === undefined };
}
