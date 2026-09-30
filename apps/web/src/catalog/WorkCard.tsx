// Catalog work card: metadata only — no bodies, no admin internals.
import type { CatalogWork } from '../api/types.ts';

const TYPE_LABEL = { serial: '連載', short_story: '短篇' } as const;
const STATUS_LABEL = { ongoing: '連載中', completed: '已完結', paused: '暫停' } as const;

export function WorkCard({ work, onOpen }: { work: CatalogWork; onOpen(): void }) {
  return (
    <button className="work-card" onClick={onOpen} data-testid="work-card">
      <div className="work-card-body">
        <span className="work-title">{work.title}</span>
        {work.author && <span className="work-author">{work.author}</span>}
        {work.description && <span className="work-desc">{work.description.slice(0, 60)}{work.description.length > 60 ? '…' : ''}</span>}
        <span className="work-meta">
          {TYPE_LABEL[work.workType]}
          {work.serialStatus ? ` · ${STATUS_LABEL[work.serialStatus]}` : ''}
          {` · ${work.chapterCount} 章`}
          {work.categories.length > 0 && ` · ${work.categories.join('、')}`}
        </span>
        {work.tags.length > 0 && <span className="work-tags">{work.tags.map((t) => `#${t}`).join(' ')}</span>}
      </div>
    </button>
  );
}
