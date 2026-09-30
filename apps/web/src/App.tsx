// Top-level routes (hand-rolled, no router dependency): /read/:workId/:chapterId?
// is the M5 reader; everything else stays the M2 Admin import screen.
import { useEffect, useState } from 'react';
import { AdminApp } from './admin/AdminApp.tsx';
import { ReaderPage } from './reader/ReaderPage.tsx';

export interface ReaderRoute {
  workId: string;
  chapterId: string | null;
}

export function parsePath(path: string): ReaderRoute | null {
  const m = /^\/read\/([0-9a-f-]{36})(?:\/([0-9a-f-]{36}))?$/.exec(path);
  if (!m) return null;
  return { workId: m[1], chapterId: m[2] ?? null };
}

// SPA navigate: pushState + popstate so back/forward behave natively
export function navigate(path: string): void {
  if (location.pathname === path) return;
  history.pushState(null, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  const reader = parsePath(path);
  if (reader) {
    return (
      <ReaderPage
        key={`${reader.workId}`}
        workId={reader.workId}
        initialChapterId={reader.chapterId}
      />
    );
  }
  return <AdminApp />;
}
