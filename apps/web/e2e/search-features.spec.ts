import { test, expect, type Page } from '@playwright/test';

const workId = '00000000-0000-0000-0000-000000000001';
const first = '00000000-0000-0000-0000-000000000003';
const second = '00000000-0000-0000-0000-000000000004';
const revision = (id: string) => id === first ? '00000000-0000-0000-0000-000000000006' : '00000000-0000-0000-0000-000000000007';

async function mockReader(page: Page, member = false) {
  const chapterRequests: string[] = [];
  const readMarks: string[] = [];
  const searchRequests: URL[] = [];
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let json: unknown = {};
    if (url.pathname === '/api/me') json = { user: member ? { id: 'member', username: '讀者', role: 'member' } : null };
    else if (url.pathname.startsWith('/api/me/progress/')) json = { progress: null };
    else if (url.pathname === '/api/me/preferences') json = { preferences: null };
    else if (url.pathname === '/api/me/reads') {
      readMarks.push(route.request().postDataJSON().chapterId);
      json = { ok: true };
    } else if (url.pathname === `/api/reader/works/${workId}`) json = {
      id: workId, title: '搜尋測試', author: '作者', workType: 'serial', serialStatus: 'ongoing',
      description: '', visibility: 'public', chapterCount: 2, firstChapterId: first,
      latestChapterId: second, releaseId: 'release', releaseVersion: 1, publishedAt: '2026-01-01',
    };
    else if (url.pathname === `/api/reader/works/${workId}/chapters`) json = {
      total: 2, limit: 100, offset: 0, chapters: [first, second].map((id, i) => ({
        id, labelRaw: `第${i + 1}章`, title: '', editorialPosition: i, revisionId: revision(id), volumeId: null,
      })),
    };
    else if (url.pathname.startsWith('/api/reader/chapters/')) {
      const id = url.pathname.split('/').at(-1)!;
      chapterRequests.push(id);
      json = {
        chapterId: id, workId, revisionId: revision(id), labelRaw: id === first ? '第1章' : '第2章', title: '',
        body: Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 段。${'小說正文，慢慢閱讀。'.repeat(12)}`).join('\n\n'),
        previousChapterId: id === first ? null : first, nextChapterId: id === first ? second : null,
        paragraphCount: 40, updatedAt: '2026-01-01', resources: [],
      };
    } else if (url.pathname.endsWith('/search')) {
      searchRequests.push(url);
      const query = url.searchParams.get('q')!;
      if (query === '失敗') return route.fulfill({ status: 500, json: { error: 'failed' } });
      if (query === '空白') json = { query, total: null, offset: 0, nextCursor: null, hasMore: false, results: [] };
      else {
        const offset = url.searchParams.get('cursor') ? 50 : 0;
        json = { query, total: null, offset, nextCursor: offset === 0 ? 'next-page' : null, hasMore: offset === 0, results: [{
          chapterId: second, title: offset === 0 ? '首批結果' : '末批結果', labelRaw: '第2章',
          snippet: `找到 ${query}`, matchStart: 3, matchLength: query.length, paragraphIndex: 20,
          href: `/read/${workId}/${second}#p=20&rev=${revision(second)}`,
        }] };
      }
    }
    await route.fulfill({ json });
  });
  return { chapterRequests, readMarks, searchRequests };
}

async function openSearch(page: Page) {
  await page.goto(`/read/${workId}/${first}`);
  await expect(page.locator('.reader-chapter-label')).toHaveText(/第1章/);
  await page.mouse.click(195, 422);
  await page.getByRole('button', { name: '目錄', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
}

test('book search encodes literal input, pages both ways and jumps to the matching paragraph', async ({ page }) => {
  const { searchRequests } = await mockReader(page);
  await openSearch(page);
  const query = '小龍 & 100% + ?';
  await page.getByRole('searchbox', { name: '搜尋本書內容' }).fill(query);
  await page.getByRole('button', { name: '搜尋', exact: true }).click();
  await expect(page.getByRole('link', { name: /首批結果/ })).toBeVisible();
  expect(searchRequests[0].searchParams.get('q')).toBe(query);
  await page.getByRole('button', { name: '下一頁', exact: true }).click();
  await expect(page.getByRole('link', { name: /末批結果/ })).toBeVisible();
  expect(searchRequests.at(-1)!.searchParams.get('cursor')).toBe('next-page');
  await expect(page.getByRole('button', { name: '下一頁', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '上一頁', exact: true }).click();
  await expect(page.getByRole('link', { name: /首批結果/ })).toBeVisible();
  expect(searchRequests.at(-1)!.searchParams.get('cursor')).toBeNull();
  await page.getByRole('link', { name: /首批結果/ }).click();
  await expect(page.locator('.reader-chapter-label')).toHaveText(/第2章/);
  await expect(page.getByRole('dialog', { name: /目錄/ })).toHaveCount(0);
  await expect.poll(() => page.locator('.reader-scroll').evaluate((container) => {
    const target = document.querySelector('[data-paragraph-index="20"]')!;
    const viewport = container.getBoundingClientRect();
    const paragraph = target.getBoundingClientRect();
    return paragraph.bottom > viewport.top && paragraph.top < viewport.bottom;
  })).toBe(true);
  await expect(page).toHaveURL(new RegExp(`/read/${workId}/${second}$`));
});

test('book search presents empty and error states, and editing clears stale results', async ({ page }) => {
  await mockReader(page);
  await openSearch(page);
  const input = page.getByRole('searchbox', { name: '搜尋本書內容' });
  await input.fill('空白');
  await page.getByRole('button', { name: '搜尋', exact: true }).click();
  await expect(page.getByText('沒有找到相符章節。')).toBeVisible();
  await input.fill('失敗');
  await page.getByRole('button', { name: '搜尋', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('搜尋失敗，請稍後再試。');
  await input.fill('小龍');
  await page.getByRole('button', { name: '搜尋', exact: true }).click();
  await expect(page.getByRole('link', { name: /首批結果/ })).toBeVisible();
  await input.fill('新內容');
  await expect(page.getByRole('link', { name: /首批結果/ })).toHaveCount(0);
});

test('next chapter preload is consumed once and cannot mark an unread chapter read', async ({ page }) => {
  await page.clock.install();
  const { chapterRequests, readMarks } = await mockReader(page, true);
  await page.goto(`/read/${workId}/${first}`);
  await expect(page.locator('.reader-chapter-label')).toHaveText(/第1章/);
  await expect.poll(() => chapterRequests).toEqual([first]);
  await page.clock.runFor(31_000);
  await expect.poll(() => readMarks).toEqual([first]);
  expect(chapterRequests).toEqual([first]);
  await page.locator('.reader-scroll').evaluate((element) => { element.scrollTop = element.scrollHeight * 0.85; });
  await page.clock.runFor(200);
  await expect.poll(() => chapterRequests).toEqual([first, second]);
  await page.mouse.click(195, 422);
  await page.getByRole('button', { name: '下一章', exact: true }).click();
  await expect(page.locator('.reader-chapter-label')).toHaveText(/第2章/);
  await expect(page.getByRole('dialog', { name: /目錄/ })).toHaveCount(0);
  expect(chapterRequests).toEqual([first, second]);
  expect(readMarks).toEqual([first]);
  await page.clock.runFor(10_100);
  await expect.poll(() => readMarks).toEqual([first, second]);
});
