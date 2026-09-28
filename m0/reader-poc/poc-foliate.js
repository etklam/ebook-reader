// foliate-js candidate page. Same feature set as poc-epubjs.js for an
// apples-to-apples M0 comparison (dev-plan v1.3: 同環境、同樣本、同真機).
import './vendor/foliate-js/view.js';
import { loadPos, savePos, applyTextMode, tagParagraphs, status, showPos, TEXT_MODE_LABEL } from './poc-common.js';

const ENGINE = 'foliate';
const EPUB_URL = '../fixtures/sample.epub';

const view = document.createElement('foliate-view');
document.getElementById('viewer').append(view);

let spineIndex = 0;
let textMode = 'original';
let fontSize = 100;
let flow = 'paginated';
let toc = [];

view.addEventListener('load', (e) => {
  const { doc, index } = e.detail;
  spineIndex = index;
  tagParagraphs(doc, (i) => showPos(savePos(ENGINE, spineIndex, i)));
  applyTextMode(doc, textMode);
});

view.addEventListener('relocate', (e) => {
  // the view re-emits `lastLocation`, which does not always carry `index`;
  // only update when present so we don't clobber the value from `load`
  if (typeof e.detail.index === 'number') spineIndex = e.detail.index;
  const label = toc[spineIndex]?.label?.trim() ?? `spine ${spineIndex + 1}`;
  status(`foliate-js｜${label}（${spineIndex + 1}/${view.book.sections.length}）`);
});

function flattenToc(items, out = []) {
  for (const item of items ?? []) {
    out.push(item);
    flattenToc(item.subitems, out);
  }
  return out;
}

function reAnchor() {
  const saved = loadPos(ENGINE);
  const para = saved && saved.spineIndex === spineIndex ? saved.paraIndex : null;
  const href = view.book.sections[spineIndex]?.id; // section.id is the href
  if (!href) return;
  view.goTo(para !== null ? `${href}#p${para}` : href).catch(() => view.goTo(spineIndex));
}

await view.open(EPUB_URL);
toc = flattenToc(view.book.toc);

const panel = document.getElementById('toc-panel');
panel.innerHTML = toc
  .map((item) => `<button data-href="${item.href}">${item.label?.trim() ?? item.href}</button>`)
  .join('');
panel.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  panel.hidden = true;
  view.goTo(b.dataset.href).catch(console.error);
});

const saved = loadPos(ENGINE);
if (saved && view.book.sections[saved.spineIndex]) {
  const href = view.book.sections[saved.spineIndex].id;
  await view.goTo(`${href}#p${saved.paraIndex}`).catch(() => view.goTo(saved.spineIndex));
} else {
  await view.goTo(0);
}

const on = (id, fn) => document.getElementById(id).addEventListener('click', fn);

on('prev-ch', () => { if (spineIndex > 0) view.goTo(spineIndex - 1); });
on('next-ch', () => { if (spineIndex < view.book.sections.length - 1) view.goTo(spineIndex + 1); });
on('toc', () => { panel.hidden = false; });

on('text-mode', async () => {
  const order = ['original', 'traditional', 'simplified'];
  textMode = order[(order.indexOf(textMode) + 1) % order.length];
  document.getElementById('text-mode').textContent = TEXT_MODE_LABEL[textMode];
  for (const { doc } of view.renderer.getContents()) await applyTextMode(doc, textMode);
  reAnchor();
});

on('flow', () => {
  flow = flow === 'paginated' ? 'scrolled' : 'paginated';
  document.getElementById('flow').textContent = flow === 'paginated' ? '分頁' : '捲動';
  view.renderer.setAttribute('flow', flow);
  reAnchor();
});

on('font-dec', () => {
  fontSize = Math.max(70, fontSize - 12.5);
  view.renderer.setStyles?.(`html { font-size: ${fontSize}%; }`);
  reAnchor();
});
on('font-inc', () => {
  fontSize = Math.min(200, fontSize + 12.5);
  view.renderer.setStyles?.(`html { font-size: ${fontSize}%; }`);
  reAnchor();
});
