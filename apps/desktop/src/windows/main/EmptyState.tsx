// 空状态（specs/06 §4.11）
import { Button } from "@bianfa/ui";
import type { ReactNode } from "react";

export interface EmptyStateProps {
  title: string;
  hint?: string;
  action?: { label: string; onClick: () => void };
  level?: "list" | "panel";
  children?: ReactNode;
}

export function EmptyState({ title, hint, action, level = "list", children }: EmptyStateProps) {
  return (
    <div className={`empty empty--${level}`} role="status">
      <p className="empty__title">{title}</p>
      {hint ? <p className="empty__hint">{hint}</p> : null}
      {action ? (
        <Button variant="primary" size="lg" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
      {children}
    </div>
  );
}
