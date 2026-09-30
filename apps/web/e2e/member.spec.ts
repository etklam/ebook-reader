// M6 browser acceptance — member state (READ-03 UI layer): login, library,
// follow badge, progress sync via two contexts (same member), bookmarks view.
// Two browser contexts stand in for two devices; physical devices remain L3.
import { test, expect, type Browser } from '@playwright/test';
import { seedEnv, type Seed } from './seed.ts';

const SUFFIX = Math.random().toString(36).slice(2, 8);
let env: Seed;
let work: string;
let browser2: Browser;

test.beforeAll(async ({ browser }) => {
  env = await seedEnv(SUFFIX);
  work = await env.publish('weird-labels.txt', `瀏覽器會員-${SUFFIX}`);
  // member account (password login IS under test here)
  const { hashPassword } = await import('../../../server/src/auth/password.ts');
  await env.pool.query(
    `insert into app.users (username, email, password_hash, role) values ($1,$2,$3,'member')
     on conflict (email) do nothing`,
    [`e2e-br-m-${SUFFIX}`, `e2e-br-m-${SUFFIX}@example.test`, await hashPassword('pw-12345678')],
  );
  browser2 = await browser.browserType().launch();
});

test.afterAll(async () => {
  const uid = `(select id from app.users where email=$1)`;
  await env.pool.query(`delete from app.reading_progress where user_id in ${uid}`, [`e2e-br-m-${SUFFIX}@example.test`]);
  await env.pool.query(`delete from app.bookmarks where user_id in ${uid}`, [`e2e-br-m-${SUFFIX}@example.test`]);
  await env.pool.query(`delete from app.user_chapter_reads where user_id in ${uid}`, [`e2e-br-m-${SUFFIX}@example.test`]);
  await env.pool.query(`delete from app.user_library where user_id in ${uid}`, [`e2e-br-m-${SUFFIX}@example.test`]);
  await env.pool.query(`delete from app.user_follows where user_id in ${uid}`, [`e2e-br-m-${SUFFIX}@example.test`]);
  await env.pool.query(`delete from app.reader_preferences where user_id in ${uid}`, [`e2e-br-m-${SUFFIX}@example.test`]);
  await env.pool.query(`delete from app.sessions where user_id in (select id from app.users where email=$1)`, [`e2e-br-m-${SUFFIX}@example.test`]);
  await env.pool.query(`delete from app.users where email=$1`, [`e2e-br-m-${SUFFIX}@example.test`]);
  await env.cleanup();
  await browser2.close();
});

async function login(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('電子郵件').fill(`e2e-br-m-${SUFFIX}@example.test`);
  await page.getByLabel('密碼').fill('pw-12345678');
  await page.getByRole('button', { name: '登入' }).click();
  await expect(page).toHaveURL(/me\/library/, { timeout: 15_000 });
}

test('MEM-UI: login lands in library; favorite + follow from detail; badge appears in library', async ({ page }) => {
  await login(page);
  // favorite + follow
  await page.goto(`/works/${work}`);
  await expect(page.locator('[data-testid="work-detail"]')).toBeVisible();
  await page.getByRole('button', { name: /收藏/ }).click();
  await expect(page.getByRole('button', { name: /已收藏/ })).toBeVisible();
  await page.getByRole('button', { name: '追更', exact: true }).click();
  await expect(page.getByRole('button', { name: /✓ 追更/ })).toBeVisible();

  await page.goto('/me/library');
  await expect(page.locator('[data-testid="library-card"]')).toHaveCount(1);
  // fresh follow has seen the current release → no update badge yet
  await expect(page.locator('[data-testid="library-card"]')).not.toContainText('有更新');
});

test('MEM-UI: progress made on device A appears on device B; continue reading works', async ({ page }) => {
  // device A: read into chapter 2
  const ctxA = await browser2.newContext({ viewport: { width: 390, height: 844 } });
  const pageA = await ctxA.newPage();
  await login(pageA);
  await pageA.goto(`/read/${work}`);
  await expect(pageA.locator('[data-paragraph-index="0"]')).toBeVisible({ timeout: 15_000 });
  // scroll down (marks paragraph ~3) and wait for the debounced server write
  await pageA.locator('.reader-scroll').evaluate((el) => { el.scrollTop = 1200; });
  await pageA.waitForTimeout(9500);

  // device B: same member, fresh context — continue reading should exist
  const pageB = await page.context().newPage();
  await pageB.goto('/');
  await login(pageB);
  await pageB.goto('/me/library');
  await expect(pageB.locator('[data-testid="library-card"]', { hasText: `瀏覽器會員-${SUFFIX}` })).toBeVisible({ timeout: 15_000 });
  await expect(pageB.locator('[data-testid="library-card"]').getByRole('button', { name: '繼續閱讀' })).toBeVisible();
  await ctxA.close();
});

test('MEM-UI: bookmark created in reader shows in bookmarks page and can be deleted', async ({ page }) => {
  await login(page);
  await page.goto(`/read/${work}`);
  await expect(page.locator('[data-paragraph-index="0"]')).toBeVisible({ timeout: 15_000 });
  // open chrome → 書籤 button (members only)
  await page.mouse.click(195, 422);
  await page.getByRole('button', { name: '加入書籤' }).click();
  await expect(page.locator('.reader-note', { hasText: '已加入書籤' })).toBeVisible();

  await page.goto('/me/bookmarks');
  await expect(page.locator('[data-testid="bookmark-card"]')).toHaveCount(1);
  await page.locator('[data-testid="bookmark-card"]').getByRole('button', { name: '刪除' }).click();
  await expect(page.locator('[data-testid="bookmark-card"]')).toHaveCount(0);
});
