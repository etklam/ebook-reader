// Controlled Beta registration (§25): invite-based. If the server runs
// closed mode the attempt fails with registration_closed and we say so.
import { useState } from 'react';
import { ApiRequestError, register } from '../api/client.ts';
import { navigate } from '../App.tsx';
import { refreshMe } from './useMe.ts';

const ERROR_TEXT: Record<string, string> = {
  registration_closed: '目前未開放註冊',
  invite_required: '需要邀請碼',
  invite_invalid: '邀請碼無效',
  invite_expired: '邀請碼已過期或已使用',
  invalid_request: '資料格式不正確（暱稱 2–30 字、密碼至少 8 字）',
};

export function RegistrationPage() {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState('');
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await register(username, email, password, invite);
      await refreshMe();
      navigate('/me/library');
    } catch (err) {
      setError(err instanceof ApiRequestError ? (ERROR_TEXT[err.code] ?? '註冊失敗') : '註冊失敗');
    }
  };

  return (
    <div className="auth-page" data-testid="register">
      <h1>註冊（Beta 邀請制）</h1>
      <form className="auth-form" onSubmit={submit}>
        <label>暱稱
          <input value={username} onChange={(e) => setUsername(e.target.value)} required minLength={2} maxLength={30} autoComplete="username" />
        </label>
        <label>電子郵件
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </label>
        <label>密碼（至少 8 字）
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoComplete="new-password" />
        </label>
        <label>邀請碼
          <input value={invite} onChange={(e) => setInvite(e.target.value)} required />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="reader-btn primary" type="submit">註冊</button>
      </form>
      <p className="muted">Beta 期間採邀請制；忘記密碼目前無法自助重設，請聯絡管理員。</p>
    </div>
  );
}
