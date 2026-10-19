import { useEffect, useRef, type MutableRefObject } from 'react';
import { createProgressSync } from './member-sync.ts';
import type { ReadingPosition } from './reader-state.ts';

type Input = {
  workId: string | null; isMember: boolean;
  syncRef: MutableRefObject<ReturnType<typeof createProgressSync> | null>;
  captureRef: MutableRefObject<() => ReadingPosition | null>;
  onConflict(position: ReadingPosition): void; onError(): void;
};

export function useMemberProgress(input: Input) {
  const callbacks = useRef(input);
  callbacks.current = input;
  const { workId, isMember, syncRef, captureRef } = input;
  useEffect(() => {
    if (!isMember || !workId) return;
    const sync = createProgressSync(workId, () => captureRef.current(),
      (position) => callbacks.current.onConflict(position), () => callbacks.current.onError());
    syncRef.current = sync;
    return () => {
      sync.flush();
      sync.finish();
      if (syncRef.current === sync) syncRef.current = null;
    };
  }, [workId, isMember, syncRef, captureRef]);
}
