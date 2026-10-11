// Mobile bottom sheet (§9.4) — the only modal pattern on the site. Esc and
// backdrop close it, focus moves in on open and returns to the opener on close,
// Tab cycles inside it (aria-modal promises the rest of the page is out of
// reach, so Tab must not walk into it), the page behind stops scrolling, and
// content scrolls inside. Drag-to-dismiss is deliberately absent.
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../components/Icon.tsx';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
].join(',');

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
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Escape closes exactly one layer: without this the reader's own
        // Escape handler would hide the chrome in the same keystroke
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      // offsetParent skips anything display:none — a collapsed section inside
      // the sheet must not become an invisible tab stop
      const stops = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      const active = document.activeElement;
      if (stops.length === 0) { e.preventDefault(); panel.focus(); return; }
      const first = stops[0];
      const last = stops[stops.length - 1];
      if (!panel.contains(active)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
      if (e.shiftKey && (active === first || active === panel)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
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
        <div className="sheet-grip" aria-hidden="true" />
        <header className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" aria-label="關閉" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
