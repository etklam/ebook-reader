// ReaderContent: renders canonical paragraphs as plain React text nodes —
// no HTML parsing, no dangerouslySetInnerHTML. Canonical content is sanitized
// plain text from the M2 parser, so the trust boundary ends at the string
// (sanitization contract: docs/adr/adr-07-reader-architecture.md).
//
// ADR-08: a paragraph may instead be exactly one block marker. The marker is
// matched with an anchored regex and the hash is looked up in the manifest the
// API sent for *this revision* — an unknown hash renders as nothing rather
// than as a broken image or as the raw marker text. Still no HTML parsing: an
// image block becomes a React <img> with a server-provided URL, never markup
// from the content.
import type { CSSProperties, RefObject } from 'react';
import type { ChapterResource } from '../api/types.ts';

// must stay in sync with server/src/import/blocks.ts
const IMG_RE = /^\[\[img:([0-9a-f]{64})(?:\|([\s\S]*))?\]\]$/;

export function ReaderContent({
  paragraphs,
  resources,
  stripRef,
  stripStyle,
  pageBoxRef,
}: {
  paragraphs: readonly string[];
  resources?: readonly ChapterResource[];
  stripRef: RefObject<HTMLDivElement | null>;
  stripStyle: CSSProperties;
  /** Bounds one page and clips the strip. `display: contents` in scroll mode. */
  pageBoxRef: RefObject<HTMLDivElement | null>;
}) {
  const byHash = new Map((resources ?? []).map((r) => [r.contentHash, r]));

  return (
    <div className="reader-page-box" ref={pageBoxRef}>
    <div id="reader-body" ref={stripRef} style={stripStyle} className="reader-body">
      {paragraphs.map((p, i) => {
        const m = p.match(IMG_RE);
        const resource = m ? byHash.get(m[1]) : undefined;
        if (m && resource) {
          const alt = (m[2] ?? resource.alt ?? '').trim();
          return (
            // the paragraph index is preserved so position anchoring treats an
            // image exactly like any other paragraph (§14)
            <p key={i} data-paragraph-index={i} className="reader-figure">
              <img src={resource.url} alt={alt} loading="lazy" decoding="async" />
              {alt && <span className="reader-figure-caption">{alt}</span>}
            </p>
          );
        }
        if (m) {
          // A marker with no matching manifest entry: the resource did not
          // survive import, or the body is from a different revision than the
          // manifest. Showing the raw "[[img:…]]" text would be worse than an
          // honest placeholder, and dropping the paragraph entirely would
          // shift every later paragraph_index and break saved positions.
          return (
            <p key={i} data-paragraph-index={i} className="reader-figure reader-figure-missing">
              <span className="reader-figure-caption">（圖片無法顯示）</span>
            </p>
          );
        }
        return <p key={i} data-paragraph-index={i}>{p}</p>;
      })}
    </div>
    </div>
  );
}
