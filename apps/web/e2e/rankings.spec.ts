import { test, expect } from '@playwright/test';

for (const width of [390, 1280]) {
  test(`rankings switch types and all periods at ${width}px`, async ({ page }) => {
    page.on('pageerror', (error) => { throw error; });
    await page.setViewportSize({ width, height: 844 });
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith('/api/')) return route.continue();
      if (url.pathname === '/api/rankings') {
        const type = url.searchParams.get('type');
        const period = url.searchParams.get('period');
        await route.fulfill({ json: { type, period, days: period === 'all' ? null : 7,
          timezone: 'Asia/Taipei', works: [{ id: 'work', title: '排行測試作品', author: '作者',
            workType: 'serial', serialStatus: 'ongoing', chapterCount: 100,
            clicks: type === 'clicks' ? 12 : 0, favorites: type === 'favorites' ? 7 : 0 }] } });
      } else if (url.pathname.startsWith('/api/taxonomy/')) await route.fulfill({ json: { items: [] } });
      else await route.fulfill({ json: { user: null } });
    });
    await page.goto('/rankings?type=favorites&period=all');
    await expect(page.getByRole('button', { name: '收藏榜', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: '總榜', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.row-count')).toHaveText('7');
    for (const type of ['點擊榜', '收藏榜']) {
      await page.getByRole('button', { name: type, exact: true }).click();
      for (const [label, period] of [['周榜', 'week'], ['月榜', 'month'], ['年榜', 'year'], ['總榜', 'all']]) {
        await page.getByRole('button', { name: label, exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`type=${type === '收藏榜' ? 'favorites' : 'clicks'}&period=${period}`));
        await expect(page.locator('.row-count')).toHaveText(type === '收藏榜' ? '7' : '12');
      }
    }
    await page.reload();
    await expect(page.locator('.row-count')).toHaveText('7');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/ebook-rankings-${width}.png`, fullPage: true, animations: 'disabled' });
  });
}

test('rankings show request failure, retry and favorite empty state', async ({ page }) => {
  let failed = true;
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/rankings') {
      if (failed) await route.fulfill({ status: 500, json: { error: 'unavailable' } });
      else await route.fulfill({ json: { type: 'favorites', period: 'week', days: 7, timezone: 'Asia/Taipei', works: [] } });
    } else if (url.pathname.startsWith('/api/taxonomy/')) await route.fulfill({ json: { items: [] } });
    else await route.fulfill({ json: { user: null } });
  });
  await page.goto('/rankings?type=favorites');
  await expect(page.getByText('排行榜暫時載不出來')).toBeVisible();
  failed = false;
  await page.getByRole('button', { name: '重試', exact: true }).click();
  await expect(page.getByText('這段期間尚未有收藏紀錄')).toBeVisible();
});
