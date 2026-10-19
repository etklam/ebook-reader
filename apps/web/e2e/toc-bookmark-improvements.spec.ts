// UI failure/race coverage complements the real-DB TOC/bookmark acceptance.
import { test, expect, type Page } from '@playwright/test';

const W = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const R = '33333333-3333-4333-8333-333333333333';
const B = '44444444-4444-4444-8444-444444444444';
const OLD = '55555555-5555-4555-8555-555555555555';
const metadata = { id: W, title: '長篇目錄測試', author: '作者', workType: 'serial', serialStatus: 'ongoing',
  description: '', visibility: 'public', chapterCount: 5000, firstChapterId: C, latestChapterId: 'chapter-5000',
  releaseId: 'v1', releaseVersion: 1, publishedAt: '2026-10-01T00:00:00Z' };
const chapter = { chapterId: C, workId: W, revisionId: R, labelRaw: '第847章', title: '故事', body: '目前閱讀的正文。',
  previousChapterId: null, nextChapterId: null, paragraphCount: 1, updatedAt: '2026-10-01T00:00:00Z', resources: [] };
const entry = { id: B, workId: W, workTitle: '長篇目錄測試', chapterId: C, chapterLabel: '第847章',
  revisionId: R, paragraphIndex: 0, note: '原備註', createdAt: '2026-10-01T00:00:00Z' };

async function readerMocks(page: Page) {
  await page.route('**/api/me', (route) => route.fulfill({ json: { user: null } }));
  await page.route(`**/api/reader/works/${W}`, (route) => route.fulfill({ json: metadata }));
  await page.route(`**/api/reader/chapters/${C}*`, (route) => route.fulfill({ json: chapter }));
  await page.goto(`/read/${W}/${C}`);
  await expect(page.locator('[data-paragraph-index="0"]')).toBeVisible();
  await page.locator('[data-paragraph-index="0"]').click();
  await page.getByRole('button', { name: '目錄', exact: true }).click();
}

test('TOC at 390px: current anchor, failed page retains rows, stale queries, version reload and keyboard', async ({ page }, testInfo) => {
  let failPage = true;
  let changed = false;
  let firstRequest = '';
  const pending: Array<Promise<unknown>> = [];
  await page.route(`**/api/reader/works/${W}/chapters?*`, async (route) => {
    const params = new URL(route.request().url()).searchParams;
    firstRequest ||= params.get('aroundChapterId') ?? '';
    if (params.has('version') && changed) return route.fulfill({ status: 409, json: { error: 'toc_version_changed' } });
    if (params.get('offset') === '897' && failPage) {
      failPage = false; return route.fulfill({ status: 503, json: { error: 'unavailable' } });
    }
    const q = params.get('q');
    if (q === '舊') {
      pending.push(new Promise((resolve) => setTimeout(resolve, 150)).then(() => route.fulfill({ json: {
        total: 1, offset: 0, version: 'v1', anchorMissing: false, previousOffset: null, nextOffset: null,
        chapters: [{ id: 'stale', labelRaw: '舊查詢', title: '舊', editorialPosition: 1, revisionId: R, volumeId: null }],
      } })).catch(() => undefined));
      return pending.at(-1);
    }
    const latest = params.get('latest') === 'true';
    const after = params.get('offset') === '897';
    await route.fulfill({ json: {
      total: q === '空' ? 0 : 5000, offset: latest ? 4900 : after ? 897 : 797,
      version: changed ? 'v2' : 'v1', anchorMissing: false, previousOffset: 697, nextOffset: latest ? null : after ? 997 : 897,
      chapters: q === '空' ? [] : [{ id: latest ? 'latest' : after ? 'after' : C,
        labelRaw: latest ? '第5000章' : after ? '第898章' : '第847章', title: q === '新' ? '新查詢' : '故事',
        editorialPosition: latest ? 5000 : after ? 898 : 847, revisionId: R, volumeId: null }],
    } });
  });
  await readerMocks(page);
  expect(firstRequest).toBe(C);
  const toc = page.getByRole('navigation', { name: '章節目錄' });
  await expect(toc.locator('[aria-current="true"]')).toContainText('第847章');
  await toc.getByRole('button', { name: /載入後段/ }).click();
  await expect(toc.getByRole('alert')).toContainText('既有清單仍保留');
  await expect(toc.locator('[aria-current="true"]')).toBeVisible();
  await toc.getByRole('button', { name: '重新載入這一段' }).click();
  await expect(toc.getByText('第898章')).toBeVisible();
  const oldQueryStarted = page.waitForRequest((request) => new URL(request.url()).searchParams.get('q') === '舊');
  await toc.getByLabel('搜尋章名或章號').fill('舊');
  await oldQueryStarted;
  await toc.getByLabel('搜尋章名或章號').fill('新');
  await expect(toc.getByText('新查詢')).toBeVisible();
  await Promise.all(pending);
  await expect(toc.getByText('舊查詢')).toHaveCount(0);
  await toc.getByLabel('搜尋章名或章號').fill('空');
  await expect(toc.getByRole('status')).toContainText('找不到');
  await toc.getByRole('button', { name: '清除搜尋' }).click();
  await expect(toc.locator('[aria-current="true"]')).toBeVisible();
  changed = true;
  await toc.getByRole('button', { name: /載入後段/ }).click();
  await expect(toc.getByRole('alert')).toContainText('作品已發布新版本');
  await toc.getByRole('button', { name: '重新載入目錄' }).click();
  await expect(toc.getByRole('alert')).toHaveCount(0);
  await toc.getByRole('button', { name: '前往最新章目錄位置' }).focus();
  await page.keyboard.press('Enter');
  await expect(toc.getByText('第5000章')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/read/${W}/${C}`));
  await page.screenshot({ path: testInfo.outputPath('toc-mobile.png') });
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.screenshot({ path: testInfo.outputPath('toc-desktop.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('bookmarks: retain failed note input, clear/save, remote work choices, paging and delete/undo note', async ({ page }, testInfo) => {
  let note = entry.note;
  let failSave = true;
  let deleted = false;
  let undo: Record<string, unknown> | undefined;
  const patches: unknown[] = [];
  await page.route('**/api/me', (route) => route.fulfill({ json: { user: { id: W, role: 'member' } } }));
  await page.route('**/api/me/follows', (route) => route.fulfill({ json: { follows: [] } }));
  await page.route('**/api/me/bookmarks**', async (route) => {
    const request = route.request();
    if (request.method() === 'PATCH') {
      patches.push(request.postDataJSON());
      if (failSave) { failSave = false; return route.fulfill({ status: 503, json: { error: 'unavailable' } }); }
      note = request.postDataJSON().note;
      return route.fulfill({ json: { ok: true } });
    }
    if (request.method() === 'DELETE') { deleted = true; return route.fulfill({ json: { ok: true } }); }
    if (request.method() === 'POST') { undo = request.postDataJSON(); deleted = false; return route.fulfill({ status: 201, json: { id: B } }); }
    const params = new URL(request.url()).searchParams;
    const older = params.get('workId') === OLD;
    const later = params.get('offset') === '100';
    await route.fulfill({ json: { bookmarks: deleted ? [] : [{ ...entry, id: later ? 'later' : B, note,
      ...(older ? { workId: OLD, workTitle: '原先500筆之外的作品' } : {}) }],
      works: [{ id: W, title: entry.workTitle }, { id: OLD, title: '原先500筆之外的作品' }],
      total: older || deleted ? (deleted ? 0 : 1) : 101, limit: 100, offset: later ? 100 : 0,
      nextOffset: older || later || deleted ? null : 100 } });
  });
  await page.goto('/me/bookmarks');
  const card = page.getByTestId('bookmark-card').first();
  await card.getByRole('button', { name: '編輯備註' }).click();
  const input = page.getByLabel('書籤備註（可留空）');
  await input.fill('伏筆 <b>純文字</b>');
  await page.getByRole('button', { name: '儲存備註' }).click();
  await expect(page.getByRole('alert')).toContainText('輸入仍保留');
  await expect(input).toHaveValue('伏筆 <b>純文字</b>');
  await page.getByRole('button', { name: '儲存備註' }).click();
  await expect(card).toContainText('伏筆 <b>純文字</b>');
  expect(patches).toEqual([{ note: '伏筆 <b>純文字</b>' }, { note: '伏筆 <b>純文字</b>' }]);
  await card.getByRole('button', { name: '編輯備註' }).click();
  await input.fill('');
  await expect(page.getByText('0 / 500 字')).toBeVisible();
  await page.getByRole('button', { name: '儲存備註' }).click();
  await expect(card.getByText('伏筆 <b>純文字</b>')).toHaveCount(0);
  await card.getByRole('button', { name: '編輯備註' }).click();
  await input.fill('x'.repeat(500));
  await expect(input).toHaveAttribute('maxlength', '500');
  await page.screenshot({ path: testInfo.outputPath('bookmark-mobile.png') });
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.screenshot({ path: testInfo.outputPath('bookmark-desktop.png') });
  expect(await input.evaluate((element) => element.getBoundingClientRect().right <= element.closest('.row')!.getBoundingClientRect().right)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '儲存備註' }).click();
  await page.getByRole('button', { name: /載入更多/ }).click();
  await expect(page.getByTestId('bookmark-card')).toHaveCount(2);
  await page.getByLabel('按作品篩選').selectOption(OLD);
  await expect(page.getByTestId('bookmark-card')).toHaveCount(1);
  await expect(card).toContainText('原先500筆之外的作品');
  await card.getByRole('button', { name: '刪除', exact: true }).click();
  await page.getByRole('button', { name: '復原', exact: true }).click();
  await expect(card).toBeVisible();
  expect(undo).toMatchObject({ workId: OLD, chapterId: C, revisionId: R, paragraphIndex: 0, note: 'x'.repeat(500) });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('TOC coalesces a typing burst and clearing search loads immediately', async ({ page }) => {
  const queries: string[] = [];
  await page.route(`**/api/reader/works/${W}/chapters?*`, route => {
    const q = new URL(route.request().url()).searchParams.get('q') ?? '';
    queries.push(q);
    return route.fulfill({ json: { total: 1, offset: 0, version: 'v1', anchorMissing: false,
      previousOffset: null, nextOffset: null,
      chapters: [{ id: C, labelRaw: '第847章', title: q || '故事', editorialPosition: 847, revisionId: R, volumeId: null }],
    } });
  });
  await page.clock.install({ time: new Date('2026-10-19T00:00:00Z') });
  await readerMocks(page);
  await expect(page.getByRole('navigation', { name: '章節目錄' }).getByText('故事')).toBeVisible();
  await page.clock.pauseAt(new Date('2026-10-19T00:01:00Z'));
  const search = page.getByLabel('搜尋章名或章號');
  const initial = queries.length;
  for (const word of ['山', '山川', '山川河', '山川河流']) {
    await search.fill(word); await page.clock.fastForward(40);
  }
  expect(queries.length).toBe(initial);
  await page.clock.fastForward(250);
  await expect.poll(() => queries.slice(initial)).toEqual(['山川河流']);
  expect(queries.at(-1)).toBe('山川河流');
  await page.getByRole('button', { name: '清除搜尋', exact: true }).click();
  await expect.poll(() => queries.slice(initial)).toEqual(['山川河流', '']);
  expect(queries.at(-1)).toBe('');
});
