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
