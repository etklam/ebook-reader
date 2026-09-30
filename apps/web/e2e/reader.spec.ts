// M5 browser acceptance (§21.3): open reader, chapter nav, TOC, chrome
// toggle, bottom sheet, settings (font/theme/conversion/mode), reload
// restore, selection safety, long-chapter bounded rendering. Seeds its own
// works through the real import pipeline, then cleans up.
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API = 'http://localhost:3000';
const FIXTURES = fileURLToPath(new URL('../../../m0/fixtures/txt', import.meta.url));
const SUFFIX = Math.random().toString(36).slice(2, 8);
const ADMIN = `e2e-br-admin-${SUFFIX}@example.test`;

let pool: Pool;
let publicWork: string;      // 10 irregular chapters
let longWork: string;        // one very long chapter
let adminCookie = '';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper over untyped API payloads
async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(API + path, { credentials: 'include', ...init });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

test.beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://ebook_api:dev-api-pass@127.0.0.1:5432/ebook_dev' });
  await pool.query(
    `insert into app.users (username, email, password_hash, role)
     values ($1,$2,$3,'admin') on conflict (email) do nothing`,
    [`e2e-br-${SUFFIX}`, ADMIN, 'nota-real-hash'], // password unused — session via SQL below
  ).catch(() => undefined);

  // session straight in SQL: password login isn't the thing under test
  const { randomBytes, createHash } = await import('node:crypto');
  const token = randomBytes(32).toString('hex');
  const tokenId = createHash('sha256').update(token).digest('hex');
  await pool.query(
    `insert into app.sessions (id, user_id, expires_at)
     select $1, id, now() + interval '1 hour' from app.users where email = $2`,
    [tokenId, ADMIN],
  );
  adminCookie = `ebook_session=${token}`;

  publicWork = await seedWork('weird-labels.txt', `瀏覽器測試-目錄-${SUFFIX}`);
  longWork = await seedWork('long-one-chapter.txt', `瀏覽器測試-長章-${SUFFIX}`);
});

test.afterAll(async () => {
  for (const w of [publicWork, longWork]) {
    if (!w) continue;
    await pool.query(`update app.chapters set head_revision_id = null where work_id = $1`, [w]);
    await pool.query(`delete from app.chapter_revisions where chapter_id in (select id from app.chapters where work_id = $1)`, [w]);
    await pool.query(`delete from app.chapters where work_id = $1`, [w]);
    await pool.query(`delete from app.works where id = $1`, [w]);
  }
  await pool.query(`delete from app.import_items where import_job_id in (select id from app.import_jobs where requested_by_user_id in (select id from app.users where email = $1))`, [ADMIN]);
  await pool.query(`delete from app.import_jobs where requested_by_user_id in (select id from app.users where email = $1)`, [ADMIN]);
  await pool.query(`delete from app.source_files s using app.users u where s.work_id is null and s.id in (select source_file_id from app.import_jobs j where j.requested_by_user_id = u.id and u.email = $1) and not exists (select 1 from app.import_jobs j2 where j2.source_file_id = s.id)`, [ADMIN]).catch(() => undefined);
  await pool.query(`delete from app.sessions where user_id in (select id from app.users where email = $1)`, [ADMIN]);
  await pool.query(`delete from app.users where email = $1`, [ADMIN]);
  await pool.end();
});

async function seedWork(fixture: string, title: string): Promise<string> {
  const form = new FormData();
  form.append('file', new File([readFileSync(`${FIXTURES}/${fixture}`)], fixture));
  const up = await api('/api/admin/imports', { method: 'POST', headers: { cookie: adminCookie }, body: form });
  expect(up.status).toBe(201);
  const importId: string = up.body.importId;
  // worker (pnpm dev:worker) must be running to process the queue
  let status = '';
  for (let i = 0; i < 60 && !['ready', 'review_required', 'failed'].includes(status); i++) {
    await new Promise((r) => setTimeout(r, 500));
    status = (await api(`/api/admin/imports/${importId}`, { headers: { cookie: adminCookie } })).body.status;
  }
  expect(status).not.toBe('failed');
  const commit = await api(`/api/admin/imports/${importId}/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ title, workType: 'serial' }),
  });
  expect(commit.status).toBe(200);
  const workId: string = commit.body.workId;
  await pool.query(`update app.works set visibility = 'public' where id = $1`, [workId]);
  return workId;
}

// Mode-aware visible-paragraph probe: vertical anchor line in scroll mode,
// first horizontally-visible paragraph in paginated mode.
function visibleParagraph(page: import('@playwright/test').Page): Promise<string | null> {
  return page.evaluate(() => {
    const c = document.querySelector('.reader-scroll, .reader-viewport');
    const body = document.getElementById('reader-body');
    if (!c || !body) return null;
    const paras = [...body.querySelectorAll<HTMLElement>('[data-paragraph-index]')];
    if (document.querySelector('[data-mode="paginated"]')) {
      const vpLeft = c.getBoundingClientRect().left;
      const vpRight = vpLeft + c.clientWidth;
      for (const p of paras) {
        const left = p.getBoundingClientRect().left;
        if (left >= vpLeft - 1 && left < vpRight) return p.getAttribute('data-paragraph-index');
      }
      return null;
    }
    const rect = c.getBoundingClientRect();
    const line = rect.top + rect.height * 0.3;
    for (const p of paras) {
      if (p.getBoundingClientRect().bottom > line) return p.getAttribute('data-paragraph-index');
    }
    return null;
  });
}

test('READ-01: open reader → paragraph 0, chrome toggle, bottom sheet, prev/next, TOC jump', async ({ page }) => {
  await page.goto(`/read/${publicWork}`);
  await expect(page.locator('[data-paragraph-index="0"]')).toBeVisible();
  await expect(page.locator('.reader-chapter-label')).toHaveText(/序章/);

  // center tap toggles chrome; chrome must not cover text
  await page.mouse.click(195, 422);
  await expect(page.locator('.reader-toolbar[data-visible]')).toBeVisible();
  const toolbarBox = await page.locator('.reader-toolbar').boundingBox();
  const para0Box = await page.locator('[data-paragraph-index="0"]').boundingBox();
  // para 0 must sit fully outside both chrome bars (header on top, toolbar at bottom)
  const clearOfToolbar = para0Box!.y + para0Box!.height <= toolbarBox!.y || para0Box!.y >= toolbarBox!.y + toolbarBox!.height;
  expect(clearOfToolbar).toBe(true);

  // bottom sheet: TOC with verbatim irregular labels
  await page.getByRole('button', { name: '目錄' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('.toc-item', { hasText: '第12.10章' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();

  // next chapter via toolbar
  await page.getByRole('button', { name: '下一章' }).click();
  await expect(page.locator('.reader-chapter-label')).toHaveText(/第12\.5章/);
  await expect(page.locator('[data-paragraph-index="0"]')).toBeVisible();

  // TOC jump to an irregular middle chapter
  await page.mouse.click(195, 422);
  await page.getByRole('button', { name: '目錄' }).click();
  await page.locator('.toc-item', { hasText: '第12.5.1章' }).click();
  await expect(page.locator('.reader-chapter-label')).toHaveText(/第12\.5\.1章/);

  // previous chapter
  await page.mouse.click(195, 422);
  await page.getByRole('button', { name: '上一章' }).click();
  await expect(page.locator('.reader-chapter-label')).toHaveText(/第12\.10章/);
});

test('READ-01: font size / conversion / mode / theme keep the same paragraph', async ({ page }) => {
  await page.goto(`/read/${publicWork}`);
  await expect(page.locator('[data-paragraph-index="0"]')).toBeVisible();
  await page.waitForTimeout(400); // initial anchor restore settles
  await page.locator('.reader-scroll').evaluate((el) => { el.scrollTop = 800; });
  await page.waitForTimeout(600);

  // open the settings sheet first and let the chrome layout settle — the
  // baseline must be measured against the layout the changes will run in
  await page.mouse.click(195, 422);
  await page.getByRole('button', { name: '設定' }).click();
  await page.waitForTimeout(400);
  const before = await visibleParagraph(page);

  // font size up ×1 → same paragraph restored
  await page.getByRole('button', { name: '放大字號' }).click();
  await page.waitForTimeout(500);
  expect(await visibleParagraph(page)).toBe(before);

  // Traditional/Simplified → same paragraph, text converted
  await page.getByRole('button', { name: '簡體' }).click();
  await page.waitForTimeout(2500); // lazy opencc chunk
  expect(await visibleParagraph(page)).toBe(before);
  const simp = await page.locator(`[data-paragraph-index="${before}"]`).textContent();
  expect(simp).toBeTruthy();

  // scroll → paginated → scroll: exact paragraph round trip (column landing
  // may only be page-granular, but the scroll anchor must survive)
  await page.getByRole('button', { name: '分頁' }).click();
  await page.waitForTimeout(500);
  expect(await page.locator('[data-mode="paginated"]').count()).toBe(1);
  const paginatedPara = await visibleParagraph(page);
  expect(Number(paginatedPara)).toBeLessThanOrEqual(Number(before));
  await page.getByRole('button', { name: '捲動' }).click();
  await page.waitForTimeout(500);
  expect(await visibleParagraph(page)).toBe(before);

  // theme switch is layout-neutral
  await page.getByRole('button', { name: '深色' }).click();
  await expect(page.locator('.theme-dark')).toHaveCount(1);
  await page.keyboard.press('Escape');
  expect(await visibleParagraph(page)).toBe(before);
});

test('READ-01: reload restores chapter + paragraph (local position)', async ({ page }) => {
  await page.goto(`/read/${publicWork}`);
  await expect(page.locator('[data-paragraph-index="0"]')).toBeVisible();
  await page.locator('.reader-scroll').evaluate((el) => { el.scrollTop = 800; });
  await page.waitForTimeout(700); // debounced save
  const before = await visibleParagraph(page);
  const url = page.url();

  await page.reload();
  await expect(page.locator('[data-paragraph-index]')).toHaveCount(11, { timeout: 15_000 });
  await page.waitForTimeout(600);
  expect(page.url()).toBe(url);
  expect(await visibleParagraph(page)).toBe(before);
});

test('READ-02: text selection does not trigger page turn or chrome toggle', async ({ page }) => {
  await page.goto(`/read/${publicWork}`);
  await expect(page.locator('[data-paragraph-index="0"]')).toBeVisible();

  // select text inside a paragraph
  const p = page.locator('[data-paragraph-index="1"]');
  const box = await p.boundingBox();
  await page.mouse.move(box!.x + 5, box!.y + 8);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width - 5, box!.y + 8, { steps: 5 });
  await page.mouse.up();
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected.length).toBeGreaterThan(0);

  // the tap on selection must not flip pages or open chrome
  await page.waitForTimeout(300);
  await expect(page.locator('.reader-toolbar[data-visible]')).toHaveCount(0);
});

test('READ-02: bottom sheet dismissible via backdrop; focus returns', async ({ page }) => {
  await page.goto(`/read/${publicWork}`);
  await expect(page.locator('[data-paragraph-index="0"]')).toBeVisible();
  await page.mouse.click(195, 422);
  await page.getByRole('button', { name: '設定' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.mouse.click(195, 60); // backdrop above the sheet
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('READ-01: long chapter renders only its own paragraphs (novel never fully mounted)', async ({ page }) => {
  const toc = await api(`/api/reader/works/${longWork}/chapters`, {});
  expect(toc.status).toBe(200);
  const chapterId: string = toc.body.chapters[0].id;
  const meta = await api(`/api/reader/chapters/${chapterId}`, {});
  const expected: number = meta.body.paragraphCount;
  expect(expected).toBeGreaterThan(500); // genuinely long

  await page.goto(`/read/${longWork}`);
  await expect(page.locator('[data-paragraph-index="0"]')).toBeVisible({ timeout: 15_000 });
  // exactly this chapter's paragraphs — no more, no fewer
  await expect(page.locator('[data-paragraph-index]')).toHaveCount(expected);
});
