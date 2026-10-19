import { useId, useState } from 'react';
import { updateBookmarkNote } from '../api/client.ts';
import { t } from '../i18n/translate.ts';

/** Shared by the post-creation reader prompt and the member bookmark list. */
export function BookmarkNoteEditor({ bookmarkId, initialNote = '', onSaved, onCancel, cancelLabel = t('取消') }: {
  bookmarkId: string; initialNote?: string; onSaved(note: string): void; onCancel(): void; cancelLabel?: string;
}) {
  const id = useId();
  const [note, setNote] = useState(initialNote);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  return <form onSubmit={(event) => {
    event.preventDefault();
    setSaving(true);
    setFailed(false);
    void updateBookmarkNote(bookmarkId, note).then(() => onSaved(note))
      .catch(() => setFailed(true)).finally(() => setSaving(false));
  }}>
    <div className="field">
      <label htmlFor={id}>{t('書籤備註（可留空）')}</label>
      <textarea id={id} className="input" rows={3} maxLength={500} value={note}
        aria-describedby={`${id}-count${failed ? ` ${id}-error` : ''}`}
        onChange={(event) => setNote(event.target.value)} disabled={saving} autoFocus />
      <span id={`${id}-count`} className="hint tnum">{t('{n} / 500 字', { n: note.length })}</span>
    </div>
    {failed && <p id={`${id}-error`} className="form-error" role="alert">{t('備註未儲存，輸入仍保留，請再試一次。')}</p>}
    <div className="row-actions">
      <button className="btn primary" disabled={saving} type="submit">{saving ? t('儲存中…') : t('儲存備註')}</button>
      <button className="btn" disabled={saving} type="button" onClick={onCancel}>{cancelLabel}</button>
    </div>
  </form>;
}
