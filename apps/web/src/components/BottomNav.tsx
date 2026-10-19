// Global bottom navigation (§51): 書庫 / 我的. The reader keeps its own
// specialized controls and mounts without this nav entirely.
import { navigate } from '../App.tsx';
import { useMe } from '../account/useMe.ts';
import { useUpdateCount } from '../account/useUpdates.ts';
import { Icon } from './Icon.tsx';
import { t } from '../i18n/translate.ts';

export function BottomNav({ active }: { active: string }) {
  const { me } = useMe();
  const updates = useUpdateCount(Boolean(me));
  const activeKey = ['library', 'bookmarks', 'reading-stats'].includes(active) ? 'library' : active;
  const item = (
    target: string,
    label: string,
    key: string,
    icon: 'shelf' | 'me' | 'admin' | 'ranking',
    badge?: number,
  ) => (
    <button
      className="nav-item"
      aria-current={activeKey === key ? 'page' : undefined}
      aria-label={badge ? t('{label}，追更中有 {badge} 本更新', { label, badge }) : undefined}
      onClick={() => navigate(target)}
    >
      <Icon name={icon} />
      {label}
      {badge ? <span className="nav-badge" aria-hidden="true">{badge}</span> : null}
    </button>
  );
  return (
    <nav className="bottom-nav" aria-label={t('主導覽')}>
      {item('/', t('書庫'), 'catalog', 'shelf')}
      {item('/rankings', t('排行'), 'rankings', 'ranking')}
      {me
        ? item('/me/library', t('我的'), 'library', 'me', updates ?? 0)
        : item('/login', t('我的'), 'library', 'me')}
      {me?.role === 'admin' && item('/admin', t('管理'), 'admin', 'admin')}
    </nav>
  );
}
