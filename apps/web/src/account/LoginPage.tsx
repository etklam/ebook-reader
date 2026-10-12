// Member login. The guest→member merge policy lives in the reader, not here.
import { useState } from 'react';
import { ApiRequestError, login } from '../api/client.ts';
import { navigate } from '../App.tsx';
import { refreshMe } from './useMe.ts';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email, password);
      await refreshMe();
      navigate('/me/library');
    } catch (err) {
      setError(err instanceof ApiRequestError && err.code === 'invalid_credentials'
        ? '帳號或密碼不正確'
        : '登入失敗，請稍後再試');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page" data-testid="login">
      <h1>登入</h1>
      <p className="auth-lede">登入後可以收藏、追更，並讓閱讀進度跨裝置接續。</p>
      <form className="auth-form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="login-email">電子郵件</label>
          <input className="input" id="login-email" type="email" value={email} required autoComplete="email"
            aria-invalid={error ? true : undefined}
            onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="login-password">密碼</label>
          <div className="input-reveal">
            <input className="input" id="login-password" type={shown ? 'text' : 'password'}
              value={password} required
              autoComplete="current-password"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'login-error' : undefined}
              onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="btn quiet reveal-btn" aria-pressed={shown}
              onClick={() => setShown((v) => !v)}>{shown ? '隱藏' : '顯示'}</button>
          </div>
        </div>
        {error && <p className="form-error" id="login-error" role="alert">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy} aria-busy={busy || undefined}>
          {busy ? '登入中…' : '登入'}
        </button>
      </form>
      <p className="auth-foot">
        還沒有帳號？<button className="linkish" onClick={() => navigate('/register')}>建立帳戶</button>
        <br />忘記密碼目前無法自助重設，請聯絡管理員。
      </p>
    </div>
  );
}
