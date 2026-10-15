// Local real-API navigation sample, not a production latency target.
import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { seedEnv } from '../e2e/seed.ts';

const output = process.argv[2];
if (!output) throw new Error('usage: node scripts/preload-performance.mjs /tmp/preload.json (api + worker + web required)');
const seed = await seedEnv(`prefetch-${Date.now().toString(36)}`);
const browser = await chromium.launch({ headless: true });
try {
  const workId = await seed.publish('base-180.txt', '預載量測暫存作品');
  const work = await (await fetch(`http://localhost:3000/api/reader/works/${workId}`)).json();
  const first = await (await fetch(`http://localhost:3000/api/reader/chapters/${work.firstChapterId}`)).json();
  const next = await (await fetch(`http://localhost:3000/api/reader/chapters/${first.nextChapterId}`)).json();
  const cases = [];
  for (const preloaded of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    let chapterRequests = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === `/api/reader/chapters/${next.chapterId}`) chapterRequests++;
    });
    await page.goto(`http://localhost:5173/read/${workId}/${first.chapterId}`);
    await expect(page.locator('.reader-chapter-label')).toContainText(first.labelRaw);
    await page.waitForTimeout(100);
    if (preloaded) {
      const response = page.waitForResponse((response) => new URL(response.url()).pathname === `/api/reader/chapters/${next.chapterId}`);
      await page.locator('.reader-scroll').evaluate((element) => { element.scrollTop = element.scrollHeight * 0.9; });
      expect((await response).status()).toBe(200);
    } else {
      expect(chapterRequests).toBe(0);
    }
    await page.locator('.reader-scroll').click({ position: { x: 180, y: 200 } });
    await expect(page.getByRole('button', { name: '下一章', exact: true })).toBeVisible();
    const beforeNavigation = chapterRequests;
    const start = performance.now();
    await page.getByRole('button', { name: '下一章', exact: true }).click();
    await expect(page.locator('.reader-chapter-label')).toContainText(next.labelRaw);
    cases.push({ preloaded, navigationMs: performance.now() - start,
      bodyRequestsBeforeNavigation: beforeNavigation, bodyRequestsDuringNavigation: chapterRequests - beforeNavigation });
    await context.close();
  }
  const result = { recordedAt: new Date().toISOString(), browser: browser.version(), viewport: '390x844',
    conditions: 'one sample per case, real localhost API + PostgreSQL + file storage, warm filesystem; fresh anonymous browser contexts; no network throttling', cases };
  await writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await seed.cleanup();
}
