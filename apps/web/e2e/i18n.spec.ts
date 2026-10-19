// Interface language (docs/i18n.md). Unlike the other specs here, this one needs
// no API, worker or database: the catalogue renders its failure state and the
// footer's language switcher is still there, which is all this exercises. Only
// `pnpm --filter web dev` has to be up.
//
// What it is actually checking is the repaint: `t()` is a module function, so a
// locale change only reaches the screen because I18nRoot's state sits above the
// whole tree. A regression there (a memo, or passing <App/> as a stable child)
// would leave the page in the old language with the chip showing the new one.
import { expect, test } from '@playwright/test';

test('switching language repaints the UI, persists, and sets <html lang>', async ({ page }) => {
  await page.goto('/');
  const footer = page.locator('.app-footer');
  await expect(footer.locator('.setting-label')).toHaveText('語言');
  await expect(page.getByRole('button', { name: '書庫', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('zh-Hant');

  await footer.getByRole('button', { name: '简体中文' }).click();

  // the footer label, and a tab well outside the footer's subtree
  await expect(footer.locator('.setting-label')).toHaveText('语言');
  await expect(page.getByRole('button', { name: '书库', exact: true })).toBeVisible();
  await expect(footer.getByRole('button', { name: '✓ 简体中文' })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('zh-Hans');
  expect(await page.evaluate(() => localStorage.getItem('ebook:ui-locale'))).toBe('zh-Hans');

  // the stored choice is applied before the first render, not after it
  await page.reload();
  await expect(footer.locator('.setting-label')).toHaveText('语言');
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('zh-Hans');

  await footer.getByRole('button', { name: '繁體中文' }).click();
  await expect(footer.locator('.setting-label')).toHaveText('語言');
});
