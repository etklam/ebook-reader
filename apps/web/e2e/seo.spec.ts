// Crawlable head per route (SEO §03B, RV-001/RV-003/RV-005).
//
// The head unit tests cover applyHead's own logic; what only a browser can show
// is which HeadInfo each URL actually resolves to. The case that earns this file
// is the fall-through: /anything renders the catalogue so a reader is not
// stranded, and it used to also declare itself canonical — turning every typo
// into another indexable copy of the catalogue.
//
// The catalogue and not-found cases need no API (the catalogue renders its own
// failure state); the work-detail cases mock /api/**, so only
// `pnpm --filter web dev` has to be up.
import { expect, test, type Page } from '@playwright/test';

const workId = '11111111-1111-4111-8111-111111111111';
const publicId = '11111111';

const head = (page: Page) => page.evaluate(() => ({
  title: document.title,
  canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
  robots: document.querySelector('meta[name="robots"]')?.getAttribute('content') ?? null,
  description: document.querySelector('meta[name="description"]')?.getAttribute('content') ?? null,
  ogTitle: document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? null,
  ogType: document.querySelector('meta[property="og:type"]')?.getAttribute('content') ?? null,
  ogLocale: document.querySelector('meta[property="og:locale"]')?.getAttribute('content') ?? null,
  jsonLd: document.querySelector('script[type="application/ld+json"]')?.textContent ?? null,
}));

test('the catalogue is self-canonical and carries a WebSite graph', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.app-footer')).toBeVisible();
  const h = await head(page);
  expect(h.title).toBe('書庫');
  expect(h.canonical).toBe(new URL('/', page.url()).href);
  expect(h.robots).toBeNull();
  expect(h.ogTitle).toBe('書庫');
  const graph = JSON.parse(h.jsonLd!) as { '@type': string; potentialAction?: unknown };
  expect(graph['@type']).toBe('WebSite');
  expect(graph.potentialAction).toBeTruthy();
});

test('/rankings carries its own title, description and canonical', async ({ page }) => {
  await page.goto('/rankings');
  await expect(page.locator('.app-footer')).toBeVisible();
  const h = await head(page);
  expect(h.title).toBe('排行榜 · 書庫');
  expect(h.ogTitle).toBe('排行榜');
  expect(h.canonical).toBe(new URL('/rankings', page.url()).href);
  expect(h.robots).toBeNull();
  expect(h.description).toContain('排行榜');
});

// The regression this file exists for. Each of these renders the catalogue but
// is not the catalogue's URL, so none of them may claim a canonical.
for (const path of ['/rankings/', '/me', '/works/nonsense', '/read/nonsense', '/no-such-page']) {
  test(`${path} renders the catalogue without claiming to be a page of its own`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('.app-footer')).toBeVisible();
    const h = await head(page);
    expect(h.canonical, 'a URL this app never issued must not be canonical').toBeNull();
    expect(h.robots).toBe('noindex, follow');
    expect(h.title).toBe('找不到頁面 · 書庫');
    expect(h.jsonLd, 'no structured data for a page that is not indexed').toBeNull();
  });
}

test('member routes are noindex and have no canonical', async ({ page }) => {
  for (const [path, title] of [['/login', '登入'], ['/me/library', '我的書庫'],
    ['/me/bookmarks', '我的書籤'], ['/me/reading-stats', '閱讀統計']]) {
    await page.goto(path);
    const h = await head(page);
    expect(h.title, path).toBe(`${title} · 書庫`);
    expect(h.robots, path).toBe('noindex, follow');
    expect(h.canonical, path).toBeNull();
  }
});

async function mockWork(page: Page, visibility: 'public' | 'unlisted' | 'missing') {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/me') return route.fulfill({ json: { user: null } });
    if (path.startsWith('/api/works/') && path.endsWith('/related')) return route.fulfill({ json: { works: [] } });
    if (path.startsWith('/api/works/')) {
      if (visibility === 'missing') return route.fulfill({ status: 404, json: { error: 'work_not_found' } });
      return route.fulfill({ json: {
        id: workId, publicId, title: '劍來', author: '烽火戲諸侯', description: '一部測試用的長篇連載簡介。',
        workType: 'serial', serialStatus: 'ongoing', chapterCount: 12, visibility,
        categories: [], tags: [], firstChapterId: null, updatedAt: '2026-10-20T00:00:00Z',
      } });
    }
    if (path.includes('/chapters')) return route.fulfill({ json: { chapters: [], total: 0 } });
    return route.fulfill({ json: {} });
  });
}

test('a public work page gets a Book graph, a canonical slug URL and no robots tag', async ({ page }) => {
  await mockWork(page, 'public');
  await page.goto(`/works/${publicId}`);
  await expect(page.getByRole('heading', { name: '劍來' })).toBeVisible();
  const h = await head(page);
  expect(h.title).toBe('劍來 - 烽火戲諸侯 · 書庫');
  expect(h.ogTitle).toBe('劍來 - 烽火戲諸侯');
  expect(h.ogType).toBe('book');
  expect(h.robots).toBeNull();
  // the address bar and the canonical agree on the slug form
  expect(decodeURIComponent(h.canonical!)).toContain(`/works/劍來-${publicId}`);
  const graph = JSON.parse(h.jsonLd!) as { '@type': string; name: string; author: { name: string } };
  expect(graph['@type']).toBe('Book');
  expect(graph.name).toBe('劍來');
  expect(graph.author.name).toBe('烽火戲諸侯');
});

test('an unlisted work is readable but noindex and has no Book graph', async ({ page }) => {
  await mockWork(page, 'unlisted');
  await page.goto(`/works/${publicId}`);
  await expect(page.getByRole('heading', { name: '劍來' })).toBeVisible();
  const h = await head(page);
  expect(h.robots).toBe('noindex, follow');
  expect(h.jsonLd, 'a Book node is an invitation to index it').toBeNull();
});

test('a work that does not exist does not keep the previous page head', async ({ page }) => {
  await mockWork(page, 'public');
  await page.goto(`/works/${publicId}`);
  await expect(page.getByRole('heading', { name: '劍來' })).toBeVisible();

  await page.unrouteAll();
  await mockWork(page, 'missing');
  await page.goto('/works/22222222');
  await expect(page.getByText('找不到這部作品')).toBeVisible();
  const h = await head(page);
  expect(h.title).toBe('找不到這部作品 · 書庫');
  expect(h.canonical, 'a dead link must not canonicalize to anything').toBeNull();
  expect(h.robots).toBe('noindex, follow');
  expect(h.ogTitle, 'and must not still advertise the book that did load').not.toBe('劍來 - 烽火戲諸侯');
  expect(h.jsonLd).toBeNull();
});

test('the head follows a language switch', async ({ page }) => {
  await mockWork(page, 'public');
  await page.goto(`/works/${publicId}`);
  await expect(page.getByRole('heading', { name: '劍來' })).toBeVisible();
  expect((await head(page)).ogLocale).toBe('zh-Hant');

  await page.locator('.app-footer').getByRole('button', { name: '简体中文' }).click();
  await expect.poll(async () => (await head(page)).ogLocale).toBe('zh-Hans');
  expect((await head(page)).title).toContain('书库');
});
