import { test, expect, type Page } from '@playwright/test';
const work = '00000000-0000-0000-0000-000000000101';
const first = '00000000-0000-0000-0000-000000000102';
const second = '00000000-0000-0000-0000-000000000103';
type MockUtterance = { text: string; onstart?: () => void; onend?: () => void };
declare global { interface Window { __speechTest: { texts: string[]; utterance: MockUtterance | null; paused: boolean } } }
const marker = `[[img:${'a'.repeat(64)}]]`;

async function setup(page: Page) {
  await page.addInitScript(() => {
    const state = { texts: [] as string[], utterance: null as MockUtterance | null, paused: false };
    Object.defineProperty(window, '__speechTest', { value: state });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: class { text: string; constructor(text: string) { this.text = text; } } });
    Object.defineProperty(window, 'speechSynthesis', { value: {
      getVoices: () => [], addEventListener() {}, removeEventListener() {},
      cancel() { state.utterance = null; }, pause() { state.paused = true; }, resume() { state.paused = false; },
      speak(utterance: MockUtterance) { state.texts.push(utterance.text); state.utterance = utterance; utterance.onstart?.(); },
    } });
  });
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    let json: unknown = {};
    if (path === '/api/me') json = { user: null };
    else if (path === `/api/reader/works/${work}`) json = { id: work, title: '朗讀測試', author: '', workType: 'serial', chapterCount: 2, firstChapterId: first, latestChapterId: second, releaseId: 'release', releaseVersion: 1, publishedAt: '2026-01-01' };
    else if (path === `/api/reader/works/${work}/chapters`) json = { total: 2, offset: 0, limit: 100, chapters: [first, second].map((id, i) => ({ id, labelRaw: `第${i + 1}章`, title: '', editorialPosition: i + 1, revisionId: `${id}-revision`, volumeId: null })) };
    else if (path.startsWith('/api/reader/chapters/')) {
      const id = path.split('/').at(-1)!;
      json = { chapterId: id, workId: work, revisionId: `${id}-revision`, labelRaw: id === first ? '第1章' : '第2章', title: '', body: id === first ? `開始${'長段落'.repeat(100)}\n\n${marker}\n\n第三段內容\n\n第四段內容` : '新章首段\n\n新章第二段', paragraphCount: id === first ? 4 : 2, previousChapterId: id === first ? null : first, nextChapterId: id === first ? second : null, resources: [] };
    }
    await route.fulfill({ json });
  });
  await page.goto(`/read/${work}/${first}`);
  await expect(page.locator('.reader-chapter-label')).toHaveText(/第1章/);
  await page.mouse.click(195, 422);
  await page.getByRole('button', { name: '設定', exact: true }).click();
}
async function finishChunk(page: Page) {
  await page.evaluate(() => window.__speechTest.utterance?.onend?.());
}

test('speech chunks keep canonical paragraph highlights, pause, paragraph resume, and survive closed settings', async ({ page }) => {
  await setup(page);
  await page.getByRole('button', { name: '朗讀本章', exact: true }).click();
  await expect(page.getByText('正在朗讀第 1 段', { exact: true })).toBeVisible();
  await finishChunk(page); // same long canonical paragraph, second utterance
  await expect(page.getByText('正在朗讀第 1 段', { exact: true })).toBeVisible();
  await finishChunk(page); // image-only paragraph skipped
  await expect(page.getByText('正在朗讀第 3 段', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '暫停', exact: true }).click();
  await expect(page.getByText('正在朗讀第 3 段（已暫停）')).toBeVisible();
  await page.getByRole('button', { name: '繼續', exact: true }).click();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.getByRole('button', { name: '從第 3 段續播', exact: true }).click();
  expect(await page.evaluate(() => window.__speechTest.texts.at(-1))).toBe('第三段內容');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => Boolean(window.__speechTest.utterance))).toBe(true);
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '下一章', exact: true }).click();
  await expect(page.locator('.reader-chapter-label')).toHaveText(/第2章/);
  await page.mouse.click(195, 422);
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await expect(page.getByRole('button', { name: /段續播/ })).toHaveCount(0);
});

test('automatic next chapter begins at paragraph zero and never speaks image markers', async ({ page }) => {
  await setup(page);
  await page.getByLabel('讀完自動下一章').check();
  await page.getByRole('button', { name: '朗讀本章', exact: true }).click();
  for (let index = 0; index < 4; index++) await finishChunk(page);
  await expect(page.locator('.reader-chapter-label')).toHaveText(/第2章/);
  await expect.poll(() => page.evaluate(() => window.__speechTest.texts.at(-1))).toBe('新章首段');
  expect(await page.evaluate(() => window.__speechTest.texts.some((text: string) => text.includes('[[img:')))).toBe(false);
  await expect(page.locator('[data-paragraph-index="0"]')).toHaveAttribute('data-speaking', 'true');
});
