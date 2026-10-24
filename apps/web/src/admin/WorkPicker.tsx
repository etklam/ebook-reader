// Pick an existing work by searching for it (RV-011).
//
// The import panel used to ask for the target work as a hand-typed UUID, and a
// work's UUID is shown in exactly one place in the whole admin UI (the batch
// import result list), so "update an existing work" was effectively
// unreachable — and the alternative, re-importing as a NEW work, produces a
// duplicate that splits the readers' progress and the sitemap.
//
// Same contract as the publish panel's own selector: /api/admin/works returns
// the 50 most recent matches and never 'removed' works, so a narrow keyword is
// how an admin reaches an older book.
import { useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { t } from '../i18n/translate.ts';

export type WorkOption = { id: string; title: string; author: string | null; activeReleaseId: string | null };

export function WorkPicker({ idPrefix, value, onChange, disabled, refreshVersion = 0 }: {
  idPrefix: string;
  value: string;
  onChange(workId: string): void;
  disabled?: boolean;
  refreshVersion?: number;
}) {
  const [query, setQuery] = useState('');
  const [works, setWorks] = useState<WorkOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setBusy(true); setError('');
    api<{ works: WorkOption[] }>(`/api/admin/works?q=${encodeURIComponent(query)}`)
      .then((data) => { if (active) setWorks(data.works); })
      .catch(() => { if (active) setError(t('無法載入作品。請重新整理頁面再試。')); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [query, refreshVersion]);

  const selected = works.find((work) => work.id === value);
  return (
    <>
      <div className="field">
        <label htmlFor={`${idPrefix}-work-search`}>{t('搜尋作品名稱或作者')}</label>
        <input className="input" id={`${idPrefix}-work-search`} type="search" value={query}
          disabled={disabled} onChange={(e) => setQuery(e.target.value)} />
        <span className="hint">{t('顯示最新 50 部符合搜尋的作品；找不到時請輸入更完整的名稱。')}</span>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="field">
        <label htmlFor={`${idPrefix}-work`}>{t('目標作品')}</label>
        <select className="input" id={`${idPrefix}-work`} value={value} disabled={disabled}
          onChange={(e) => onChange(e.target.value)}>
          <option value="">{t('請選擇作品')}</option>
          {/* a work handed over from another panel may be outside the current
              50-row window; keep it selectable rather than silently dropping it */}
          {value && !selected && <option value={value}>{t('指定作品')}</option>}
          {works.map((work) => <option key={work.id} value={work.id}>
            {work.title}{work.author ? `／${work.author}` : ''} · {work.activeReleaseId ? t('已有發布版本') : t('尚未發布')}
          </option>)}
        </select>
        {busy && <span className="hint" role="status">{t('載入作品中…')}</span>}
        {!busy && !error && !works.length && <span className="hint">
          {query ? t('沒有符合搜尋的作品。請修改關鍵字。') : t('尚未有作品。請先建立新作品。')}
        </span>}
      </div>
    </>
  );
}
