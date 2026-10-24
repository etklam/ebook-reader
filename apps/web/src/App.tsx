// Top-level routes (hand-rolled, no router dependency):
//   /                                public catalog (M6)
//   /works/<slug>-<publicId>         work detail
//   /read/<slug>-<id>/<slug>-<id>    reader (M5)
//   /login, /register                member auth
//   /me/library, /me/bookmarks       member pages
//   /admin                           import/publish/taxonomy admin (M2–M4 + M6)
//
// Work and chapter segments carry a keyword slug for search engines and resolve
// on the trailing public id alone; a bare uuid still resolves, so every link
// shared before this scheme keeps working (lib/slug.ts).
import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { CatalogPage } from './catalog/CatalogPage.tsx';
import { BottomNav } from './components/BottomNav.tsx';
import { SkeletonLines } from './components/Skeleton.tsx';
import { parseRef } from './lib/slug.ts';
import { applyHead, type HeadInfo } from './lib/head.ts';
import { AppFooter } from './components/AppFooter.tsx';
import { useLocale } from './i18n/I18nRoot.tsx';
import { currentLocale, t } from './i18n/translate.ts';

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
        <p className="form-error" role="alert">{t('頁面載入失敗，請確認網絡後重新載入。')}</p>
        <button className="btn primary" onClick={() => location.reload()}>{t('重新載入')}</button>
      </section>
    );
    return this.props.children;
  }
}

function PageLoading() {
  return <SkeletonLines count={4} label={t('載入頁面中')} />;
}

/** Whatever the URL named the work/chapter: a `<slug>-<publicId>` segment or,
 *  for a link shared before the slug scheme existed, a bare uuid. Resolution
 *  happens on the server; the pages canonicalize the address bar once the real
 *  title is known (lib/slug.ts). */
export interface ReaderRoute { workRef: string; chapterRef: string | null }

// One path segment, non-empty and not a slash. parseRef then decides whether it
// actually carries a key — a segment that does not is no match at all, so
// /works/nonsense falls through to the catalog rather than rendering a
// permanent "not found" for a URL this app never issued.
const SEG = '([^/]+)';

export function parsePath(path: string):
  | { page: 'reader'; route: ReaderRoute }
  | { page: 'work'; workRef: string }
  | { page: 'catalog' }
  | { page: 'rankings' }
  | { page: 'login' }
  | { page: 'register' }
  | { page: 'library' }
  | { page: 'bookmarks' }
  | { page: 'reading-stats' }
  | { page: 'admin' }
  | { page: 'notFound' } {
  let m: RegExpMatchArray | null;
  if ((m = path.match(new RegExp(`^/read/${SEG}(?:/${SEG})?$`))) && parseRef(m[1])) {
    // a chapter segment that carries no key is dropped, not treated as a
    // missing chapter: the reader then opens at the resumed position
    return { page: 'reader', route: { workRef: m[1], chapterRef: m[2] && parseRef(m[2]) ? m[2] : null } };
  }
  if ((m = path.match(new RegExp(`^/works/${SEG}$`))) && parseRef(m[1])) {
    return { page: 'work', workRef: m[1] };
  }
  if (path === '/rankings') return { page: 'rankings' };
  if (path === '/login') return { page: 'login' };
  if (path === '/register') return { page: 'register' };
  if (path === '/me/library') return { page: 'library' };
  if (path === '/me/bookmarks') return { page: 'bookmarks' };
  if (path === '/me/reading-stats') return { page: 'reading-stats' };
  if (path.startsWith('/admin')) return { page: 'admin' };
  if (path === '/') return { page: 'catalog' };
  // Anything else renders the catalogue rather than a dead end (see SEG above),
  // but it is NOT the catalogue's URL. Keeping it a distinct route is what lets
  // staticHead refuse it a canonical and mark it noindex; otherwise every typo
  // becomes another indexable, self-canonical copy of the catalogue.
  return { page: 'notFound' };
}

// Titles and descriptions for the routes that do not depend on fetched data.
// Member and auth routes are noindex: they are personalized or private, and a
// search result for someone else's library page is worth nothing to anyone.
//
// Built per call rather than once at import, so the tab title and the share
// card follow a language switch like the rest of the UI does.
function staticHead(): Partial<Record<ReturnType<typeof parsePath>['page'], HeadInfo>> {
  const origin = typeof location === 'undefined' ? '' : location.origin;
  return {
    catalog: {
      description: t('中文小說閱讀站：長篇連載與短篇，支援繁簡檢視、三種閱讀主題與跨裝置進度同步。'),
      // the catalogue is the site: one WebSite node with the search entry point
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        name: t('書庫'),
        url: `${origin}/`,
        inLanguage: currentLocale(),
        potentialAction: {
          '@type': 'SearchAction',
          target: { '@type': 'EntryPoint', urlTemplate: `${origin}/?q={search_term_string}` },
          'query-input': 'required name=search_term_string',
        },
      },
    },
    rankings: {
      page: t('排行榜'),
      description: t('依點閱與收藏統計的中文小說排行榜，可按連載狀態與分類篩選，提供週、月、年與總榜。'),
    },
    login: { page: t('登入'), noindex: true },
    register: { page: t('註冊'), noindex: true },
    library: { page: t('我的書庫'), noindex: true },
    bookmarks: { page: t('我的書籤'), noindex: true },
    'reading-stats': { page: t('閱讀統計'), noindex: true },
    admin: { page: t('管理'), noindex: true },
    // A path this app never issued. It renders the catalogue so a reader is not
    // stranded (see parsePath), but it must not be indexed as another copy of
    // the catalogue under a URL of its own: no canonical, explicit noindex.
    notFound: { page: t('找不到頁面'), noindex: true },
  };
}

// SPA navigate: pushState + popstate so back/forward behave natively
export function navigate(path: string): void {
  if (location.pathname + location.search + location.hash === path) return;
  history.pushState(null, '', path);
  dispatchEvent(new PopStateEvent('popstate'));
}

export function App() {
  const [loc, setLoc] = useState(location.pathname + location.search + location.hash);
  const { locale } = useLocale();
  useEffect(() => {
    const onPop = () => setLoc(location.pathname + location.search + location.hash);
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  const path = loc.split(/[?#]/)[0];
  const route = parsePath(path);

  // Head for the routes whose title is known from the path alone. /works and
  // /read set theirs after loading, because the title IS the data; they are
  // left untouched here so this does not overwrite them on every re-render.
  useEffect(() => {
    const info = staticHead()[route.page];
    if (info) applyHead({ ...info, canonicalPath: info.noindex ? undefined : path });
  }, [route.page, path, locale]);

  // the reader owns its whole surface; no global chrome there
  if (route.page === 'reader') {
    const ref = parseRef(route.route.workRef)!;
    // public_id is generated from the first eight UUID hex characters.
    const workKey = 'uuid' in ref ? ref.uuid.slice(0, 8) : ref.publicId;
    return <PageBoundary key={route.page}><Suspense fallback={<main className="app-main"><PageLoading /></main>}>
      <ReaderPage key={workKey} workRef={route.route.workRef} initialChapterRef={route.route.chapterRef} initialHash={loc.includes('#') ? loc.slice(loc.indexOf('#')) : ''} />
    </Suspense></PageBoundary>;
  }

  // admin owns its own <main> and has no bottom nav
  if (route.page === 'admin') {
    return (
      <div className="app-shell">
        <PageBoundary key={route.page}>
          <Suspense fallback={<main className="app-main admin-shell"><PageLoading /></main>}><AdminApp /></Suspense>
        </PageBoundary>
      </div>
    );
  }

  let page: React.ReactNode;
  switch (route.page) {
    case 'rankings': page = <RankingsPage />; break;
    case 'work': page = <WorkDetailPage key={route.workRef} workRef={route.workRef} />; break;
    case 'login': page = <LoginPage />; break;
    case 'register': page = <RegistrationPage />; break;
    case 'library': page = <LibraryPage />; break;
    case 'bookmarks': page = <BookmarksPage />; break;
    case 'reading-stats': page = <ReadingStatsPage />; break;
    default: page = <CatalogPage />;
  }

  return (
    <div className="app-shell">
      <main className="app-main">
        <PageBoundary key={route.page}><Suspense fallback={<PageLoading />}>{page}</Suspense></PageBoundary>
        <AppFooter />
      </main>
      <BottomNav active={route.page} />
    </div>
  );
}
