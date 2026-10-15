// ER-005/006 browser interactions; API predicate/ownership is covered by L2.
import { test, expect, type Page } from '@playwright/test';
const tag = '11111111-2222-3333-4444-555555555555';
const otherTag = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const work = (id: string) => ({ id, title: `作品 ${id}`, author: '作者', workType: 'serial', serialStatus: 'ongoing', chapterCount: 3, latestPublishedAt: '2026-10-15T00:00:00Z', categories: [], tags: [] });
async function mockCatalog(page: Page, member: () => string | null = () => null) {
  await page.route('http://localhost:5173/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/me') return route.fulfill({ json: { user: member() ? { id: member(), role: 'member' } : null } });
    if (url.pathname === '/api/taxonomy/tags') return route.fulfill({ json: { items: [{ id: tag, displayName: '系統' }, { id: otherTag, displayName: '玄幻' }] } });
    if (url.pathname === '/api/taxonomy/categories') return route.fulfill({ json: { items: [] } });
    if (url.pathname === '/api/works/count') return route.fulfill({ json: { count: url.searchParams.has('excludeTagIds') ? 0 : 1 } });
    if (url.pathname === '/api/works') return route.fulfill({ json: { total: null, limit: 20, nextCursor: null, works: url.searchParams.has('excludeTagIds') ? [] : [work(member() ?? 'guest')] } });
    return route.fulfill({ json: { count: 0, works: [], groups: [] } });
  });
}
test('ER-005 tag roles remain exclusive, explain switching, restore URL and retain removable empty conditions', async ({ page }) => {
  await mockCatalog(page);
  await page.goto('/');
  await expect(page.getByTestId('work-card')).toHaveCount(1);
  await page.getByRole('button', { name: '篩選', exact: true }).click();
  const sheet = page.getByTestId('filter-sheet');
  await sheet.getByRole('button', { name: '系統：不篩選，改為包含' }).click();
  await expect(sheet.getByRole('button', { name: '系統：包含，改為排除' })).toHaveText('✓ 系統（包含）');
  await sheet.getByRole('button', { name: '系統：包含，改為排除' }).click();
  await expect(sheet.getByRole('status')).toContainText('系統：已由包含改為排除');
  await sheet.getByRole('button', { name: '玄幻：不篩選，改為包含' }).click();
  await sheet.getByRole('button', { name: '套用', exact: true }).click();
  const params = new URL(page.url()).searchParams;
  expect(params.get('tagIds')).toBe(otherTag);
  expect(params.get('excludeTagIds')).toBe(tag);
  await expect(page.getByTestId('catalog-empty')).toBeVisible();
  await expect(page.getByRole('button', { name: '移除條件：排除 #系統' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '移除條件：排除 #系統' })).toBeVisible();
  await page.getByRole('button', { name: '移除條件：排除 #系統' }).click();
  await expect(page.getByTestId('work-card')).toHaveCount(1);
  expect(new URL(page.url()).searchParams.has('excludeTagIds')).toBe(false);
});
test('ER-006 guest sees login prompt and can remove a restored private condition', async ({ page }) => {
  await mockCatalog(page);
  await page.goto('/?hideFinished=true');
  await expect(page.getByRole('heading', { name: '登入後才能隱藏已讀' })).toBeVisible();
  await expect(page.getByTestId('work-card')).toHaveCount(0);
  await page.getByRole('button', { name: /篩選/ }).click();
  await expect(page.getByRole('checkbox', { name: '隱藏已讀' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '登入後使用' })).toBeVisible();
  await page.getByRole('button', { name: '套用', exact: true }).click();
  await page.getByRole('button', { name: '移除條件：隱藏已讀' }).click();
  await expect(page.getByTestId('work-card')).toHaveCount(1);
});
test('ER-006 member toggle persists; account changes reset results/count/cursor and discard an old in-flight page', async ({ page }) => {
  let member: string | null = 'member-a';
  await mockCatalog(page, () => member);
  let releaseOld: (() => void) | undefined;
  let oldRequested: (() => void) | undefined;
  const oldStarted = new Promise<void>((resolve) => { oldRequested = resolve; });
  const oldReleased = new Promise<void>((resolve) => { releaseOld = resolve; });
  const seen: URL[] = [];
  await page.route('**/api/works?**', async (route) => {
    const url = new URL(route.request().url());
    seen.push(url);
    if (url.searchParams.has('cursor')) {
      oldRequested?.();
      await oldReleased;
      return route.fulfill({ json: { total: null, limit: 20, nextCursor: null, works: [work('old-page-a')] } });
    }
    return route.fulfill({ json: { total: null, limit: 20, nextCursor: member === 'member-a' ? 'cursor-a' : null, works: [work(member ?? 'guest')] } });
  });
  await page.goto('/');
  await expect(page.getByTestId('work-card')).toContainText('作品 member-a');
  await page.getByRole('button', { name: '篩選', exact: true }).click();
  await page.getByRole('checkbox', { name: '隱藏已讀' }).check();
  await page.getByRole('button', { name: '套用', exact: true }).click();
  await expect(page).toHaveURL(/hideFinished=true/);
  await expect(page.getByRole('button', { name: /載入更多/ })).toBeVisible();
  await page.getByRole('button', { name: /載入更多/ }).click();
  await oldStarted;
  member = 'member-b';
  await page.evaluate("import('/src/account/useMe.ts').then(m => m.refreshMe())");
  await expect(page.getByTestId('work-card')).toHaveCount(1);
  await expect(page.getByTestId('work-card')).toContainText('作品 member-b');
  expect(seen.at(-1)?.searchParams.has('cursor')).toBe(false);
  const oldResponse = page.waitForResponse((res) => new URL(res.url()).searchParams.get('cursor') === 'cursor-a');
  releaseOld?.();
  await oldResponse;
  await expect(page.getByTestId('work-card')).toHaveCount(1);
  member = null;
  await page.evaluate("import('/src/account/useMe.ts').then(m => m.refreshMe())");
  await expect(page.getByRole('heading', { name: '登入後才能隱藏已讀' })).toBeVisible();
  await expect(page.getByTestId('work-card')).toHaveCount(0);
});
