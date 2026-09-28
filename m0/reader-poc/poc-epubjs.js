// epub.js candidate page. Engine is used only as renderer/positioner; the
// chapter model, paragraph tagging and persistence live in our code (ReaderAdapter
// boundary per dev-plan §16).
import { loadPos, savePos, applyTextMode, tagParagraphs, status, showPos, TEXT_MODE_LABEL } from './poc-common.js';

const ENGINE = 'epubjs';
const EPUB_URL = '../fixtures/sample.epub';

const book = ePub(EPUB_URL);
const rendition = book.renderTo(document.getElementById('viewer'), {
  flow: 'paginated', width: '100%', height: '100%', spread: 'none',
});

let spineIndex = 0;
let textMode = 'original';
let fontSize = 100; // percent
let toc = [];
let flow = 'paginated';

const anchorPara = () => {
  const saved = loadPos(ENGINE);
  return saved && saved.spineIndex === spineIndex ? saved.paraIndex : null;
};

// Re-display current chapter anchored to the saved paragraph — used after
// flow / font-size / text-mode changes (READ-01: 回到同一邏輯段落).
function reAnchor() {
  const para = anchorPara();
  const href = book.spine.get(spineIndex)?.href;
  if (!href) return;
  rendition.display(para !== null ? `${href}#p${para}` : href);
}

rendition.hooks.content.register((contents) => {
  const doc = contents.document;
  tagParagraphs(doc, (i) => showPos(savePos(ENGINE, spineIndex, i)));
  applyTextMode(doc, textMode);
});

rendition.on('relocated', (loc) => {
  spineIndex = loc.start.index;
  const label = toc[spineIndex]?.label?.trim() ?? `spine ${spineIndex + 1}`;
  status(`epub.js｜${label}（${spineIndex + 1}/${book.spine.length}）`);
});

book.ready.then(async () => {
  const nav = await book.loaded.navigation;
  toc = nav.toc;
  const panel = document.getElementById('toc-panel');
  panel.innerHTML = toc
    .map((item) => `<button data-href="${item.href}">${item.label.trim()}</button>`)
    .join('');
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    panel.hidden = true;
    rendition.display(b.dataset.href);
  });

  const saved = loadPos(ENGINE);
  if (saved && book.spine.get(saved.spineIndex)) {
    rendition.display(`${book.spine.get(saved.spineIndex).href}#p${saved.paraIndex}`);
  } else {
    rendition.display();
  }
});

const on = (id, fn) => document.getElementById(id).addEventListener('click', fn);

on('prev-ch', () => { if (spineIndex > 0) rendition.display(spineIndex - 1); });
on('next-ch', () => { if (spineIndex < book.spine.length - 1) rendition.display(spineIndex + 1); });
on('toc', () => { document.getElementById('toc-panel').hidden = false; });

on('text-mode', async () => {
  const order = ['original', 'traditional', 'simplified'];
  textMode = order[(order.indexOf(textMode) + 1) % order.length];
  document.getElementById('text-mode').textContent = TEXT_MODE_LABEL[textMode];
  await Promise.all(rendition.getContents().map((c) => applyTextMode(c.document, textMode)));
  reAnchor();
});

on('flow', () => {
  flow = flow === 'paginated' ? 'scrolled' : 'paginated';
  document.getElementById('flow').textContent = flow === 'paginated' ? '分頁' : '捲動';
  rendition.flow(flow);
  reAnchor();
});

on('font-dec', () => { fontSize = Math.max(70, fontSize - 12.5); rendition.themes.fontSize(`${fontSize}%`); reAnchor(); });
on('font-inc', () => { fontSize = Math.min(200, fontSize + 12.5); rendition.themes.fontSize(`${fontSize}%`); reAnchor(); });
