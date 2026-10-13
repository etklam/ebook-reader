import { test, expect } from '@playwright/test';

const workId = '22222222-2222-4222-8222-222222222222';
const similarId = '33333333-3333-4333-8333-333333333333';
const category = '11111111-1111-4111-8111-111111111111';
for (const width of [390, 1280]) {
  test(`shelf edits and server filters, related works and ranking filters at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    page.on('pageerror', (error) => { throw error; });
    let entry = { workId, title: '書架測試作品', author: '作者', workType: 'serial', serialStatus: 'ongoing',
      readingStatus: 'want', groupName: null as string | null, following: false, lastSeenVersion: null, hasUpdate: false,
      newChapterCount: 0, continueChapterId: null, continueParagraphIndex: null, lastReadAt: null, addedAt: '2026-10-13' };
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith('/api/')) return route.continue();
      let data: unknown = { ok: true };
      if (url.pathname === '/api/me') data = { user: { id: 'member', role: 'member' } };
      else if (url.pathname === '/api/me/follows') data = { follows: [] };
      else if (url.pathname === `/api/me/library/${workId}` && route.request().method() === 'PATCH') {
        entry = { ...entry, ...route.request().postDataJSON() };
      } else if (url.pathname === '/api/me/library') {
        const matches = (!url.searchParams.has('readingStatus') || url.searchParams.get('readingStatus') === entry.readingStatus)
          && (!url.searchParams.has('groupName') || url.searchParams.get('groupName') === (entry.groupName ?? ''));
        data = { works: matches ? [entry] : [], nextCursor: null, limit: 20, groups: entry.groupName ? [entry.groupName] : [] };
      } else if (url.pathname.endsWith('/related')) data = { works: [{ id: similarId, title: '同題材作品', author: '其他作者', workType: 'serial', serialStatus: 'completed', chapterCount: 23, sharedTags: 2, sharedCategories: 1 }] };
      else if (url.pathname === `/api/works/${workId}`) data = { id: workId, title: '書架測試作品', author: '作者', workType: 'serial', serialStatus: 'ongoing', chapterCount: 0, description: '', categories: ['玄幻'], tags: ['冒險'], publishedAt: '2026-10-13', firstChapterId: null };
      else if (url.pathname.endsWith('/chapters')) data = { total: 0, chapters: [], offset: 0, limit: 5 };
      else if (url.pathname.endsWith('/progress')) data = { progress: null };
      else if (url.pathname.endsWith('/state')) data = { inLibrary: true, following: false, newChapterCount: 0 };
      else if (url.pathname === '/api/taxonomy/categories') data = { items: [{ id: category, displayName: '玄幻' }] };
      else if (url.pathname === '/api/rankings') data = { type: 'clicks', period: 'week', days: 7, timezone: 'Asia/Taipei', works: [] };
      await route.fulfill({ json: data });
    });
    await page.goto('/me/library');
    await page.getByRole('button', { name: '整理', exact: true }).click();
    await page.locator('.library-edit').getByLabel('閱讀狀態').selectOption('reading');
    await page.locator('.library-edit').getByLabel('分組').fill('通勤閱讀');
    await page.getByRole('button', { name: '儲存', exact: true }).click();
    await expect(page.getByText('閱讀中 · 通勤閱讀')).toBeVisible();
    await page.locator('.library-filters').getByLabel('分組').selectOption(':通勤閱讀');
    await page.locator('.library-filters').getByLabel('閱讀狀態').selectOption('reading');
    await expect(page.getByRole('button', { name: '書架測試作品', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/ebook-library-${width}.png`, fullPage: true, animations: 'disabled' });
    await page.locator('.library-filters').getByLabel('閱讀狀態').selectOption('finished');
    await expect(page.getByText('沒有符合篩選的作品')).toBeVisible();

    await page.goto(`/works/${workId}`);
    await expect(page.getByRole('heading', { name: '相似作品' })).toBeVisible();
    await expect(page.getByRole('button', { name: /同題材作品/ })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/ebook-related-${width}.png`, fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: /同題材作品/ }).click();
    await expect(page).toHaveURL(new RegExp(`/works/${similarId}$`));

    await page.goto('/rankings');
    await page.getByRole('combobox', { name: '連載狀態', exact: true }).selectOption('completed');
    await page.getByRole('combobox', { name: '分類', exact: true }).selectOption(category);
    await expect(page).toHaveURL(new RegExp(`serialStatus=completed&categoryId=${category}`));
    await page.getByRole('button', { name: '收藏榜', exact: true }).click();
    await expect(page).toHaveURL(/type=favorites.*serialStatus=completed/);
    await page.reload();
    await expect(page.getByRole('combobox', { name: '連載狀態', exact: true })).toHaveValue('completed');
    await expect(page.getByRole('combobox', { name: '分類', exact: true })).toHaveValue(category);
  });
}
