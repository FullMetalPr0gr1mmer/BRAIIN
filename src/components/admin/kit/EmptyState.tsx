import type { ReactNode } from 'react';
import Icon from './Icon';
import type { IconName } from '@/lib/admin/icons';

// An empty state inside islands (Admin v2 F4b): the markup of ui/EmptyState.astro. What is
// empty and how to fill it; `children` is the action.

export interface EmptyStateProps {
  title: string;
  text?: string | undefined;
  icon?: IconName;
  children?: ReactNode;
}

export default function EmptyState({ title, text, icon = 'inbox', children }: EmptyStateProps) {
  return (
    <div className="empty">
      <span className="empty__ico">
        <Icon name={icon} size={22} />
      </span>
      <p className="empty__t">{title}</p>
      {text && <p className="empty__x">{text}</p>}
      {children && <div className="empty__a">{children}</div>}
    </div>
  );
}
