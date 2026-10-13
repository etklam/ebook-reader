import { test, expect } from '@playwright/test';

const workId = '22222222-2222-4222-8222-222222222222';
const chapterId = '33333333-3333-4333-8333-333333333333';
const revisionId = '44444444-4444-4444-8444-444444444444';
const reportId = '55555555-5555-4555-8555-555555555555';
for (const width of [390, 1280]) {
  test(`reader submits exact paragraph and admin resolves report at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    page.on('pageerror', (error) => { throw error; });
    let submitted: Record<string, unknown> | null = null;
    let admin = false;
    let resolved = false;
    const body = '第一段原文\n\n第二段錯字\n\n第三段原文';
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      if (!url.pathname.startsWith('/api/')) return route.continue();
      let data: unknown = { ok: true };
      if (url.pathname === '/api/me') data = { user: { id: 'reader', role: admin ? 'admin' : 'member' } };
      else if (url.pathname.startsWith('/api/me/progress/')) data = { progress: null, syncVersion: 1 };
      else if (url.pathname === '/api/me/reader-preferences') data = { preferences: null };
      else if (url.pathname === '/api/me/follows') data = { follows: [] };
      else if (url.pathname === '/api/me/content-reports') submitted = route.request().postDataJSON();
      else if (url.pathname === `/api/reader/works/${workId}`) data = { id: workId, title: '錯字回報測試', author: '作者', workType: 'serial', serialStatus: 'ongoing', description: '', visibility: 'public', chapterCount: 1, firstChapterId: chapterId, latestChapterId: chapterId, releaseId: 'release', releaseVersion: 1 };
      else if (url.pathname === `/api/reader/chapters/${chapterId}`) data = { workId, chapterId, revisionId, title: '第一章', labelRaw: '第1章', body, paragraphCount: 3, previousChapterId: null, nextChapterId: null, updatedAt: '2026-10-13', resources: [] };
      else if (url.pathname === '/api/admin/content-reports') data = { reports: resolved ? [] : [{ id: reportId, workId, chapterId, revisionId, paragraphIndex: 1, excerpt: '第二段錯字', message: '錯字應修正', workTitle: '錯字回報測試', chapterTitle: '第一章', status: 'open', createdAt: '2026-10-13', resolvedAt: null }] };
      else if (url.pathname === `/api/admin/content-reports/${reportId}`) resolved = true;
      else if (url.pathname === '/api/admin/works') data = { works: [{ id: workId, title: '錯字回報測試', author: '作者', activeReleaseId: 'release' }] };
      else if (url.pathname === `/api/admin/chapter-editor/works/${workId}/chapters`) data = { chapters: [{ id: chapterId, title: '第一章', labelRaw: '第1章', editorialPosition: 1, revisionId }] };
      else if (url.pathname === `/api/admin/chapter-editor/works/${workId}/chapters/${chapterId}`) data = { workId, chapterId, revisionId, title: '第一章', labelRaw: '第1章', body, history: [], updatedAt: '2026-10-13' };
      else if (url.pathname.startsWith('/api/admin/')) return route.fulfill({ status: 500, json: { error: 'test_unavailable' } });
      await route.fulfill({ json: data });
    });
    await page.goto(`/read/${workId}/${chapterId}`);
    await expect(page.locator('.reader-chapter-label')).toHaveText(/第1章/);
    await page.mouse.click(width / 2, 422);
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await page.getByRole('button', { name: '回報錯字', exact: true }).click();
    await page.getByLabel('回報段落').fill('2');
    await expect(page.locator('.typo-report blockquote')).toHaveText('第二段錯字');
    await page.getByLabel('錯字或建議修正').fill('錯字應修正');
    await page.screenshot({ path: `/tmp/ebook-report-${width}.png`, fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '送出回報', exact: true }).click();
    await expect(page.getByText('已送出回報，謝謝你的協助。')).toBeVisible();
    expect(submitted).toEqual({ workId, chapterId, revisionId, paragraphIndex: 1, message: '錯字應修正' });

    admin = true;
    await page.goto('/admin?tab=reports');
    await expect(page.locator('.content-report blockquote')).toHaveText('第二段錯字');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/ebook-admin-reports-${width}.png`, fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '前往章節編輯' }).click();
    await expect(page.locator('#chapter-editor-select')).toHaveValue(chapterId);
    await expect(page.locator('#chapter-editor-body')).toHaveValue(body);
    await expect.poll(() => page.locator('#chapter-editor-body').evaluate((element: HTMLTextAreaElement) => element.value.slice(element.selectionStart, element.selectionEnd))).toBe('第二段錯字');
    await page.getByRole('tab', { name: '錯字回報' }).click();
    await page.getByRole('button', { name: '標記已處理', exact: true }).click();
    await expect(page.getByText('暫無待處理回報。')).toBeVisible();
    expect(resolved).toBe(true);
  });
}
