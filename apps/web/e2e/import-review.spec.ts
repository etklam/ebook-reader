import { test, expect, type Page } from '@playwright/test';
const id = '00000000-0000-0000-0000-000000000201';
const work = '00000000-0000-0000-0000-000000000202';
const source = '00000000-0000-0000-0000-000000000203';
const site = '00000000-0000-0000-0000-000000000204';
const imageHash = 'a'.repeat(64);
const summary = { added: 1, updated: 0, unchanged: 1, modifiedKept: 1, skipped: 1, missingKept: 1 };

async function setup(page: Page, stale = false) {
  const submissions: Array<{ key: string | undefined; payload: string | null }> = [];
  const details: string[] = [];
  let applied = false; let editVersion = 4;
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url()); const path = url.pathname;
    if (!path.startsWith('/api/')) return route.continue();
    let json: unknown = {};
    if (path.startsWith('/api/admin/taxonomy/')) json = { items: [] };
    else if (path === '/api/me') json = { user: { id: 'admin', role: 'admin', isMember: true } };
    else if (path === '/api/admin/imports' && route.request().method() === 'POST') return route.fulfill({ status: 201, json: { importId: id, sourceFileId: 'source-file' } });
    else if (path === `/api/admin/imports/${id}`) json = { id, workId: work, status: applied ? 'applied' : 'ready', detectedEncoding: 'utf-8', chapterCount: 4, encodingResult: { confidence: 'high', reason: 'UTF-8', warnings: [] }, stagedChapters: 4, stagedNeedsReview: 0, committedWorkId: null, sourceFile: null };
    else if (path.endsWith('/chapters')) json = { total: 0, page: 1, limit: 50, chapters: [] };
    else if (path.endsWith('/quality')) json = { total: 4, issueCount: 0, counts: { empty: 0, duplicates: 0, gaps: 0 }, issues: [] };
    else if (path.endsWith('/review')) {
      const rows = [
        { kind: 'source', itemId: 'same', itemClass: 'unchanged', labelRaw: '第1章', matchedChapterId: site, matchedLabel: '第1章' },
        { kind: 'source', itemId: 'modified', itemClass: 'modified', labelRaw: '第2章', matchedChapterId: site, matchedLabel: '第2章' },
        { kind: 'source', itemId: 'new', itemClass: 'new', labelRaw: '第2.5章', positionConfident: true, insertAfterChapterId: site, afterLabel: '第2章', insertBeforeChapterId: site, beforeLabel: '第3章' },
        { kind: 'source', itemId: source, itemClass: 'ambiguous', labelRaw: '第3章（來源重複）', positionConfident: false, reason: ['duplicate_label_key'] },
        { kind: 'missing', chapterId: site, itemClass: 'missing', labelRaw: '番外篇' },
      ];
      const filtered = url.searchParams.get('filter') === 'pending' ? rows.filter((row) => row.itemClass === 'ambiguous') : rows;
      json = { editVersion, analysisVersion: `analysis-${editVersion}`, workId: work, total: filtered.length, page: 1, limit: 40, pendingCount: 1, counts: { unchanged: 1, modified: 1, new: 1, ambiguous: 1, structural_conflict: 0, missing: 1 }, rows: filtered };
    } else if (path.endsWith('/review/detail')) {
      details.push(url.searchParams.get('itemId') ?? '');
      const body = { title: '內容核對', total: 50, hasMore: false, resources: [{ content_hash: imageHash, alt: '插圖說明' }] };
      json = { offset: 0, source: { ...body, text: `來源修訂文字。\n\n[[img:${imageHash}]]\n\n來源第二段。` }, site: { ...body, text: '站方保留文字。\n\n站方第二段。' } };
    } else if (path.endsWith('/review-plan')) json = { ok: true, summary };
    else if (path.endsWith('/apply')) {
      submissions.push({ key: route.request().headers()['idempotency-key'], payload: route.request().postData() });
      if (stale) return route.fulfill({ status: 409, json: { error: 'edit_version_conflict' } });
      if (submissions.length === 1) return route.abort('failed');
      applied = true; json = { workId: work, newEditVersion: 5, summary, alreadyApplied: false };
    }
    await route.fulfill({ json });
  });
  await page.goto('/admin');
  await page.getByText('進階匯入設定（更新既有作品／指定編碼）', { exact: true }).click();
  await page.getByLabel('目標作品 ID').fill(work);
  await page.getByLabel('或貼上 TXT 內容').fill('第1章\n\n來源文字');
  await page.getByRole('button', { name: '提交並解析', exact: true }).click();
  const review = page.getByRole('region', { name: '逐章匯入比對' });
  await expect(review.getByText(/尚有 1 項待決/)).toBeVisible();
  return { review, submissions, details, advanceVersion: () => { editVersion++; } };
}
async function resolveAndPreview(page: Page) {
  const review = page.getByRole('region', { name: '逐章匯入比對' });
  await review.getByRole('button', { name: '檢視待決項目（1）' }).click();
  await review.getByRole('button', { name: /第3章（來源重複）.*展開核對/ }).click();
  await review.getByRole('combobox', { name: '決策', exact: true }).selectOption('exclude');
  await expect(review.getByText(/尚有 0 項待決/)).toBeVisible();
  await expect(review.getByText('來源修訂文字。', { exact: false }).first()).toBeVisible();
  await expect(review.getByText('〔圖片 aaaaaaaaaaaa〕', { exact: false })).toBeVisible();
  await review.getByRole('button', { name: '核對實際套用數量' }).click();
  await expect(review.getByRole('status')).toHaveText(/實際方案：新增 1、更新 0.*排除 1.*保留來源缺失 1/);
  await review.getByLabel('我已核對逐章變更、插入位置與排除清單').check();
  return review;
}

test('review loads bodies on demand, resolves before apply, retries same operation, and fits phone/desktop', async ({ page }) => {
  const { review, submissions, details } = await setup(page);
  expect(details).toEqual([]);
  await expect(review.getByRole('button', { name: '套用增量方案' })).toBeDisabled();
  await resolveAndPreview(page);
  expect(details).toEqual([source]);
  await page.setViewportSize({ width: 390, height: 844 });
  await review.screenshot({ path: '/tmp/ebook-import-review-390.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await review.screenshot({ path: '/tmp/ebook-import-review-1280.png' });
  await review.getByRole('button', { name: '套用增量方案' }).click();
  await expect(review.getByRole('alert')).toHaveText(/網絡連線失敗/);
  await review.getByRole('button', { name: '套用增量方案' }).click();
  await expect(page.getByText(/已套用（增量）/)).toBeVisible();
  expect(submissions).toHaveLength(2); expect(submissions[0].key).toBeTruthy(); expect(submissions[1]).toEqual(submissions[0]);
});

test('stale edit version blocks reviewed decisions until a new comparison and review', async ({ page }) => {
  const { review, advanceVersion } = await setup(page, true);
  await resolveAndPreview(page);
  await review.getByRole('button', { name: '套用增量方案' }).click();
  await expect(review.getByRole('alert')).toHaveText(/作品或分析版本已改變.*重新比對/);
  await expect(review.getByRole('button', { name: '套用增量方案' })).toBeDisabled();
  advanceVersion(); await review.getByRole('button', { name: '重新比對', exact: true }).click();
  await expect(review.getByText(/尚有 1 項待決/)).toBeVisible();
  await expect(review.getByLabel('我已核對逐章變更、插入位置與排除清單')).not.toBeChecked();
});
