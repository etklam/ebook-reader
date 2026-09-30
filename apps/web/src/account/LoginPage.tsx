// Member login + guest→member merge policy lives in the reader, not here.
import { useState } from 'react';
import { ApiRequestError, login } from '../api/client.ts';
import { navigate } from '../App.tsx';
import { refreshMe } from './useMe.ts';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await login(email, password);
      await refreshMe();
      navigate('/me/library');
    } catch (err) {
      setError(err instanceof ApiRequestError && err.code === 'invalid_credentials' ? '帳號或密碼不正確' : '登入失敗，請稍後再試');
    }
  };

  return (
    <div className="auth-page" data-testid="login">
      <h1>登入</h1>
      <form className="auth-form" onSubmit={submit}>
        <label>電子郵件
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        <label>密碼
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="reader-btn primary" type="submit">登入</button>
      </form>
      <p className="muted">
        還沒有帳號？<button className="linkish" onClick={() => navigate('/register')}>使用邀請註冊</button>
      </p>
    </div>
  );
}
