// Visual harness: drives the real app against mocked API responses so every
// surface can be looked at without the Postgres stack. Not part of acceptance.
//   node e2e/shots.mjs            (light)
//   node e2e/shots.mjs dark       (dark shell)
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const scheme = process.argv[2] === 'dark' ? 'dark' : 'light';
const OUT = `/tmp/shots-${scheme}`;
mkdirSync(OUT, { recursive: true });

const CATS = [
  { id: 'c1', displayName: '都市', description: '', sortOrder: 1, isActive: true },
  { id: 'c2', displayName: '科幻', description: '', sortOrder: 2, isActive: true },
  { id: 'c3', displayName: '武俠', description: '', sortOrder: 3, isActive: true },
];
const TAGS = [
  { id: 't1', displayName: '重生', description: '', sortOrder: 1, isActive: true },
  { id: 't2', displayName: '系統', description: '', sortOrder: 2, isActive: true },
  { id: 't3', displayName: '慢熱', description: '', sortOrder: 3, isActive: true },
  { id: 't4', displayName: '群像', description: '', sortOrder: 4, isActive: true },
];

const WORKS = [
  {
    id: '11111111-1111-4111-8111-111111111111', title: '重生之廚神', author: '林夕',
    description: '他在爐火前死了一次，又在十六歲的夏天醒來。這一世他只想把那道湯做對。',
    workType: 'serial', serialStatus: 'ongoing', chapterCount: 1284,
    latestPublishedAt: new Date().toISOString(), categories: ['都市', '美食'], tags: ['重生', '系統'],
  },
  {
    id: '22222222-2222-4222-8222-222222222222', title: '沉默的星圖', author: '佚名',
    description: '觀測站最後一次回報是在三十七年前。訊號裡只有一段不斷重複的座標。',
    workType: 'serial', serialStatus: 'completed', chapterCount: 92,
    latestPublishedAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    categories: ['科幻', '懸疑'], tags: ['末日', '群像'],
  },
  {
    id: '33333333-3333-4333-8333-333333333333', title: '長夜將盡', author: '裴九',
    description: '鎮北軍退到最後一道關隘時，只剩下四百人和一面看不清字的旗。',
    workType: 'serial', serialStatus: 'paused', chapterCount: 431,
    latestPublishedAt: new Date(Date.now() - 20 * 86400000).toISOString(),
    categories: ['武俠'], tags: ['慢熱', '群像'],
  },
  {
    id: '44444444-4444-4444-8444-444444444444', title: '鏡子裡的第七個人', author: '蘇晚',
    description: '每天早上鏡中都多一個人。今天是第七個，而她認得這張臉。',
    workType: 'short_story', serialStatus: null, chapterCount: 1,
    latestPublishedAt: new Date(Date.now() - 45 * 86400000).toISOString(),
    categories: ['懸疑'], tags: [],
  },
];

const PARA = [
  '爐火燒得很旺，鐵鍋裡的油還沒熱透，他卻已經聞到了那股焦味。那不是這間廚房的味道，是三十年後的。',
  '林夕把刀放下，手心全是汗。窗外的蟬聲一層層壓過來，像是要把整個夏天都叫碎。',
  '「愣著幹什麼，水要開了。」師父在身後敲了一下案板。',
  '他回過神，才發現自己站的是老店後廚那塊磨得發亮的青磚地。磚縫裡還卡著去年掉的一粒花椒。',
  '那一刻他想起來了：這一天，是他第一次把那道湯做壞的日子。',
  '湯要文火兩個時辰，中途不能揭蓋。他當年揭了，因為有人在門口喊他的名字。',
  '這一次，門口還是會有人喊。他知道那是誰，也知道那人會在三年後死在同一條巷子裡。',
  '他把蓋子壓實，又在上面放了一塊濕布。',
  '「師父，」他說，「今天這鍋，我守著。」',
  '師父沒回頭，只是哼了一聲：「你守得住才好。」',
];

const CHAPTERS = [
  { id: 'aaaaaaa1-0000-4000-8000-000000000001', volumeId: null, labelRaw: '序章', title: '爐火', editorialPosition: 1, revisionId: 'bbbbbbb1-0000-4000-8000-000000000001' },
  { id: 'aaaaaaa2-0000-4000-8000-000000000002', volumeId: null, labelRaw: '第一章', title: '那道湯', editorialPosition: 2, revisionId: 'bbbbbbb2-0000-4000-8000-000000000002' },
  { id: 'aaaaaaa3-0000-4000-8000-000000000003', volumeId: null, labelRaw: '第二章', title: '青磚地上的花椒', editorialPosition: 3, revisionId: 'bbbbbbb3-0000-4000-8000-000000000003' },
  { id: 'aaaaaaa4-0000-4000-8000-000000000004', volumeId: null, labelRaw: '第三章', title: '', editorialPosition: 4, revisionId: 'bbbbbbb4-0000-4000-8000-000000000004' },
  { id: 'aaaaaaa5-0000-4000-8000-000000000005', volumeId: null, labelRaw: '第十二．五章', title: '補章', editorialPosition: 5, revisionId: 'bbbbbbb5-0000-4000-8000-000000000005' },
  { id: 'aaaaaaa6-0000-4000-8000-000000000006', volumeId: null, labelRaw: '第四章', title: '夏天叫碎了', editorialPosition: 6, revisionId: 'bbbbbbb6-0000-4000-8000-000000000006' },
];

let member = false;
let ROLE = 'member';

async function mock(page) {
  // regex, not a glob: a glob on **/api/** also swallows /src/api/client.ts
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (p === '/api/me') return json({ user: member ? { id: 'u1', role: ROLE } : null });
    if (p === '/api/works') {
      const q = url.searchParams.get('q') ?? '';
      const type = url.searchParams.get('type') ?? '';
      const tagIds = (url.searchParams.get('tagIds') ?? '').split(',').filter(Boolean);
      let works = WORKS.filter((w) => (!q || w.title.includes(q)) && (!type || w.workType === type));
      if (tagIds.length) {
        const names = tagIds.map((id) => TAGS.find((t) => t.id === id)?.displayName);
        works = works.filter((w) => names.every((n) => w.tags.includes(n)));
      }
      return json({ total: null, limit: 20, offset: 0, works });
    }
    if (p.startsWith('/api/taxonomy/categories')) return json({ total: 3, limit: 50, offset: 0, items: CATS });
    if (p.startsWith('/api/taxonomy/tags')) return json({ total: 4, limit: 50, offset: 0, items: TAGS });
    if (p.match(/^\/api\/works\/[0-9a-f-]{36}$/)) {
      const w = WORKS.find((x) => x.id === p.split('/').pop());
      return json({
        ...w, visibility: 'public', releaseId: 'rel1', releaseVersion: 14,
        publishedAt: w.latestPublishedAt, firstChapterId: 'aaaaaaa1-0000-4000-8000-000000000001',
      });
    }
    if (p.match(/^\/api\/reader\/works\/[0-9a-f-]{36}$/)) {
      const w = WORKS.find((x) => x.id === p.split('/').pop());
      return json({
        ...w, visibility: 'public', firstChapterId: 'aaaaaaa1-0000-4000-8000-000000000001', latestChapterId: 'aaaaaaa6-0000-4000-8000-000000000006',
        releaseId: 'rel1', releaseVersion: 14, publishedAt: w.latestPublishedAt,
      });
    }
    if (p.endsWith('/chapters')) return json({ total: CHAPTERS.length, limit: 100, offset: 0, chapters: CHAPTERS });
    if (p.startsWith('/api/reader/chapters/')) {
      const id = p.split('/').pop();
      const i = CHAPTERS.findIndex((c) => c.id === id);
      const c = CHAPTERS[Math.max(0, i)];
      const body = Array.from({ length: 24 }, (_, k) => PARA[k % PARA.length]).join('\n\n');
      return json({
        chapterId: c.id, workId: '11111111-1111-4111-8111-111111111111', revisionId: c.revisionId, labelRaw: c.labelRaw, title: c.title,
        body, previousChapterId: i > 0 ? CHAPTERS[i - 1].id : null,
        nextChapterId: i < CHAPTERS.length - 1 ? CHAPTERS[i + 1].id : null,
        paragraphCount: 24, updatedAt: new Date().toISOString(),
      });
    }
    if (p === '/api/me/library') {
      return json({ works: member ? [
        { workId: '11111111-1111-4111-8111-111111111111', title: '重生之廚神', author: '林夕', workType: 'serial', serialStatus: 'ongoing', hasUpdate: true, newChapterCount: 3, continueChapterId: 'aaaaaaa3-0000-4000-8000-000000000003', continueParagraphIndex: 7, lastReadAt: new Date(Date.now() - 7200000).toISOString(), addedAt: new Date().toISOString() },
        { workId: '33333333-3333-4333-8333-333333333333', title: '長夜將盡', author: '裴九', workType: 'serial', serialStatus: 'paused', hasUpdate: false, newChapterCount: 0, continueChapterId: null, continueParagraphIndex: null, lastReadAt: null, addedAt: new Date().toISOString() },
      ] : [] });
    }
    if (p === '/api/me/follows') {
      return json({ follows: member ? [{ workId: '11111111-1111-4111-8111-111111111111', title: '重生之廚神', hasUpdate: true, newChapterCount: 3, lastSeenVersion: 11, latestVersion: 14 }] : [] });
    }
    if (p.startsWith('/api/me/progress')) return json({ progress: null });
    if (p === '/api/me/bookmarks') {
      return json({ bookmarks: member ? [
        { id: 'b1', workId: '11111111-1111-4111-8111-111111111111', workTitle: '重生之廚神', chapterId: 'aaaaaaa3-0000-4000-8000-000000000003', chapterLabel: '第二章', revisionId: 'bbbbbbb3-0000-4000-8000-000000000003', paragraphIndex: 12, note: '這段的節奏要記下來', createdAt: new Date(Date.now() - 86400000).toISOString() },
        { id: 'b2', workId: '22222222-2222-4222-8222-222222222222', workTitle: '沉默的星圖', chapterId: 'aaaaaaa1-0000-4000-8000-000000000001', chapterLabel: '序章', revisionId: 'bbbbbbb1-0000-4000-8000-000000000001', paragraphIndex: 3, note: '', createdAt: new Date(Date.now() - 5 * 86400000).toISOString() },
      ] : [] });
    }
    if (p === '/api/me/reader-preferences') return json({ preferences: null });
    if (p === '/api/me/reads') return json({ reads: [] });
    return json({ ok: true });
  });
}

const shots = [];
async function shot(page, name, { full = false } = {}) {
  await page.mouse.move(5, 5);   // never screenshot a stale :hover
  await page.waitForTimeout(450);
  const file = `${OUT}/${name}.png`;
  await page.screenshot({ path: file, fullPage: full });
  shots.push(file);
  console.log(file);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  colorScheme: scheme,
  locale: 'zh-Hant-TW',
});
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.error('PAGE ERROR:', m.text()); });
page.on('pageerror', (e) => console.error('UNCAUGHT:', e.message));
await mock(page);

// --- guest surfaces ---
await page.goto(`${BASE}/`);
await page.waitForSelector('[data-testid="work-card"]');
await shot(page, '01-catalog');

await page.getByRole('button', { name: /篩選/ }).click();
await page.waitForSelector('[data-testid="filter-sheet"]');
await page.locator('[data-testid="filter-sheet"] button', { hasText: '重生' }).first().click();
await page.locator('[data-testid="filter-sheet"] button', { hasText: '系統' }).first().click();
await shot(page, '02-filter-sheet');
await page.getByRole('button', { name: '套用' }).click();
await shot(page, '03-catalog-filtered');

await page.goto(`${BASE}/?q=%E6%89%BE%E4%B8%8D%E5%88%B0`);
await page.waitForTimeout(600);
await shot(page, '04-catalog-empty');

await page.goto(`${BASE}/works/11111111-1111-4111-8111-111111111111`);
await page.waitForSelector('[data-testid="work-detail"]');
await shot(page, '05-work-detail', { full: true });

await page.getByRole('button', { name: '目錄' }).click();
await shot(page, '06-work-toc');

await page.goto(`${BASE}/login`);
await shot(page, '07-login');
await page.goto(`${BASE}/register`);
await shot(page, '08-register');

// --- reader ---
await page.goto(`${BASE}/read/11111111-1111-4111-8111-111111111111/aaaaaaa2-0000-4000-8000-000000000002`);
await page.waitForSelector('[data-paragraph-index="0"]');
await shot(page, '09-reader-immersive');
await page.mouse.click(195, 500);
await shot(page, '10-reader-chrome');
await page.getByRole('button', { name: '設定' }).click();
await shot(page, '11-reader-settings');
await page.getByRole('button', { name: '護眼' }).click();
await shot(page, '12-reader-sepia');
await page.getByRole('button', { name: '深色' }).click();
await shot(page, '13-reader-dark');
await page.getByRole('button', { name: '分頁' }).click();
await page.waitForTimeout(500);
await page.getByRole('button', { name: '亮色' }).click();
await page.keyboard.press('Escape');       // chrome stays open behind the sheet
await shot(page, '14-reader-paginated-chrome');
await page.mouse.click(195, 500);          // hide chrome: paginated, immersive
await shot(page, '15-reader-paginated');
await page.mouse.click(195, 500);
await page.getByRole('button', { name: '設定' }).click();
await page.getByRole('button', { name: '捲動' }).click();
await page.keyboard.press('Escape');
await page.getByRole('button', { name: '目錄' }).click();
await shot(page, '16-reader-toc');
await page.keyboard.press('Escape');

// --- member surfaces ---
member = true;
await page.goto(`${BASE}/me/library`);
await page.waitForSelector('[data-testid="library-card"]');
await shot(page, '17-library', { full: true });
await page.goto(`${BASE}/me/bookmarks`);
await page.waitForSelector('[data-testid="bookmark-card"]');
await shot(page, '18-bookmarks', { full: true });
await page.goto(`${BASE}/works/11111111-1111-4111-8111-111111111111`);
await page.waitForSelector('[data-testid="work-detail"]');
await shot(page, '19-work-detail-member');

// --- empty states ---
await page.evaluate(() => localStorage.clear());
member = false;
await page.goto(`${BASE}/me/library`);
await shot(page, '20-library-guest');

// --- desktop ---
const wide = await ctx.newPage();
await mock(wide);
await wide.setViewportSize({ width: 1280, height: 900 });
await wide.goto(`${BASE}/`);
await wide.waitForSelector('[data-testid="work-card"]');
await wide.waitForTimeout(400);
await wide.screenshot({ path: `${OUT}/21-catalog-desktop.png` });
console.log(`${OUT}/21-catalog-desktop.png`);

// --- admin ---
member = true; ROLE = 'admin';
await page.route(/^https?:\/\/[^/]+\/api\/admin\//, (route) => {
  const p = new URL(route.request().url()).pathname;
  const json = (b) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  if (p.includes('/taxonomy/categories')) return json({ total: 3, limit: 50, offset: 0, items: CATS });
  if (p.includes('/taxonomy/tags')) return json({ total: 4, limit: 50, offset: 0, items: TAGS });
  return json({ ok: true });
});
await page.goto(`${BASE}/admin`);
await page.waitForTimeout(700);
await shot(page, '22-admin-import', { full: true });
await page.getByRole('tab', { name: '分類標籤' }).click();
await shot(page, '23-admin-taxonomy', { full: true });
await page.getByRole('tab', { name: '發布' }).click();
await shot(page, '24-admin-publish');

await browser.close();
