// Headless smoke test for both M0 POC pages (L1-grade check; real-device
// checks per §22A L3 remain manual). Run: node reader-poc/smoke.mjs
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ponytail: reuse the newest cached headless shell instead of downloading the
// exact pinned revision; fine for a smoke test, not for CI screenshots.
function cachedHeadlessShell() {
  const dir = join(homedir(), 'Library/Caches/ms-playwright');
  const best = readdirSync(dir).filter((d) => d.startsWith('chromium_headless_shell-')).sort().pop();
  if (!best) return undefined;
  const sub = join(dir, best);
  const inner = readdirSync(sub).find((d) => d.startsWith('chrome-headless-shell-'));
  return inner ? join(sub, inner, 'chrome-headless-shell') : undefined;
}
const EXECUTABLE = cachedHeadlessShell();

const results = [];
const errors = [];
const fail = (name, msg) => { errors.push(`${name}: ${msg}`); };

async function contentFrame(page) {
  // wait until the engine has injected its content iframe
  for (let i = 0; i < 60; i++) {
    const f = page.frames().find((f) => f !== page.mainFrame() && f.url() !== 'about:blank');
    if (f) {
      const has = await f.evaluate(() => document.querySelectorAll('p').length > 0).catch(() => false);
      if (has) return f;
    }
    await page.waitForTimeout(500);
  }
  return null;
}

for (const [name, url] of [
  ['epubjs', 'http://localhost:8787/reader-poc/epubjs.html'],
  ['foliate', 'http://localhost:8787/reader-poc/foliate.html'],
]) {
  const browser = await chromium.launch(EXECUTABLE ? { executablePath: EXECUTABLE } : {});
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', (e) => fail(name, `pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') fail(name, `console: ${m.text()}`); });

  await page.goto(url);
  await page.waitForFunction(
    () => !document.getElementById('status').textContent.includes('載入中'),
    { timeout: 20000 },
  );
  results.push(`${name}: loaded — ${await page.textContent('#status')}`);

  const frame = await contentFrame(page);
  if (!frame) { fail(name, 'no content frame with paragraphs'); await browser.close(); continue; }

  // 1. paragraphs tagged, tap saves paragraph_index. Bump the font first so
  // content overflows the viewport and restore can't pass by accident.
  await page.click('#font-inc');
  await page.click('#font-inc');
  await page.waitForTimeout(400);
  const count = await frame.evaluate(() => document.querySelectorAll('p').length);
  await frame.click('#p8');
  const posText = await page.textContent('#pos-display');
  results.push(`${name}: ${count} paragraphs; after tap → ${posText}`);
  if (!posText.includes('段 8')) fail(name, 'tap did not save paragraph_index');

  // 2. reload restores to the same logical paragraph
  await page.reload();
  await page.waitForFunction(
    () => !document.getElementById('status').textContent.includes('載入中'),
    { timeout: 20000 },
  );
  const frame2 = await contentFrame(page);
  const restored = await frame2.evaluate(() => {
    const el = document.getElementById('p8');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, selected: el.classList.contains('selected') };
  });
  results.push(`${name}: after reload p8 rect=${JSON.stringify(restored)}`);
  if (!restored) fail(name, 'p8 missing after reload');
  else if (Math.abs(restored.left) > 900 || restored.top < -100 || restored.top > 844) {
    fail(name, `p8 not near viewport after restore (left=${restored.left}, top=${restored.top})`);
  }

  // 3. 繁簡 conversion derived from original (§15)
  await page.click('#text-mode'); // 繁體
  await page.click('#text-mode'); // 簡體
  await page.waitForTimeout(800);
  const conv = await frame2.evaluate(() => {
    const orig = document.getElementById('p0').dataset.orig;
    return { orig: orig.slice(0, 12), now: document.getElementById('p0').textContent.slice(0, 12) };
  });
  results.push(`${name}: text-mode simplified ${JSON.stringify(conv)}`);
  if (conv.orig === conv.now) fail(name, 'simplified mode did not change text');

  // 4. flow + font-size change keep no errors (re-anchor path)
  await page.click('#flow');
  await page.waitForTimeout(600);
  await page.click('#font-inc');
  await page.waitForTimeout(600);

  // 5. chapter navigation
  await page.click('#next-ch');
  await page.waitForTimeout(800);
  const statusNext = await page.textContent('#status');
  results.push(`${name}: after next-ch → ${statusNext}`);
  if (statusNext.includes('1/')) fail(name, 'chapter navigation did not advance');

  await browser.close();
}

console.log(results.join('\n'));
if (errors.length) {
  console.error('\nFAILURES:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\nall smoke checks passed');
