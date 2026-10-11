// Loading placeholders shaped like the rows they replace, so arriving content
// causes no layout shift and no spinner ever sits in the middle of the page.
// aria-hidden with a single live-region label per list keeps SR output sane.

export function SkeletonRows({ count = 5, label = '載入中' }: { count?: number; label?: string }) {
  return (
    <div className="rows" role="status" aria-label={label} data-testid="skeleton-rows">
      {Array.from({ length: count }, (_, i) => (
        <div className="row" key={i} aria-hidden="true">
          <div className="row-main">
            <div className="sk sk-line" style={{ width: `${54 + ((i * 13) % 30)}%`, height: '1.1em' }} />
            <div className="row-sub">
              <div className="sk sk-line" style={{ width: '28%' }} />
              <div className="sk sk-line" style={{ width: `${62 + ((i * 7) % 24)}%` }} />
            </div>
          </div>
          <div className="row-rail">
            <div className="sk sk-line" style={{ width: 38 }} />
            <div className="sk sk-line" style={{ width: 54 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// Evenly spaced lines, for lists whose rows are a single line of text (the
// table of contents). Three surfaces hand-rolled this with inline styles;
// one component keeps the rhythm identical in all of them.
export function SkeletonLines({ count = 8, label = '載入中' }: { count?: number; label?: string }) {
  return (
    <div className="sk-lines" role="status" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <div className="sk sk-line" key={i} aria-hidden="true" />
      ))}
    </div>
  );
}

// Colophon-shaped placeholder for the work page: title, author, then the
// metadata rows, at the sizes the real content uses.
export function SkeletonDetail() {
  return (
    <div className="sk-detail" role="status" aria-label="載入作品">
      <div className="sk sk-line sk-title" style={{ width: '62%' }} aria-hidden="true" />
      <div className="sk sk-line" style={{ width: '28%' }} aria-hidden="true" />
      <div className="sk-lines" aria-hidden="true">
        {['40%', '55%', '48%', '60%'].map((w) => (
          <div className="sk sk-line" key={w} style={{ width: w }} />
        ))}
      </div>
    </div>
  );
}

// Chapter-shaped placeholder for the reader: paragraph-length lines in the
// prose measure, so the first real paragraph lands where the eye already is.
export function SkeletonChapter() {
  const widths = ['92%', '100%', '97%', '64%', '100%', '95%', '99%', '48%', '100%', '91%'];
  return (
    <div className="reader-skeleton" role="status" aria-label="載入章節">
      {widths.map((w, i) => (
        <div className="sk sk-line" key={i} style={{ width: w }} aria-hidden="true" />
      ))}
    </div>
  );
}
