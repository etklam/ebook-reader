// Open Beta registration: no invite code is required.
import { useState } from 'react';
import { ApiRequestError, register } from '../api/client.ts';
import { navigate } from '../App.tsx';
import { refreshMe } from './useMe.ts';
import { t } from '../i18n/translate.ts';

// Source-language tables, translated at the render site: a constant is
// evaluated at import and would not follow a language switch.
const ERROR_TEXT: Record<string, string> = {
  registration_closed: '目前未開放註冊',
  invite_required: '需要邀請碼',
  invite_invalid: '邀請碼無效',
  invite_expired: '邀請碼已過期或已使用',
  invalid_request: '資料格式不正確（暱稱 2–30 字、密碼至少 8 字）',
};

const ERROR_HINT: Record<string, string> = {
  registration_closed: 'Beta 期間由管理員逐批開放，暫時連邀請碼也無法註冊。',
  invite_invalid: '請確認大小寫與前後空白；邀請碼一組只能用一次。',
  invite_expired: '請向管理員索取新的邀請碼。',
};

export function RegistrationPage() {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCode('');
    setBusy(true);
    try {
      await register(username, email, password, invite);
      await refreshMe();
      navigate('/me/library');
    } catch (err) {
      setCode(err instanceof ApiRequestError ? err.code : 'unknown');
    } finally {
      setBusy(false);
    }
  };

  const error = code ? t(ERROR_TEXT[code] ?? '註冊失敗') : '';

  return (
    <div className="auth-page" data-testid="register">
      <h1>{t('註冊')}</h1>
      <p className="auth-lede">{t('建立帳戶後可以收藏、追更，並讓閱讀進度跨裝置接續。')}</p>
      <form className="auth-form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="reg-username">{t('暱稱')}</label>
          <input className="input" id="reg-username" aria-describedby="reg-username-hint"
            value={username} required minLength={2} maxLength={30} autoComplete="username"
            onChange={(e) => setUsername(e.target.value)} />
          <span className="hint" id="reg-username-hint">{t('2–30 字，之後可以更改。')}</span>
        </div>
        <div className="field">
          <label htmlFor="reg-email">{t('電子郵件')}</label>
          <input className="input" id="reg-email" type="email" value={email} required autoComplete="email"
            onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="reg-password">{t('密碼')}</label>
          {/* there is no self-serve reset, so a typo here is unrecoverable.
              Being able to read what you typed is the safeguard. */}
          <div className="input-reveal">
            <input className="input" id="reg-password" aria-describedby="reg-password-hint"
              type={shown ? 'text' : 'password'} value={password} required minLength={8}
              autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="btn quiet reveal-btn" aria-pressed={shown}
              onClick={() => setShown((v) => !v)}>{shown ? t('隱藏') : t('顯示')}</button>
          </div>
          <span className="hint" id="reg-password-hint">{t('至少 8 個字元。目前沒有自助重設，請記牢。')}</span>
        </div>
        {/* registration is open: the code gates nothing, so it does not get a
            field in the main column — it stays available for anyone holding one */}
        <details className="disclosure" open={code.startsWith('invite') || undefined}>
          <summary>{t('有邀請碼？（不需要也能註冊）')}</summary>
          <div className="field">
            <label htmlFor="reg-invite">{t('邀請碼')}</label>
            <input className="input input-mono" id="reg-invite" value={invite}
              aria-invalid={code.startsWith('invite') || undefined}
              onChange={(e) => setInvite(e.target.value)} />
          </div>
        </details>
        {error && (
          <p className="form-error" role="alert">
            {error}{ERROR_HINT[code] ? `　${t(ERROR_HINT[code])}` : ''}
          </p>
        )}
        <button className="btn primary" type="submit" disabled={busy} aria-busy={busy || undefined}>
          {busy ? t('註冊中…') : t('註冊')}
        </button>
      </form>
      <p className="auth-foot">
        {t('已經有帳號了？')}<button className="linkish" onClick={() => navigate('/login')}>{t('登入')}</button>
      </p>
    </div>
  );
}
