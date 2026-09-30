// Top-level routes (hand-rolled, no router dependency):
//   /                        public catalog (M6)
//   /works/:workId           work detail
//   /read/:workId/:chapterId reader (M5)
//   /login, /register        member auth
//   /me/library, /me/bookmarks member pages
//   /admin                   import/publish/taxonomy admin (M2–M4 + M6)
import { useEffect, useState } from 'react';
import { AdminApp } from './admin/AdminApp.tsx';
import { ReaderPage } from './reader/ReaderPage.tsx';
import { CatalogPage } from './catalog/CatalogPage.tsx';
import { WorkDetailPage } from './catalog/WorkDetailPage.tsx';
import { LoginPage } from './account/LoginPage.tsx';
import { RegistrationPage } from './account/RegistrationPage.tsx';
import { LibraryPage } from './account/LibraryPage.tsx';
import { BookmarksPage } from './account/BookmarksPage.tsx';
import { BottomNav } from './components/BottomNav.tsx';

export interface ReaderRoute { workId: string; chapterId: string | null }

const UUID = '([0-9a-f-]{36})';

export function parsePath(path: string):
  | { page: 'reader'; route: ReaderRoute }
  | { page: 'work'; workId: string }
  | { page: 'catalog' }
  | { page: 'login' }
  | { page: 'register' }
  | { page: 'library' }
  | { page: 'bookmarks' }
  | { page: 'admin' } {
  let m: RegExpMatchArray | null;
  if ((m = path.match(new RegExp(`^/read/${UUID}(?:/(${UUID}))?$`)))) {
    return { page: 'reader', route: { workId: m[1], chapterId: m[2] ?? null } };
  }
  if ((m = path.match(new RegExp(`^/works/${UUID}$`)))) return { page: 'work', workId: m[1] };
  if (path === '/login') return { page: 'login' };
  if (path === '/register') return { page: 'register' };
  if (path === '/me/library') return { page: 'library' };
  if (path === '/me/bookmarks') return { page: 'bookmarks' };
  if (path.startsWith('/admin')) return { page: 'admin' };
  return { page: 'catalog' };
}

// SPA navigate: pushState + popstate so back/forward behave natively
export function navigate(path: string): void {
  if (location.pathname + location.search === path) return;
  history.pushState(null, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
}

export function App() {
  const [loc, setLoc] = useState(location.pathname + location.search);
  useEffect(() => {
    const onPop = () => setLoc(location.pathname + location.search);
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  const path = loc.split('?')[0];
  const route = parsePath(path);

  // the reader owns its whole surface; no global chrome there
  if (route.page === 'reader') {
    return <ReaderPage key={route.route.workId} workId={route.route.workId} initialChapterId={route.route.chapterId} />;
  }

  let page: React.ReactNode;
  switch (route.page) {
    case 'work': page = <WorkDetailPage key={route.workId} workId={route.workId} />; break;
    case 'login': page = <LoginPage />; break;
    case 'register': page = <RegistrationPage />; break;
    case 'library': page = <LibraryPage />; break;
    case 'bookmarks': page = <BookmarksPage />; break;
    case 'admin': page = <AdminApp />; break;
    default: page = <CatalogPage />;
  }

  return (
    <div className="app-shell">
      <main className="app-main">{page}</main>
      {route.page !== 'admin' && <BottomNav active={route.page} />}
    </div>
  );
}
