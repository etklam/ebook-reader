// M6 browser acceptance — catalog (§21/§22): search, filter sheet (categories,
// tags all/any, serial status), URL filter state, work detail, entry to reader.
import { test, expect } from '@playwright/test';
import { seedEnv, type Seed } from './seed.ts';

const SUFFIX = Math.random().toString(36).slice(2, 8);
let env: Seed;
let workSerial: string;
let workOther: string;

test.beforeAll(async () => {
  env = await seedEnv(SUFFIX);
  workSerial = await env.publish('weird-labels.txt', `瀏覽器目錄A-${SUFFIX}`, { tags: ['重生'] });
  workOther = await env.publish('partial-181-190.txt', `瀏覽器目錄B-${SUFFIX}`, { tags: ['慢熱'] });
});

test.afterAll(async () => { await env.cleanup(); });

test('CAT-UI: catalog lists seeded works; card opens detail; detail opens reader', async ({ page }) => {
  await page.goto(`/?q=${encodeURIComponent(`瀏覽器目錄A-${SUFFIX}`)}`);
  await expect(page.locator('[data-testid="work-card"]')).toHaveCount(1, { timeout: 15_000 });
  await page.locator('[data-testid="work-card"]').click();
  await expect(page.locator('[data-testid="work-detail"]')).toBeVisible();
  // URL filter state was carried into detail navigation and back (§22)
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`q=`));
  await expect(page.locator('[data-testid="work-card"]')).toHaveCount(1);

  await page.locator('[data-testid="work-card"]').click();
  await page.getByRole('button', { name: /開始閱讀/ }).click();
  await expect(page.locator('[data-paragraph-index="0"]')).toBeVisible({ timeout: 15_000 });
});

test('CAT-UI: filter sheet narrows by tag; URL query restores the filtered view', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /篩選/ }).click();
  await expect(page.locator('[data-testid="filter-sheet"]')).toBeVisible();
  await page.locator('[data-testid="filter-sheet"] button', { hasText: `重生-${SUFFIX}` }).click();
  // selection shows a ✓ (not color alone, §21)
  await expect(page.locator('[data-testid="filter-sheet"] button', { hasText: `✓ 重生-${SUFFIX}` })).toBeVisible();
  await page.getByRole('button', { name: '套用' }).click();
  await expect(page).toHaveURL(/tagIds=/);
  await expect(page.locator('[data-testid="work-card"]')).toHaveCount(1);

  // a fresh load restores from the URL (shareable)
  await page.goto(page.url());
  await expect(page.locator('[data-testid="work-card"]')).toHaveCount(1);
  void workSerial; void workOther;
});

test('CAT-UI: keyword search narrows the catalog', async ({ page }) => {
  await page.goto(`/?q=${encodeURIComponent(`目錄B-${SUFFIX}`)}`);
  await expect(page.locator('[data-testid="work-card"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('[data-testid="work-card"]')).toContainText(`瀏覽器目錄B-${SUFFIX}`);
});
