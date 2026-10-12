// One icon set, one style: 24-unit grid, 1.6 stroke, round joins, currentColor.
// Always decorative — the accessible name comes from the button's text or
// aria-label, never from the glyph.
type Name =
  | 'back' | 'toc' | 'bookmark' | 'settings'
  | 'ranking' | 'shelf' | 'me' | 'admin' | 'close' | 'filter';

const PATHS: Record<Name, React.ReactNode> = {
  ranking: <path d="M4 20h16M6 20V11h4v9M10 20V5h4v15M14 20v-7h4v7" />,
  back: <path d="M14.5 5 8 12l6.5 7" />,
  toc: (
    <>
      <path d="M4 6.5h16M4 12h16M4 17.5h11" />
    </>
  ),
  bookmark: <path d="M6.5 4.5h11v15l-5.5-4-5.5 4z" />,
  settings: (
    <>
      <path d="M4 8h10M18 8h2M4 16h4M12 16h8" />
      <circle cx="16" cy="8" r="2.2" />
      <circle cx="10" cy="16" r="2.2" />
    </>
  ),
  shelf: (
    <>
      <path d="M5 4.5h5v15H5zM14 4.5h5v15h-5z" />
      <path d="M5 9h5M14 9h5" />
    </>
  ),
  // an open book with a ribbon — "mine" is the shelf you keep a place in
  me: (
    <>
      <path d="M12 7.2c-1.9-1.6-4.2-2.2-7-2.2v12c2.8 0 5.1.6 7 2.2 1.9-1.6 4.2-2.2 7-2.2V5c-2.8 0-5.1.6-7 2.2z" />
      <path d="M12 7.2V19" />
      <path d="M14.8 5.2v5l1.8-1.3 1.8 1.3v-5" />
    </>
  ),
  admin: (
    <>
      <path d="M12 4.5 19 8v4.5c0 3.4-2.8 6-7 7-4.2-1-7-3.6-7-7V8z" />
      <path d="M9.5 12l1.8 1.8L15 10" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  filter: <path d="M4 7h16M7 12h10M10 17h4" />,
};

export function Icon({ name }: { name: Name }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
