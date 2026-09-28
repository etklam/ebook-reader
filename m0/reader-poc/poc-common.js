// Shared helpers for the two M0 reader POC pages.
// Positioning model per dev-plan v1.3 §14: chapter (spine index stands in for
// chapter_id in the POC) + paragraph_index. Tap a paragraph to save; reload or
// change typography to verify re-anchoring to the same logical paragraph.

const OPENCC_URL = '/node_modules/opencc-js/dist/esm/full.js';

const posKey = (engine) => `m0-pos-${engine}`;
export function loadPos(engine) {
  try { return JSON.parse(localStorage.getItem(posKey(engine))); } catch { return null; }
}
export function savePos(engine, spineIndex, paraIndex) {
  const pos = { spineIndex, paraIndex, at: Date.now() };
  localStorage.setItem(posKey(engine), JSON.stringify(pos));
  return pos;
}

export const paragraphs = (doc) => [...doc.querySelectorAll('p')];

let opencc;
async function getConverters() {
  if (!opencc) {
    const mod = await import(OPENCC_URL);
    opencc = {
      t2cn: mod.Converter({ from: 't', to: 'cn' }),
      cn2t: mod.Converter({ from: 'cn', to: 't' }),
    };
  }
  return opencc;
}

// textMode: 'original' | 'traditional' | 'simplified'.
// Always derived from the original text (dev-plan §15) — never simp↔trad
// round-tripped. ponytail: textContent-level only; real implementation must
// convert per text node to preserve inline markup/anchors.
export async function applyTextMode(doc, mode) {
  if (mode === 'original') {
    for (const p of paragraphs(doc)) p.textContent = p.dataset.orig;
    return;
  }
  const c = await getConverters();
  const conv = mode === 'simplified' ? c.t2cn : c.cn2t;
  for (const p of paragraphs(doc)) p.textContent = conv(p.dataset.orig);
}

// Give every paragraph a stable id + remember original text; tapping a
// paragraph selects it as the reading position.
export function tagParagraphs(doc, onPick) {
  if (!doc.getElementById('poc-style')) {
    const style = doc.createElement('style');
    style.id = 'poc-style';
    style.textContent = '.poc-para.selected { background: #ffe9a8; }';
    doc.head.append(style);
  }
  paragraphs(doc).forEach((p, i) => {
    p.id = `p${i}`;
    if (!p.dataset.orig) p.dataset.orig = p.textContent;
    p.classList.add('poc-para');
    p.addEventListener('click', () => {
      for (const el of doc.querySelectorAll('.poc-para.selected')) el.classList.remove('selected');
      p.classList.add('selected');
      onPick(i);
    });
  });
}

export const TEXT_MODE_LABEL = { original: '原文', traditional: '繁體', simplified: '簡體' };

export function status(html) {
  document.getElementById('status').innerHTML = html;
}
export function showPos(pos) {
  document.getElementById('pos-display').textContent =
    pos ? `已保存：第 ${pos.spineIndex + 1} 章 · 段 ${pos.paraIndex}` : '未保存位置（點擊段落以保存）';
}
