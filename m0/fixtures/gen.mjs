// Synthetic TXT/EPUB fixtures for M0 acceptance (IMP-01..IMP-09, IMP-15, IMP-16).
// Deterministic: same seed -> same bytes, so golden hashes stay stable.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const OUT = new URL('.', import.meta.url).pathname;
const TXT_DIR = join(OUT, 'txt');
const EPUB_STAGE = join(OUT, 'epub-stage');
const EPUB_OUT = join(OUT, 'sample.epub');
const EPUB_IMG_STAGE = join(OUT, 'epub-img-stage');
const EPUB_IMG_OUT = join(OUT, 'sample-illustrated.epub');
const EPUB_IMG_V2_OUT = join(OUT, 'sample-illustrated-v2.epub');

// --- deterministic pseudo-content -------------------------------------------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLAUSES = [
  '他沿著舊城的天橋走了一段', '風把紙屑吹向對街的騎樓', '她收起傘，抬頭看見雲層裂開一道縫',
  '巷口的燈在雨後亮得刺眼', '時間像被誰按了慢放', '記憶裡的聲音比畫面先回來',
  '他把外套的領口豎起來', '遠處傳來末班列車的聲音', '牆上的裂痕長得像一條河',
  '她說完這句話就沉默了', '咖啡涼了，他也沒有喝', '樓梯間的回音持續了很久',
];
const ENDINGS = ['。', '，然後什麼都沒有發生。', '，像所有平凡的日子一樣。', '，卻改變了之後的所有事。', '。沒有人注意到。'];

function paragraph(rand) {
  const n = 2 + Math.floor(rand() * 3);
  let s = '';
  for (let i = 0; i < n; i++) s += CLAUSES[Math.floor(rand() * CLAUSES.length)] + (i < n - 1 ? '，' : '');
  return s + ENDINGS[Math.floor(rand() * ENDINGS.length)];
}

function chapterBody(num, variant) {
  const rand = mulberry32(num * 7919 + (variant === 'v2' ? 104729 : 0));
  const paras = [];
  const count = 8 + Math.floor(rand() * 5); // 8–12 paragraphs
  for (let i = 0; i < count; i++) paras.push(paragraph(rand));
  return paras;
}

function chapterHeader(label, title) {
  return `${label} ${title}`;
}

const TITLES = ['起風', '霧中燈', '未寄出的信', '長夜', '潮汐', '舊鑰匙', '折返點', '靜水深流', '殘響', '破曉'];

function txtChapter(label, title, num, variant) {
  const header = chapterHeader(label, title);
  const body = chapterBody(num, variant);
  return [header, '', ...body].join('\n\n') + '\n';
}

const label = (n) => `第${n}章`;
const title = (n) => TITLES[(n - 1) % TITLES.length];

function buildTxt(chapters) {
  // chapters: array of {label, title, num, variant}
  return chapters.map((c) => txtChapter(c.label, c.title ?? title(c.num), c.num, c.variant)).join('\n');
}

const range = (from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ num: from + i, label: label(from + i) }));

// Revised chapters in the 1–190 file vs the original 1–180 (IMP-03: exactly 4)
const REVISED = new Set([101, 102, 103, 104]);

// full-190: chapters 101–104 use variant v2 (revised content, IMP-03)
const files = {
  'base-180.txt': buildTxt(range(1, 180)),
  'full-190.txt': buildTxt([
    ...range(1, 87), // §24 shape: 1–190 INCLUDING 87, plus 87.5 inserted
    { num: 87.5, label: '第87.5章', title: '插章' },
    ...Array.from({ length: 190 - 88 + 1 }, (_, i) => {
      const num = 88 + i;
      return REVISED.has(num) ? { num, label: label(num), variant: 'v2' } : { num, label: label(num) };
    }),
  ]),
  'partial-181-190.txt': buildTxt(range(181, 190)),
  'partial-1-170.txt': buildTxt(range(1, 170)),
  'weird-labels.txt': buildTxt([
    { num: 1, label: '序章', title: '雨前' },
    { num: 2, label: '第12.5章', title: '岔路' },
    { num: 3, label: '第12.10章', title: '疊影' },
    { num: 4, label: '第12.5.1章', title: '夾層' },
    { num: 5, label: '第12章（上）', title: '對峙' },
    { num: 6, label: '第12章（下）', title: '收束' },
    { num: 7, label: '第012章', title: '舊檔' },
    { num: 8, label: '番外1.5', title: '他鄉' },
    { num: 9, label: '風起', title: '' },
    { num: 10, label: '終章', title: '天光' },
  ]),
};

mkdirSync(TXT_DIR, { recursive: true });
for (const [name, content] of Object.entries(files)) {
  writeFileSync(join(TXT_DIR, name), content, 'utf8');
}

// --- minimal reflowable EPUB 3 ----------------------------------------------
// Spine order intentionally differs from file-name order (IMP-16: spine wins).
// Logical reading order: c4, c1, c2, c5, c3
const SPINE = ['c4', 'c1', 'c2', 'c5', 'c3'];
const epubChapters = SPINE.map((file, i) => ({
  file,
  title: `第${i + 1}章 ${title(i + 1)}`,
  body: chapterBody(9000 + i, 'v1'),
}));

rmSync(EPUB_STAGE, { recursive: true, force: true });
mkdirSync(join(EPUB_STAGE, 'META-INF'), { recursive: true });
mkdirSync(join(EPUB_STAGE, 'OEBPS'), { recursive: true });

writeFileSync(join(EPUB_STAGE, 'mimetype'), 'application/epub+zip');
writeFileSync(
  join(EPUB_STAGE, 'META-INF', 'container.xml'),
  `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`
);
writeFileSync(
  join(EPUB_STAGE, 'OEBPS', 'nav.xhtml'),
  `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目錄</title></head>
<body>
  <nav epub:type="toc"><h1>目錄</h1><ol>
    ${epubChapters.map((c, i) => `<li><a href="${c.file}.xhtml">${c.title}</a></li>`).join('\n    ')}
  </ol></nav>
</body></html>`
);
for (const c of epubChapters) {
  writeFileSync(
    join(EPUB_STAGE, 'OEBPS', `${c.file}.xhtml`),
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>${c.title}</title></head>
<body>
  <h1>${c.title}</h1>
  ${c.body.map((p) => `<p>${p}</p>`).join('\n  ')}
</body></html>`
  );
}
writeFileSync(
  join(EPUB_STAGE, 'OEBPS', 'content.opf'),
  `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0</dc:identifier>
    <dc:title>合成樣本小說</dc:title>
    <dc:language>zh-Hant</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${epubChapters.map((c) => `<item id="${c.file}" href="${c.file}.xhtml" media-type="application/xhtml+xml"/>`).join('\n    ')}
  </manifest>
  <spine>
    ${SPINE.map((f) => `<itemref idref="${f}"/>`).join('\n    ')}
  </spine>
</package>`
);

// zip: mimetype first, stored uncompressed (EPUB spec)
execFileSync('zip', ['-X', '-0', EPUB_OUT, 'mimetype'], { cwd: EPUB_STAGE });
execFileSync('zip', ['-X', '-9', EPUB_OUT, '-r', 'META-INF', 'OEBPS'], { cwd: EPUB_STAGE });
rmSync(EPUB_STAGE, { recursive: true, force: true });

// --- illustrated EPUB (ADR-08 / IMP-17) --------------------------------------
// Exercises: image extraction + ordering, a shared image referenced twice
// (content-addressed dedupe), footnotes (aside + noteref), an unsupported SVG
// (must warn and be skipped, never silently dropped), and — in the v2 build —
// one chapter whose PROSE IS IDENTICAL but whose image differs, which is the
// IMP-17 case that resource-aware revision detection exists for.

// Deterministic 1x1 PNGs differing only in colour, so the bytes (and therefore
// the content hash) differ while the files stay tiny.
function onePixelPng(r, g, b) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const byte of body) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // zlib stream for one uncompressed scanline: filter byte + RGB
  const raw = Buffer.from([0x00, r, g, b]);
  const adler = (buf) => {
    let a = 1, b2 = 0;
    for (const byte of buf) { a = (a + byte) % 65521; b2 = (b2 + a) % 65521; }
    return ((b2 << 16) | a) >>> 0;
  };
  const len = Buffer.alloc(4);
  len.writeUInt16LE(raw.length, 0);
  len.writeUInt16LE(~raw.length & 0xffff, 2);
  const adlerBuf = Buffer.alloc(4);
  adlerBuf.writeUInt32BE(adler(raw));
  const idat = Buffer.concat([Buffer.from([0x78, 0x01, 0x01]), len, raw, adlerBuf]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const PNG_A = onePixelPng(220, 40, 40);    // plate-a
const PNG_B = onePixelPng(40, 220, 40);    // plate-b
const PNG_C = onePixelPng(40, 40, 220);    // plate-b replacement in v2
const SVG_UNSUPPORTED = Buffer.from(
  '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>', 'utf8');

function buildIllustratedEpub(stage, out, plateB) {
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(join(stage, 'META-INF'), { recursive: true });
  mkdirSync(join(stage, 'OEBPS', 'images'), { recursive: true });

  writeFileSync(join(stage, 'mimetype'), 'application/epub+zip');
  writeFileSync(join(stage, 'META-INF', 'container.xml'),
    `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
  writeFileSync(join(stage, 'OEBPS', 'images', 'plate-a.png'), PNG_A);
  writeFileSync(join(stage, 'OEBPS', 'images', 'plate-b.png'), plateB);
  writeFileSync(join(stage, 'OEBPS', 'images', 'ornament.svg'), SVG_UNSUPPORTED);

  const chapters = [
    {
      file: 'i1',
      label: '第1章',
      title: '插圖一',
      // prose identical across both builds; only the image differs in v2
      xhtml: `
  <h1>第1章 插圖一</h1>
  <p>他沿著舊城的天橋走了一段，風把紙屑吹向對街的騎樓。</p>
  <p><img src="images/plate-b.png" alt="天橋遠景"/></p>
  <p>巷口的燈在雨後亮得刺眼。</p>`,
    },
    {
      file: 'i2',
      label: '第2章',
      title: '插圖二',
      // same image twice + once more in another chapter: dedupe by content hash
      xhtml: `
  <h1>第2章 插圖二</h1>
  <p>她收起傘，抬頭看見雲層裂開一道縫。</p>
  <p><img src="images/plate-a.png" alt="雲隙"/></p>
  <p>記憶裡的聲音比畫面先回來<a epub:type="noteref" href="#fn1">1</a>。</p>
  <p><img src="images/plate-a.png" alt="雲隙"/></p>
  <p><img src="images/ornament.svg" alt="裝飾"/></p>
  <aside epub:type="footnote" id="fn1"><p>這是第一條註腳的內容。</p></aside>`,
    },
    {
      file: 'i3',
      label: '第3章',
      title: '插圖三',
      xhtml: `
  <h1>第3章 插圖三</h1>
  <p>時間像被誰按了慢放<a epub:type="noteref" href="#fn2">2</a>。</p>
  <p><img src="images/plate-a.png" alt="再次出現"/></p>
  <aside epub:type="footnote" id="fn2"><p>第二條註腳，說明前段的時間感。</p></aside>`,
    },
  ];

  writeFileSync(join(stage, 'OEBPS', 'nav.xhtml'),
    `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>目錄</title></head>
<body>
  <nav epub:type="toc"><h1>目錄</h1><ol>
    ${chapters.map((c) => `<li><a href="${c.file}.xhtml">${c.label} ${c.title}</a></li>`).join('\n    ')}
  </ol></nav>
</body></html>`);

  for (const c of chapters) {
    writeFileSync(join(stage, 'OEBPS', `${c.file}.xhtml`),
      `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${c.label} ${c.title}</title></head>
<body>${c.xhtml}
</body></html>`);
  }

  writeFileSync(join(stage, 'OEBPS', 'content.opf'),
    `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:11112222-3333-4444-5555-666677778888</dc:identifier>
    <dc:title>合成插圖樣本</dc:title>
    <dc:language>zh-Hant</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    ${chapters.map((c) => `<item id="${c.file}" href="${c.file}.xhtml" media-type="application/xhtml+xml"/>`).join('\n    ')}
    <item id="imga" href="images/plate-a.png" media-type="image/png"/>
    <item id="imgb" href="images/plate-b.png" media-type="image/png"/>
    <item id="orn" href="images/ornament.svg" media-type="image/svg+xml"/>
  </manifest>
  <spine>
    ${chapters.map((c) => `<itemref idref="${c.file}"/>`).join('\n    ')}
  </spine>
</package>`);

  rmSync(out, { force: true });
  execFileSync('zip', ['-X', '-0', out, 'mimetype'], { cwd: stage });
  execFileSync('zip', ['-X', '-9', out, '-r', 'META-INF', 'OEBPS'], { cwd: stage });
  rmSync(stage, { recursive: true, force: true });
}

buildIllustratedEpub(EPUB_IMG_STAGE, EPUB_IMG_OUT, PNG_B);
// v2: chapter 1's prose is byte-identical, its image is not (IMP-17)
buildIllustratedEpub(EPUB_IMG_STAGE, EPUB_IMG_V2_OUT, PNG_C);

console.log('fixtures written to', TXT_DIR);
console.log('epub written to', EPUB_OUT);
console.log('illustrated epub written to', EPUB_IMG_OUT, 'and', EPUB_IMG_V2_OUT);
