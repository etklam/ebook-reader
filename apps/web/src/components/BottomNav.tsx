// Global bottom navigation (§51): 書庫 / 我的. The reader keeps its own
// specialized controls and mounts without this nav entirely.
import { navigate } from '../App.tsx';
import { useMe } from '../account/useMe.ts';

export function BottomNav({ active }: { active: string }) {
  const { me } = useMe();
  const item = (target: string, label: string, key: string, badge?: number) => (
    <button
      className={`nav-item${active === key ? ' active' : ''}`}
      aria-current={active === key ? 'page' : undefined}
      onClick={() => navigate(target)}
    >
      {label}
      {badge ? <span className="nav-badge" aria-label={`${badge} 本有更新`}>{badge}</span> : null}
    </button>
  );
  return (
    <nav className="bottom-nav" aria-label="主導覽">
      {item('/', '書庫', 'catalog')}
      {me
        ? item('/me/library', '我的', 'library')
        : item('/login', '我的', 'library')}
      {me?.role === 'admin' && item('/admin', '管理', 'admin')}
    </nav>
  );
}
