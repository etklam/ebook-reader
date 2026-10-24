// head.ts is the only thing deciding what a crawler reads on any route, and it
// is plain DOM, so it is testable with a stub rather than a browser. The cases
// that earn this file are the cross-route ones: the module's whole job is that
// one route cannot inherit another route's description, canonical or Book node.
//
// Run: pnpm --filter web test
import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- minimal DOM ------------------------------------------------------------
// Only what head.ts touches: attribute selectors on meta/link/script, plus
// [data-head]. A real DOM here would hide nothing and cost a dependency.
type Sel = { tag: string | null; attrs: Array<[string, string | null]> };

function parseSelector(selector: string): Sel {
  const tag = /^[a-z]+/.exec(selector)?.[0] ?? null;
  const attrs: Array<[string, string | null]> = [];
  for (const m of selector.matchAll(/\[([a-zA-Z-]+)(?:="([^"]*)")?\]/g)) {
    attrs.push([m[1], m[2] ?? null]);
  }
  return { tag, attrs };
}

class El {
  tagName: string;
  textContent = '';
  parent: Head | null = null;
  private attrs = new Map<string, string>();
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  setAttribute(key: string, value: string) { this.attrs.set(key, String(value)); }
  getAttribute(key: string) { return this.attrs.get(key) ?? null; }
  matches(selector: string) {
    const { tag, attrs } = parseSelector(selector);
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    return attrs.every(([k, v]) => this.attrs.has(k) && (v === null || this.attrs.get(k) === v));
  }
  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }
  replaceWith(next: El) {
    const head = this.parent;
    if (!head) return;
    head.children = head.children.map((c) => (c === this ? next : c));
    next.parent = head;
    this.parent = null;
  }
}

class Head {
  children: El[] = [];
  append(el: El) { el.parent = this; this.children.push(el); }
  querySelector(selector: string) { return this.children.find((c) => c.matches(selector)) ?? null; }
  querySelectorAll(selector: string) { return this.children.filter((c) => c.matches(selector)); }
}

/** Fresh document with index.html's static description already in place, then
 *  a fresh import of head.ts — `staticDescription` is captured at module load,
 *  so the import has to happen after the stub exists. */
async function freshHead(staticDescription: string | null = '靜態站級描述') {
  const head = new Head();
  if (staticDescription !== null) {
    const meta = new El('meta');
    meta.setAttribute('name', 'description');
    meta.setAttribute('content', staticDescription);
    head.append(meta);
  }
  const doc = {
    title: '書庫',
    head,
    createElement: (tag: string) => new El(tag),
    querySelectorAll: (selector: string) => head.querySelectorAll(selector),
  };
  const g = globalThis as Record<string, unknown>;
  g.document = doc;
  g.location = { origin: 'https://books.example.test' };
  const mod = await import(`./head.ts?fresh=${Math.random()}`);
  return { doc, head, ...(mod as typeof import('./head.ts')) };
}

const content = (head: Head, selector: string) => head.querySelector(selector)?.getAttribute('content') ?? null;

// --- title ------------------------------------------------------------------

test('the catalogue is the bare site name; every other page carries the suffix', async () => {
  const { doc, applyHead } = await freshHead();
  applyHead({});
  assert.equal(doc.title, '書庫');
  applyHead({ page: '排行榜' });
  assert.equal(doc.title, '排行榜 · 書庫');
});

test('og:title drops the suffix without string surgery on the title itself', async () => {
  const { head, applyHead } = await freshHead();
  // a book whose own title contains the site name used to be cut in half by
  // reconstructing og:title via title.replace(' · 書庫', '')
  applyHead({ page: '書庫 · 書庫之謎 - 某作者' });
  assert.equal(content(head, 'meta[property="og:title"]'), '書庫 · 書庫之謎 - 某作者');
  applyHead({});
  assert.equal(content(head, 'meta[property="og:title"]'), '書庫');
});

// --- canonical and robots ---------------------------------------------------

test('canonical is absolute against the current origin, and absent when unset', async () => {
  const { head, applyHead } = await freshHead();
  applyHead({ page: '劍來', canonicalPath: '/works/劍來-a1b2c3d4' });
  assert.equal(head.querySelector('link[rel="canonical"]')?.getAttribute('href'),
    'https://books.example.test/works/%E5%8A%8D%E4%BE%86-a1b2c3d4');
  assert.equal(content(head, 'meta[property="og:url"]'),
    'https://books.example.test/works/%E5%8A%8D%E4%BE%86-a1b2c3d4');

  applyHead({ page: '登入', noindex: true });
  assert.equal(head.querySelector('link[rel="canonical"]'), null, 'canonical must not survive');
  assert.equal(content(head, 'meta[property="og:url"]'), null);
  assert.equal(content(head, 'meta[name="robots"]'), 'noindex, follow');
});

test('robots noindex is dropped again when the next route is indexable', async () => {
  const { head, applyHead } = await freshHead();
  applyHead({ page: '登入', noindex: true });
  assert.equal(content(head, 'meta[name="robots"]'), 'noindex, follow');
  applyHead({ page: '排行榜', canonicalPath: '/rankings' });
  assert.equal(head.querySelector('meta[name="robots"]'), null);
});

// --- description ------------------------------------------------------------

test('a route without a description falls back to the static site line, never to none', async () => {
  const { head, applyHead } = await freshHead('靜態站級描述');
  applyHead({ page: '某書', description: '某書的簡介' });
  assert.equal(content(head, 'meta[name="description"]'), '某書的簡介');
  // /login has no description of its own: the site-level floor is correct, and
  // inheriting 某書的簡介 would not be
  applyHead({ page: '登入', noindex: true });
  assert.equal(content(head, 'meta[name="description"]'), '靜態站級描述');
  assert.equal(content(head, 'meta[property="og:description"]'), '靜態站級描述');
  // exactly one description tag, always
  assert.equal(head.querySelectorAll('meta[name="description"]').length, 1);
});

test('with no static description in index.html a description-less route has none', async () => {
  const { head, applyHead } = await freshHead(null);
  applyHead({ page: '登入', noindex: true });
  assert.equal(head.querySelector('meta[name="description"]'), null);
});

test('one route never inherits another route description', async () => {
  const { head, applyHead } = await freshHead(null);
  applyHead({ page: '甲書', description: '甲的簡介' });
  applyHead({ page: '乙書', description: '乙的簡介' });
  assert.equal(content(head, 'meta[name="description"]'), '乙的簡介');
  assert.equal(head.querySelectorAll('meta[name="description"]').length, 1);
});

// --- structured data --------------------------------------------------------

test('a Book node is written, escaped, and does not outlive its page', async () => {
  const { head, applyHead } = await freshHead();
  applyHead({
    page: '劍來', canonicalPath: '/works/x-a1b2c3d4', ogType: 'book',
    jsonLd: { '@context': 'https://schema.org', '@type': 'Book', name: '劍來 </script><b>' },
  });
  const script = head.querySelector('script[type="application/ld+json"]');
  assert.ok(script, 'the graph is written');
  assert.ok(!script!.textContent.includes('</script>'), '< is escaped for any later serialization');
  const parsed = JSON.parse(script!.textContent) as { '@type': string; name: string };
  assert.equal(parsed['@type'], 'Book');
  assert.equal(parsed.name, '劍來 </script><b>', 'escaping is reversible, not lossy');

  // an unlisted work, or any route with no graph, must not keep this one
  applyHead({ page: '登入', noindex: true });
  assert.equal(head.querySelector('script[type="application/ld+json"]'), null);
});

test('absoluteUrl resolves against the current origin', async () => {
  const { absoluteUrl } = await freshHead();
  assert.equal(absoluteUrl('/rankings'), 'https://books.example.test/rankings');
});

// --- describe ---------------------------------------------------------------

test('describe joins parts, collapses whitespace and truncates at a readable length', async () => {
  const { describe } = await freshHead();
  assert.equal(describe('甲', null, '  乙\n丙 '), '甲　乙 丙');
  assert.equal(describe(null, undefined, ''), '');
  const long = describe('長'.repeat(300));
  assert.equal(long.length, 150);
  assert.ok(long.endsWith('…'));
});
