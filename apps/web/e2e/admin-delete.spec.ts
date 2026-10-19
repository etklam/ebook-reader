import { test, expect, type Page } from '@playwright/test';

const workId = '11111111-1111-4111-8111-111111111111';
const chapterId = '22222222-2222-4222-8222-222222222222';
const nextId = '44444444-4444-4444-8444-444444444444';
const revisionId = '33333333-3333-4333-8333-333333333333';
const work = { id: workId, title: '刪除測試作品', author: '測試作者', description: '測試簡介', serialStatus: 'completed', workType: 'serial', activeReleaseId: 'release' };

async function setup(page: Page) {
  let removedWork = false; let removedChapter = false; let failWork = false;
  const deletes: { path: string; body: string | null }[] = [];
  await page.route('**/api/**', async (route) => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    const rows = [chapterId, nextId].filter((id) => !removedChapter || id !== chapterId).map((id, index) => ({
      id, labelRaw: id === chapterId ? '（一）' : '（二）', title: '標題', editorialPosition: index + 1, revisionId,
    }));
    let json: unknown = {};
    if (req.method() === 'DELETE') {
      deletes.push({ path, body: req.postData() });
      if (path === `/api/admin/works/${workId}`) {
        if (failWork) return route.fulfill({ status: 500, json: { error: 'failed' } });
        removedWork = true;
      } else removedChapter = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === '/api/me') json = { user: { id: 'admin', role: 'admin' } };
    else if (path === '/api/admin/works') json = { works: removedWork ? [] : [work] };
    else if (path.includes('/taxonomy/')) json = { items: [], total: 0 };
    else if (path.endsWith('/taxonomy')) json = { categoryIds: [], tagIds: [], categories: [], tags: [] };
    else if (path.endsWith('/export-versions')) json = { work, versions: [] };
    else if (path.endsWith('/publish-preview')) json = {
      ok: true, workId, valid: true, problems: [], chapterCount: rows.length,
      previousRelease: { id: 'release', version: 1, chapterCount: 2 },
      diff: { newChapterIds: [], updatedChapterIds: [], reorderedChapterIds: [], removedChapterIds: removedChapter ? [chapterId] : [] },
    };
    else if (path.endsWith('/chapters')) json = { work, chapters: rows };
    else if (path.includes('/chapters/')) json = {
      chapterId: path.split('/').at(-1), workId, revisionId, labelRaw: path.endsWith(chapterId) ? '（一）' : '（二）',
      title: '標題', body: '正文第一段。\n\n正文第二段。', updatedAt: '2026-10-17T00:00:00Z', history: [{ revisionId, title: '標題' }],
    };
    await route.fulfill({ json });
  });
  await page.goto(`/admin?tab=publish&work=${workId}`);
  await expect(page.getByRole('button', { name: '刪除作品', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: '刪除本章', exact: true })).toBeEnabled();
  return { deletes, failWork: () => { failWork = true; }, retryWork: () => { failWork = false; } };
}

test('work deletion supports cancellation, failure and retry, then clears the selected workspace', async ({ page }) => {
  const state = await setup(page);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '刪除作品', exact: true }).click();
  expect(state.deletes).toHaveLength(0);
  state.failWork();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '刪除作品', exact: true }).click();
  await expect(page.getByText('刪除失敗。請重新載入作品後再試。')).toBeVisible();
  await expect(page.getByRole('button', { name: '刪除作品', exact: true })).toBeEnabled();
  state.retryWork();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '刪除作品', exact: true }).click();
  await expect(page.getByText('已刪除《刪除測試作品》，讀者已無法開啟。')).toBeVisible();
  await expect(page.getByRole('button', { name: '刪除本章', exact: true })).toHaveCount(0);
  await expect(page).not.toHaveURL(/work=/);
  expect(state.deletes.map((item) => item.path)).toEqual([`/api/admin/works/${workId}`, `/api/admin/works/${workId}`]);
});

test('chapter deletion retains the work, selects the remaining chapter and enables a deletion-only publication', async ({ page }) => {
  const state = await setup(page);
  const publish = page.getByRole('button', { name: '確認發布，讓讀者閱讀', exact: true });
  await expect(publish).toBeDisabled();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: `/tmp/ebook-delete-${width}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '刪除本章', exact: true }).click();
  expect(state.deletes).toHaveLength(0);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '刪除本章', exact: true }).click();
  await expect(page.getByLabel('選擇章節', { exact: true })).toHaveValue(nextId);
  await expect(publish).toBeEnabled();
  await expect(page.getByRole('button', { name: '刪除作品', exact: true })).toBeEnabled();
  expect(state.deletes).toEqual([{
    path: `/api/admin/chapter-editor/works/${workId}/chapters/${chapterId}`,
    body: JSON.stringify({ expectedRevisionId: revisionId }),
  }]);
});
