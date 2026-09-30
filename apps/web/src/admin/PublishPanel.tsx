// Admin publish panel (§49): publish preview (validation + diff), explicit
// confirm, and Idempotency-Key retry safety. Publish is NEVER bundled into
// the import apply action.
import { useState } from 'react';
import { getPublishPreview, publishWork } from '../api/client.ts';
import type { PublishPreviewResponse } from '../api/types.ts';

export function PublishPanel() {
  const [workId, setWorkId] = useState('');
  const [preview, setPreview] = useState<PublishPreviewResponse | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const loadPreview = async () => {
    setBusy(true); setMsg(''); setPreview(null);
    try {
      setPreview(await getPublishPreview(workId.trim()));
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '載入失敗');
    } finally {
      setBusy(false);
    }
  };

  const doPublish = async () => {
    if (!preview) return;
    setBusy(true); setMsg('');
    try {
      const key = `ui-publish-${workId.trim()}-${Date.now()}`;
      const r = await publishWork(workId.trim(), key);
      setMsg(`已發布 v${r.version}（新章 ${r.diff.newChapterIds.length}、修訂章 ${r.diff.updatedChapterIds.length}）`);
      setPreview(await getPublishPreview(workId.trim()));
    } catch (e) {
      const err = e as { code?: string; body?: { problems?: string[] } };
      setMsg(err.code === 'publish_validation_failed'
        ? `驗證失敗：${err.body?.problems?.join('、')}`
        : `發布失敗：${err.code ?? '未知錯誤'}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="admin-panel" data-testid="publish-panel">
      <h2>發布</h2>
      <p className="muted">發布會把目前的編輯內容拍成不可變快照並切換公開版本；匯入／套用不會自動發布。</p>
      <div className="form-row">
        <input placeholder="作品 UUID" value={workId} onChange={(e) => setWorkId(e.target.value)} aria-label="作品 UUID" />
        <button className="reader-btn" onClick={loadPreview} disabled={busy || !workId.trim()}>載入發布預覽</button>
      </div>
      {msg && <p className="form-msg">{msg}</p>}
      {preview && (
        <div className="preview-box">
          <p>
            編輯章數 <b>{preview.chapterCount}</b>
            {preview.previousRelease ? `｜目前公開版本 v${preview.previousRelease.version}（${preview.previousRelease.chapterCount} 章）` : '｜尚未發布'}
          </p>
          <p>
            新章 <b>{preview.diff.newChapterIds.length}</b>｜
            修訂章 <b>{preview.diff.updatedChapterIds.length}</b>｜
            重排章 <b>{preview.diff.reorderedChapterIds.length}</b>
          </p>
          {preview.valid ? (
            <>
              <p className="ok">可發布。</p>
              <button className="reader-btn primary" onClick={doPublish} disabled={busy}>確認發布</button>
            </>
          ) : (
            <p className="form-error">無法發布：{preview.problems.join('、')}</p>
          )}
        </div>
      )}
    </section>
  );
}
