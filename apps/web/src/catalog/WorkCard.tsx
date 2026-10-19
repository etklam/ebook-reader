// A catalog entry, set as a ruled index row rather than a card: title on the
// left edge, its apparatus hanging under it, status and tabular counts in a
// right rail so a reader scanning forty works can compare down a column.
// Metadata only — no bodies, no admin internals.
import type { CatalogWork } from '../api/types.ts';
import { t } from '../i18n/translate.ts';
import { statusLabel, typeLabel, count, relativeDay } from '../lib/format.ts';

export function WorkCard({ work, onOpen }: { work: CatalogWork; onOpen(): void }) {
  const status = work.serialStatus ? statusLabel(work.serialStatus) : typeLabel(work.workType);
  return (
    <button className="row" onClick={onOpen} data-testid="work-card">
      <span className="row-main">
        <span className="row-title">{work.title}</span>
        <span className="row-sub">
          <span className="row-author">{work.author || t('佚名')}</span>
          {work.description && <span className="row-desc">{work.description}</span>}
          {work.categories.length > 0 && (
            <span className="row-meta">{work.categories.join(' · ')}</span>
          )}
          {work.tags.length > 0 && (
            <span className="row-tags">{work.tags.map((tag) => `#${tag}`).join(' ')}</span>
          )}
        </span>
      </span>
      <span className="row-rail">
        <span className={work.serialStatus === 'ongoing' ? 'status status-ongoing' : 'status'}>
          {status}
        </span>
        <span className="row-count">{t('{n} 章', { n: count(work.chapterCount) })}</span>
        <span>{relativeDay(work.latestPublishedAt)}</span>
      </span>
    </button>
  );
}
