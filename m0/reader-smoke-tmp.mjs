import { chromium } from 'playwright';
const WORK = '2604d10b-0eb7-41ed-a8f4-bd8f77b5695b';
const browser = await chromium.launch({ executablePath: process.env.PW_EXE });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto(`http://localhost:5173/read/${WORK}`);
await page.waitForSelector('[data-paragraph-index="0"]');
await page.locator('.reader-scroll').evaluate((el) => { el.scrollTop = 600; });
await page.waitForTimeout(700);
await page.mouse.click(195, 422);
await page.getByRole('button', { name: '設定' }).click();
await page.getByRole('button', { name: '簡體' }).click();
await page.waitForTimeout(1500);
await page.getByRole('button', { name: '深色' }).click();
await page.getByRole('button', { name: '分頁' }).click();
await page.waitForTimeout(600);
const info = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('[data-paragraph-index="0"]')];
  const bodies = [...document.querySelectorAll('#reader-body')];
  return {
    para0Count: nodes.length,
    bodyCount: bodies.length,
    texts: nodes.map((n) => n.textContent.slice(0, 16)),
    parents: nodes.map((n) => n.parentElement.className + '>' + n.parentElement.parentElement.className),
    scrollTop: document.querySelector('[data-testid="reader-viewport"]').scrollTop,
    bodyRectTop: bodies[0]?.getBoundingClientRect().top,
  };
});
console.log(JSON.stringify(info, null, 1));
await page.screenshot({ path: '/tmp/s6.png' });
await browser.close();
