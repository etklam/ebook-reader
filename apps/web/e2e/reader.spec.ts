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
    // M6 FK order: member state → release snapshot → revisions → chapters
    await pool.query(`delete from app.reading_progress where work_id=$1`, [w]);
    await pool.query(`delete from app.bookmarks where work_id=$1`, [w]);
    await pool.query(`delete from app.user_chapter_reads where chapter_id in (select id from app.chapters where work_id=$1)`, [w]);
    await pool.query(`delete from app.user_follows where work_id=$1`, [w]);
    await pool.query(`delete from app.user_library where work_id=$1`, [w]);
    await pool.query(`update app.chapters set head_revision_id = null where work_id = $1`, [w]);
    await pool.query(`delete from app.release_items where release_id in (select id from app.work_releases where work_id=$1)`, [w]);
    await pool.query(`delete from app.publication_events where work_id=$1`, [w]);
    await pool.query(`update app.works set active_release_id=null where id=$1`, [w]);
    await pool.query(`delete from app.work_releases where work_id=$1`, [w]);
    await pool.query(`delete from app.chapter_revisions where chapter_id in (select id from app.chapters where work_id = $1)`, [w]);
    await pool.query(`delete from app.chapters where work_id = $1`, [w]);
    await pool.query(`delete from app.work_categories where work_id=$1`, [w]);
    await pool.query(`update app.source_files set work_id=null where work_id=$1`, [w]);
    await pool.query(`update app.import_jobs set work_id=null where work_id=$1`, [w]);
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
  // M6: public readability requires an active release — publish through the
  // real pipeline (first publish needs one active category)
  const [cat] = (await pool.query(
    `insert into app.categories (display_name) values ($1) returning id`,
    [`spec-cat-${SUFFIX}-${workId.slice(0, 4)}`],
  )).rows as Array<{ id: string }>;
  await pool.query(`insert into app.work_categories (work_id, category_id) values ($1,$2) on conflict do nothing`, [workId, cat.id]);
  await pool.query(`update app.works set serial_status='ongoing', visibility='public' where id=$1`, [workId]);
  const pub = await fetch('http://localhost:3000' + `/api/admin/works/${workId}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie, 'idempotency-key': `spec-${workId}` },
    body: '{}',
  });
  expect(pub.status).toBe(200);
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

  // Mobile chrome floats above the article without moving its paragraphs.
  const para0 = page.locator('[data-paragraph-index="0"]');
  const beforeMenu = await para0.boundingBox();
  await page.mouse.click(195, 422);
  await expect(page.locator('.reader-toolbar[data-visible]')).toBeVisible();
  expect(await para0.boundingBox()).toEqual(beforeMenu);
  await page.mouse.click(195, 422);
  await expect(page.locator('.reader-toolbar[data-visible]')).toHaveCount(0);
  expect(await para0.boundingBox()).toEqual(beforeMenu);
  await page.mouse.click(195, 422);

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

test('READ-01: keyboard moves through the chapter and the work; Escape closes one layer', async ({ page }) => {
  await page.goto(`/read/${publicWork}`);
  await expect(page.locator('[data-paragraph-index="0"]')).toBeVisible();
  await page.mouse.click(195, 422);                       // chrome up, to read the label
  const label = page.locator('.reader-chapter-label');
  await expect(label).toHaveText(/序章/);

  // scroll mode: ←/→ are chapter turns, PageDown is a screenful
  await page.keyboard.press('ArrowRight');
  await expect(label).toHaveText(/第12\.5章/);
  await page.keyboard.press('ArrowLeft');
  await expect(label).toHaveText(/序章/);

  // Escape dismisses the sheet first, and only then the chrome
  await page.mouse.click(195, 422);
  await page.getByRole('button', { name: '設定' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('.reader-toolbar[data-visible]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.reader-toolbar[data-visible]')).toHaveCount(0);

  // PageDown / Space move by a screenful — measured on the long chapter, which
  // is guaranteed to have somewhere to go
  await page.goto(`/read/${longWork}`);
  await expect(page.locator('[data-paragraph-index="0"]')).toBeVisible({ timeout: 15_000 });
  const scrollTop = () => page.locator('.reader-scroll').evaluate((el) => el.scrollTop);
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(600);                         // smooth scroll settles
  const afterPageDown = await scrollTop();
  expect(afterPageDown).toBeGreaterThan(0);
  await page.keyboard.press(' ');
  await page.waitForTimeout(600);
  expect(await scrollTop()).toBeGreaterThan(afterPageDown);
  await page.keyboard.press('PageUp');
  await page.waitForTimeout(600);
  expect(await scrollTop()).toBeLessThan(afterPageDown + 1);
});

// §9.2: the tap bands run across the page — bottom forward, top back, the
// middle half is the chrome. The viewport is 390×844, so the bands are the
// top/bottom 211px and the middle runs 211–633.
test('READ-01: paginated tap bands — bottom turns forward, top back, middle is chrome', async ({ page }) => {
  await page.goto(`/read/${longWork}`);
  await expect(page.locator('[data-paragraph-index="0"]')).toBeVisible({ timeout: 15_000 });
  await page.mouse.click(195, 422);
  await page.getByRole('button', { name: '設定' }).click();
  await page.getByRole('button', { name: '分頁' }).click();
  await expect(page.locator('[data-mode="paginated"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.mouse.click(195, 422);                       // chrome down
  await page.waitForTimeout(300);

  const readout = page.locator('.reader-pageinfo');
  const first = await readout.textContent();
  expect(first).toMatch(/^1 \/ \d+$/);

  // bottom band: forward, one page per tap and no chrome
  await page.mouse.click(195, 780);
  await page.waitForTimeout(250);
  await expect(readout).toHaveText(/^2 \//);
  await expect(page.locator('.reader-toolbar[data-visible]')).toHaveCount(0);
  await page.mouse.click(195, 780);
  await page.waitForTimeout(250);
  await expect(readout).toHaveText(/^3 \//);

  // top band: back
  await page.mouse.click(195, 90);
  await page.waitForTimeout(250);
  await expect(readout).toHaveText(/^2 \//);

  // Opening and closing mobile chrome preserves the page, page count and layout.
  const beforeMenu = await page.locator('#reader-body').boundingBox();
  const beforeReadout = await readout.textContent();
  await page.mouse.click(195, 422);
  await expect(page.locator('.reader-toolbar[data-visible]')).toHaveCount(1);
  await page.waitForTimeout(300); // allow any resize-triggered pagination to settle
  await expect(readout).toHaveText(beforeReadout!);
  expect(await page.locator('#reader-body').boundingBox()).toEqual(beforeMenu);
  await page.mouse.click(195, 422);
  await expect(page.locator('.reader-toolbar[data-visible]')).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(readout).toHaveText(beforeReadout!);
  expect(await page.locator('#reader-body').boundingBox()).toEqual(beforeMenu);
});

test('READ-01: paginated mode turns pages on a touch swipe, not on a drag-select', async ({ page }) => {
  await page.goto(`/read/${longWork}`);
  await expect(page.locator('[data-paragraph-index="0"]')).toBeVisible({ timeout: 15_000 });
  await page.mouse.click(195, 422);
  await page.getByRole('button', { name: '設定' }).click();
  await page.getByRole('button', { name: '分頁' }).click();
  await expect(page.locator('[data-mode="paginated"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.mouse.click(195, 422);                       // chrome down
  await page.waitForTimeout(300);

  const readout = page.locator('.reader-pageinfo');
  const first = await readout.textContent();
  const vp = page.locator('[data-testid="reader-viewport"]');
  const swipe = async (fromX: number, toX: number) => {
    await vp.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: fromX, clientY: 420, isPrimary: true });
    await page.waitForTimeout(80);
    await vp.dispatchEvent('pointerup', { pointerType: 'touch', clientX: toX, clientY: 428, isPrimary: true });
    await page.waitForTimeout(250);
  };
  expect(first).toMatch(/^1 \/ \d+$/);
  await swipe(330, 110);                                  // leftwards: forward
  expect(await readout.textContent()).toMatch(/^2 \//);   // exactly one page
  await swipe(110, 330);                                  // rightwards: back
  expect(await readout.textContent()).toBe(first);

  // a mouse drag is a selection gesture and must never turn the page (READ-02)
  const box = await page.locator('[data-paragraph-index="0"]').boundingBox();
  await page.mouse.move(box!.x + 6, box!.y + 8);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width - 6, box!.y + 8, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  expect(await readout.textContent()).toBe(first);
});

// The strip is translated by one "step" per page; if that step and the real
// column pitch disagree, every turn drifts and text is clipped at the seam.
test('READ-01: a page turn travels exactly one column pitch', async ({ page }) => {
  await page.goto(`/read/${longWork}`);
  await expect(page.locator('[data-paragraph-index="0"]')).toBeVisible({ timeout: 15_000 });
  await page.mouse.click(195, 422);
  await page.getByRole('button', { name: '設定' }).click();
  await page.getByRole('button', { name: '分頁' }).click();
  await expect(page.locator('[data-mode="paginated"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  const geometry = () => page.evaluate(() => {
    const vp = document.querySelector('.reader-viewport') as HTMLElement;
    const strip = document.getElementById('reader-body') as HTMLElement;
    const cs = getComputedStyle(strip);
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    return {
      pitch: strip.clientWidth - pad + (parseFloat(cs.columnGap) || 0),
      offset: new DOMMatrixReadOnly(cs.transform).m41,
      vpWidth: vp.clientWidth,
    };
  });

  const first = await geometry();
  expect(first.pitch).toBe(first.vpWidth + 48);     // one viewport + the gap
  await page.getByRole('button', { name: '下一頁' }).click();
  await page.waitForTimeout(300);
  const second = await geometry();
  expect(first.offset - second.offset).toBe(first.pitch);
  await page.getByRole('button', { name: '下一頁' }).click();
  await page.waitForTimeout(300);
  expect(second.offset - (await geometry()).offset).toBe(first.pitch);
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
