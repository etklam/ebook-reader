// Global bottom navigation (§51): 書庫 / 我的. The reader keeps its own
// specialized controls and mounts without this nav entirely.
import { navigate } from '../App.tsx';
import { useMe } from '../account/useMe.ts';
import { useUpdateCount } from '../account/useUpdates.ts';
import { Icon } from './Icon.tsx';

export function BottomNav({ active }: { active: string }) {
  const { me } = useMe();
  const updates = useUpdateCount(Boolean(me));
  const item = (
    target: string,
    label: string,
    key: string,
    icon: 'shelf' | 'me' | 'admin',
    badge?: number,
  ) => (
    <button
      className="nav-item"
      aria-current={active === key ? 'page' : undefined}
      aria-label={badge ? `${label}，追更中有 ${badge} 本更新` : undefined}
      onClick={() => navigate(target)}
    >
      <Icon name={icon} />
      {label}
      {badge ? <span className="nav-badge" aria-hidden="true">{badge}</span> : null}
    </button>
  );
  return (
    <nav className="bottom-nav" aria-label="主導覽">
      {item('/', '書庫', 'catalog', 'shelf')}
      {me
        ? item('/me/library', '我的', 'library', 'me', updates ?? 0)
        : item('/login', '我的', 'library', 'me')}
      {me?.role === 'admin' && item('/admin', '管理', 'admin', 'admin')}
    </nav>
  );
}
