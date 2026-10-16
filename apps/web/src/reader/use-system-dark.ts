// Tracks the OS colour-scheme preference so the reader's 'system' theme flips
// live — a reader whose phone switches to dark at sunset should not have to
// reopen the book. useSyncExternalStore keeps the subscription outside render
// and gives SSR/first paint a defined value.
import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-color-scheme: dark)';

function subscribe(onChange: () => void): () => void {
  if (typeof matchMedia !== 'function') return () => {};
  const mql = matchMedia(QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  return typeof matchMedia === 'function' && matchMedia(QUERY).matches;
}

export function useSystemDark(): boolean {
  // server snapshot is `false`: light is the safe guess when nothing is known,
  // and the client corrects it on hydration
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
