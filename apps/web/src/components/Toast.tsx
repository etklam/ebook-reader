// Transient confirmation for an action that already happened, carrying the one
// control that makes a destructive-looking action safe: 復原. It replaces the
// confirmation dialog the shelf would otherwise need: the common case costs
// one tap, and the accidental case still has a way back.
import { useEffect, useState } from 'react';

export function Toast({
  message, actionLabel, onAction, onDismiss, ms = 6000,
}: {
  message: string;
  actionLabel?: string;
  onAction?(): void;
  onDismiss(): void;
  ms?: number;
}) {
  const [paused, setPaused] = useState(false);
  // Do not make the undo action disappear while someone is reaching it.
  useEffect(() => {
    if (paused) return;
    const t = setTimeout(onDismiss, ms);
    return () => clearTimeout(t);
  }, [message, ms, onDismiss, paused]);

  return (
    <div
      className="toast-layer"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={(e) => setPaused(e.currentTarget.contains(document.activeElement))}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setPaused(e.currentTarget.matches(':hover'));
        }
      }}
    >
      <p className="toast" role="status" data-testid="toast">
        <span className="toast-text">{message}</span>
        {actionLabel && (
          <button className="toast-action" onClick={onAction}>{actionLabel}</button>
        )}
        <button className="toast-close" aria-label="關閉通知" onClick={onDismiss}>×</button>
      </p>
    </div>
  );
}
