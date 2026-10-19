import { test, expect } from '@playwright/test';
const work = '11111111-1111-4111-8111-111111111111';
const first = '22222222-2222-4222-8222-222222222222';
const second = '33333333-3333-4333-8333-333333333333';
const revision = '44444444-4444-4444-8444-444444444444';

for (const seo of [false, true]) {
test(`chapter navigation, back/forward and hash preserve one document (${seo ? 'SEO aliases' : 'legacy UUIDs'})`, async ({ page }) => {
  const requests: string[] = [];
  let failFirst = false;
  await page.route('**/api/me', route => route.fulfill({ json: { user: null } }));
  await page.route(/\/api\/reader\/works\/[^/?]+$/, route => route.fulfill({ json: {
    id: work, ...(seo ? { publicId: work.slice(0, 8) } : {}), title: 'History', visibility: 'public', firstChapterId: first,
    latestChapterId: second, releaseId: 'release', chapterCount: 2,
  } }));
  await page.route('**/api/reader/chapters/*', route => {
    const ref = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    const id = ref === first || ref.endsWith(first.slice(0, 8)) ? first : second;
    requests.push(id);
    if (id === first && failFirst) {
      failFirst = false;
      return route.fulfill({ status: 503, json: { error: 'content_unavailable' } });
    }
    return route.fulfill({ json: { workId: work, chapterId: id, ...(seo ? { publicId: id.slice(0, 8) } : {}), revisionId: revision,
      title: id === first ? '第一章' : '第二章', labelRaw: id === first ? '第1章' : '第2章',
      body: Array.from({ length: 40 }, (_, n) => `段落 ${n}。${'山川風雨。'.repeat(20)}`).join('\n\n'),
      resources: [], nextChapterId: id === first ? second : null, previousChapterId: id === second ? first : null,
    } });
  });
  await page.goto(`/read/${work}/${first}`);
  await expect(page.locator('.reader-chapter-label')).toHaveText(/第1章/);
  await page.evaluate(() => { (window as Window & { historyTest?: string }).historyTest = 'same-document'; });
  await page.locator('.reader-scroll').hover();
  await page.mouse.wheel(0, 1200);
  await expect.poll(() => page.locator('.reader-scroll').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.reader-chapter-label')).toHaveText(/第2章/);
  await page.goBack();
  await expect(page.locator('.reader-chapter-label')).toHaveText(/第1章/);
  await expect.poll(() => page.locator('.reader-scroll').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  await page.goForward();
  await expect(page.locator('.reader-chapter-label')).toHaveText(/第2章/);
  expect(requests).toEqual([first, second, first, second]);
  await page.evaluate(({ work, second, revision }) => {
    history.pushState(null, '', `/read/${work}/${second}#p=20&rev=${revision}`);
    dispatchEvent(new PopStateEvent('popstate'));
  }, { work, second, revision });
  await expect.poll(() => page.locator('[data-paragraph-index="20"]').evaluate(el => {
    const vp = document.querySelector('.reader-scroll')!.getBoundingClientRect();
    const rect = el.getBoundingClientRect(); return rect.bottom > vp.top && rect.top < vp.bottom;
  })).toBe(true);
  // Consuming the hash must update router state too: the same result can be
  // opened again after scrolling away without a reload or a stale route value.
  await page.locator('.reader-scroll').evaluate(el => { el.scrollTop = 0; });
  await page.evaluate(({ work, second, revision }) => {
    history.pushState(null, '', `/read/${work}/${second}#p=20&rev=${revision}`);
    dispatchEvent(new PopStateEvent('popstate'));
  }, { work, second, revision });
  await expect.poll(() => page.locator('.reader-scroll').evaluate(el => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as Window & { historyTest?: string }).historyTest)).toBe('same-document');
  // Retrying a failed navigation must reload the requested chapter, rather
  // than the previous successful chapter still held in reader state.
  failFirst = true;
  await page.evaluate(({ work, first }) => {
    history.pushState(null, '', `/read/${work}/${first}`);
    dispatchEvent(new PopStateEvent('popstate'));
  }, { work, first });
  await expect(page.getByTestId('reader-error')).toBeVisible();
  await page.getByRole('button', { name: '重試', exact: true }).click();
  await expect(page.locator('.reader-chapter-label')).toHaveText(/第1章/);
  await expect(page).toHaveURL(seo ? new RegExp(`/read/history-${work.slice(0, 8)}/.*-${first.slice(0, 8)}$`) : new RegExp(`/read/${work}/${first}$`));

});

}
