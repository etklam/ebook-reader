// Empty states say what the surface is for and offer the next move. "沒有資料"
// teaches nothing, so it is never the copy here.
import type { ReactNode } from 'react';

export function EmptyState({
  title, body, action, testId,
}: {
  title: string;
  body: ReactNode;
  action?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="empty" data-testid={testId}>
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </div>
  );
}
