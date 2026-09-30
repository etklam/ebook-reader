// Mobile bottom sheet (§9.4): dialog semantics without focus traps — Esc and
// backdrop close it, focus moves in on open and returns to the opener's
// neighbor on close. Content scrolls; drag-to-dismiss is deliberately absent.
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export function BottomSheet({
  open, title, onClose, children,
}: {
  open: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panelRef}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sheet-head">
          <h2>{title}</h2>
          <button className="reader-btn" aria-label="關閉" onClick={onClose}>✕</button>
        </header>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
