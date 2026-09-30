// ReaderContent: renders canonical paragraphs as plain React text nodes —
// no HTML parsing, no dangerouslySetInnerHTML. Canonical content is sanitized
// plain text from the M2 parser, so the trust boundary ends at the string
// (sanitization contract: docs/adr/adr-07-reader-architecture.md).
import type { CSSProperties, RefObject } from 'react';

export function ReaderContent({
  paragraphs,
  stripRef,
  stripStyle,
}: {
  paragraphs: readonly string[];
  stripRef: RefObject<HTMLDivElement | null>;
  stripStyle: CSSProperties;
}) {
  return (
    <div id="reader-body" ref={stripRef} style={stripStyle} className="reader-body">
      {paragraphs.map((p, i) => (
        <p key={i} data-paragraph-index={i}>{p}</p>
      ))}
    </div>
  );
}
