// The three member surfaces (書庫 / 書籤 / 閱讀紀錄) are one group, so they get
// one nav. It was inlined three times and drifted: each page listed only the
// *other* pages, so nothing said where you were, and 登出 existed on 我的書庫
// alone — leaving the account from a bookmark meant navigating back first.
import { navigate } from '../App.tsx';
import { refreshMe } from './useMe.ts';
import { logout } from '../api/client.ts';
import { clearUpdates } from './useUpdates.ts';

const PAGES = [
  { key: 'library', path: '/me/library', label: '我的書庫' },
  { key: 'bookmarks', path: '/me/bookmarks', label: '我的書籤' },
  { key: 'reading-stats', path: '/me/reading-stats', label: '閱讀紀錄' },
] as const;

export type MemberPage = (typeof PAGES)[number]['key'];

export function MemberNav({ current, onError }: {
  current: MemberPage;
  onError?(message: string): void;
}) {
  return (
    <nav className="subnav" aria-label="會員頁面">
      {PAGES.map((p) => (p.key === current
        // the current page is stated, not offered: a link back to here teaches
        // nothing, and without it nothing on the page says which one it is
        ? <span key={p.key} className="subnav-here" aria-current="page">{p.label}</span>
        : <button key={p.key} className="linkish" onClick={() => navigate(p.path)}>{p.label}</button>
      ))}
      {/* no 到書庫找書 here: 書庫 is a permanent tab in the bottom nav, and a
          fifth item wraps the row at 360px */}
      <button
        className="linkish subnav-end"
        onClick={() => void logout()
          .then(refreshMe)
          .then(() => { clearUpdates(); navigate('/'); })
          .catch(() => onError?.('登出沒有成功，請再試一次'))}
      >
        登出
      </button>
    </nav>
  );
}
