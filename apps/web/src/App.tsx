// Top-level routes (hand-rolled, no router dependency):
//   /                        public catalog (M6)
//   /works/:workId           work detail
//   /read/:workId/:chapterId reader (M5)
//   /login, /register        member auth
//   /me/library, /me/bookmarks member pages
//   /admin                   import/publish/taxonomy admin (M2–M4 + M6)
import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { CatalogPage } from './catalog/CatalogPage.tsx';
import { BottomNav } from './components/BottomNav.tsx';
import { SkeletonLines } from './components/Skeleton.tsx';

const AdminApp = lazy(() => import('./admin/AdminApp.tsx').then((module) => ({ default: module.AdminApp })));
const ReaderPage = lazy(() => import('./reader/ReaderPage.tsx').then((module) => ({ default: module.ReaderPage })));
const RankingsPage = lazy(() => import('./catalog/RankingsPage.tsx').then((module) => ({ default: module.RankingsPage })));
const WorkDetailPage = lazy(() => import('./catalog/WorkDetailPage.tsx').then((module) => ({ default: module.WorkDetailPage })));
const LoginPage = lazy(() => import('./account/LoginPage.tsx').then((module) => ({ default: module.LoginPage })));
const RegistrationPage = lazy(() => import('./account/RegistrationPage.tsx').then((module) => ({ default: module.RegistrationPage })));
const LibraryPage = lazy(() => import('./account/LibraryPage.tsx').then((module) => ({ default: module.LibraryPage })));
const BookmarksPage = lazy(() => import('./account/BookmarksPage.tsx').then((module) => ({ default: module.BookmarksPage })));
const ReadingStatsPage = lazy(() => import('./account/ReadingStatsPage.tsx').then((module) => ({ default: module.ReadingStatsPage })));

class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return (
      <section className="app-main">
        <p className="form-error" role="alert">頁面載入失敗，請確認網絡後重新載入。</p>
        <button className="btn primary" onClick={() => location.reload()}>重新載入</button>
      </section>
    );
    return this.props.children;
  }
}

function PageLoading() {
  return <SkeletonLines count={4} label="載入頁面中" />;
}

export interface ReaderRoute { workId: string; chapterId: string | null }

const UUID = '([0-9a-f-]{36})';

export function parsePath(path: string):
  | { page: 'reader'; route: ReaderRoute }
  | { page: 'work'; workId: string }
  | { page: 'catalog' }
  | { page: 'rankings' }
  | { page: 'login' }
  | { page: 'register' }
  | { page: 'library' }
  | { page: 'bookmarks' }
  | { page: 'reading-stats' }
  | { page: 'admin' } {
  let m: RegExpMatchArray | null;
  if ((m = path.match(new RegExp(`^/read/${UUID}(?:/(${UUID}))?$`)))) {
    return { page: 'reader', route: { workId: m[1], chapterId: m[2] ?? null } };
  }
  if ((m = path.match(new RegExp(`^/works/${UUID}$`)))) return { page: 'work', workId: m[1] };
  if (path === '/rankings') return { page: 'rankings' };
  if (path === '/login') return { page: 'login' };
  if (path === '/register') return { page: 'register' };
  if (path === '/me/library') return { page: 'library' };
  if (path === '/me/bookmarks') return { page: 'bookmarks' };
  if (path === '/me/reading-stats') return { page: 'reading-stats' };
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
    return <PageBoundary key={route.page}><Suspense fallback={<main className="app-main"><PageLoading /></main>}>
      <ReaderPage key={route.route.workId} workId={route.route.workId} initialChapterId={route.route.chapterId} />
    </Suspense></PageBoundary>;
  }

  // admin owns its own <main> and has no bottom nav
  if (route.page === 'admin') {
    return <div className="app-shell"><PageBoundary key={route.page}><Suspense fallback={<main className="app-main admin-shell"><PageLoading /></main>}><AdminApp /></Suspense></PageBoundary></div>;
  }

  let page: React.ReactNode;
  switch (route.page) {
    case 'rankings': page = <RankingsPage />; break;
    case 'work': page = <WorkDetailPage key={route.workId} workId={route.workId} />; break;
    case 'login': page = <LoginPage />; break;
    case 'register': page = <RegistrationPage />; break;
    case 'library': page = <LibraryPage />; break;
    case 'bookmarks': page = <BookmarksPage />; break;
    case 'reading-stats': page = <ReadingStatsPage />; break;
    default: page = <CatalogPage />;
  }

  return (
    <div className="app-shell">
      <main className="app-main"><PageBoundary key={route.page}><Suspense fallback={<PageLoading />}>{page}</Suspense></PageBoundary></main>
      <BottomNav active={route.page} />
    </div>
  );
}
