// Per-route document head (SEO §03B): title, description, canonical, Open
// Graph, robots.
//
// index.html ships one static <title>書庫 and one description for every route,
// so until now a crawler saw the same two lines on the catalogue, on every work
// and on every chapter — and a search result for a novel was titled "書庫".
// This module rewrites them per route.
//
// It is plain DOM, not a framework: the whole app is one <div id="root"> and
// these tags live outside it, so React cannot own them. Every tag written here
// is marked `data-head`; the next route overwrites the tags it sets and deletes
// the marked ones it does not, so a route that omits a field cannot inherit the
// previous route's value.
//
// Honest limitation: this runs after the JS loads. Googlebot renders and will
// see it; crawlers that do not execute JavaScript (Baidu, most social-card
// scrapers) see only index.html. Fixing that needs server-rendered or
// prerendered HTML, which is a separate piece of work.

import { currentLocale, t } from '../i18n/translate.ts';

export interface HeadInfo {
  /** full <title>; callers add the site suffix via `title()` */
  title: string;
  description?: string;
  /** path, not URL — the origin is taken from the browser so staging and
   *  production each canonicalize to themselves */
  canonicalPath?: string;
  /** keep the page out of the index: personalized or private routes */
  noindex?: boolean;
  ogType?: 'website' | 'article' | 'book';
}

const MARK = 'data-head';

/** The site name follows the UI language: the tab title and the share card are
 *  part of the interface, not part of an author's text. */
const site = () => t('書庫');

/** `<page> · 書庫`, or just the site name for the catalogue itself. */
export function title(page?: string): string {
  const trimmed = page?.trim();
  return trimmed ? `${trimmed} · ${site()}` : site();
}

export function applyHead(info: HeadInfo): void {
  if (typeof document === 'undefined') return;
  document.title = info.title;

  const canonical = info.canonicalPath
    ? new URL(info.canonicalPath, location.origin).href
    : null;

  const tags: Array<{ selector: string; el: () => Element }> = [];
  const metaTag = (attr: 'name' | 'property', key: string, content: string) => {
    tags.push({
      selector: `meta[${attr}="${key}"]`,
      el: () => {
        const el = document.createElement('meta');
        el.setAttribute(attr, key);
        el.setAttribute('content', content);
        return el;
      },
    });
  };

  if (info.description) metaTag('name', 'description', info.description);
  // 'noindex' alone would still let a crawler follow the links out of a
  // member page, which is wanted: those links point at public works.
  if (info.noindex) metaTag('name', 'robots', 'noindex, follow');
  if (canonical) {
    tags.push({
      selector: 'link[rel="canonical"]',
      el: () => {
        const el = document.createElement('link');
        el.setAttribute('rel', 'canonical');
        el.setAttribute('href', canonical);
        return el;
      },
    });
  }

  // Open Graph — what a shared link looks like in a chat or a feed. og:title
  // deliberately drops the site suffix: the card already shows og:site_name.
  metaTag('property', 'og:site_name', site());
  metaTag('property', 'og:type', info.ogType ?? 'website');
  metaTag('property', 'og:title', info.title.replace(` · ${site()}`, ''));
  if (info.description) metaTag('property', 'og:description', info.description);
  if (canonical) metaTag('property', 'og:url', canonical);
  metaTag('property', 'og:locale', currentLocale().replace('-', '_'));
  metaTag('name', 'twitter:card', 'summary');

  // Drop anything this module wrote for the previous route that the new one
  // does not set, so no page can inherit another page's description.
  const keep = new Set(tags.map((t) => t.selector));
  for (const el of document.querySelectorAll(`[${MARK}]`)) {
    if (![...keep].some((s) => el.matches(s))) el.remove();
  }
  // Upsert rather than replace: index.html ships a static description for the
  // crawlers that never run this code, and two description tags is worse than
  // either one alone.
  for (const { selector, el } of tags) {
    const next = el();
    next.setAttribute(MARK, '');
    const existing = document.head.querySelector(selector);
    if (existing) existing.replaceWith(next);
    else document.head.append(next);
  }
}

/**
 * Trim prose to a meta-description length. Counted in characters, not bytes:
 * the limit search engines apply is a pixel width, and for CJK ~80 characters
 * is already past where every engine truncates.
 */
export function describe(...parts: Array<string | null | undefined>): string {
  const text = parts.map((p) => (p ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join('　');
  return text.length > 150 ? `${text.slice(0, 149)}…` : text;
}

