// Admin publish panel (§49): publish preview (validation + diff), explicit
// confirm, and Idempotency-Key retry safety. Publish is NEVER bundled into
// the import apply action.
import { useState } from 'react';
import { getPublishPreview, publishWork } from '../api/client.ts';
import type { PublishPreviewResponse } from '../api/types.ts';
import { count } from '../lib/format.ts';

export function PublishPanel() {
  const [workId, setWorkId] = useState('');
  const [preview, setPreview] = useState<PublishPreviewResponse | null>(null);
  const [msg, setMsg] = useState('');
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadPreview = async () => {
    setBusy(true); setMsg(''); setOk(false); setPreview(null);
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
    setBusy(true); setMsg(''); setOk(false);
    try {
      const key = `ui-publish-${workId.trim()}-${Date.now()}`;
      const r = await publishWork(workId.trim(), key);
      setOk(true);
      setMsg(`已發布 v${r.version}：新章 ${r.diff.newChapterIds.length}、修訂章 ${r.diff.updatedChapterIds.length}。`);
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
      <p className="muted">
        發布把目前的編輯內容拍成不可變快照，並切換公開版本。匯入與套用都不會自動發布——
        在按下確認之前，讀者看到的仍是上一個版本。
      </p>
      <div className="form-row">
        <input className="input input-mono" placeholder="作品 UUID" value={workId}
          aria-label="作品 UUID" onChange={(e) => setWorkId(e.target.value)} />
        <button className="btn" onClick={loadPreview} disabled={busy || !workId.trim()}>
          載入預覽
        </button>
      </div>
      {msg && <p className={ok ? 'form-ok' : 'form-error'} role="status">{msg}</p>}
      {preview && (
        <>
          <dl className="meta-grid">
            <dt>編輯章數</dt>
            <dd>{count(preview.chapterCount)} 章</dd>
            <dt>目前公開</dt>
            <dd>
              {preview.previousRelease
                ? `v${preview.previousRelease.version}（${count(preview.previousRelease.chapterCount)} 章）`
                : '尚未發布'}
            </dd>
          </dl>
          <div className="tally">
            <div><b>{preview.diff.newChapterIds.length}</b>新章</div>
            <div><b>{preview.diff.updatedChapterIds.length}</b>修訂章</div>
            <div><b>{preview.diff.reorderedChapterIds.length}</b>重排章</div>
          </div>
          {preview.valid ? (
            <>
              <p className="form-ok">通過驗證，可以發布。</p>
              <button className="btn primary btn-block" onClick={doPublish} disabled={busy} aria-busy={busy || undefined}>
                {busy ? '發布中…' : '確認發布'}
              </button>
            </>
          ) : (
            <p className="form-error" role="alert">無法發布：{preview.problems.join('、')}</p>
          )}
        </>
      )}
    </section>
  );
}
