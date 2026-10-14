import type { ReactNode } from 'react';
import { statusLabel, type BadgeTone } from '@/lib/admin/tones';

// Badges inside islands (Admin v2 F4b): the markup of ui/Badge.astro, so a status reads
// the same on a server page and in a React table (tests/astro/kitParity.spec.ts holds the
// two equal). The state is always a word: a status badge with no children says its
// status ("Draft").

export interface BadgeProps {
  tone?: BadgeTone | undefined;
  status?: string | undefined;
  /** No dot: for a count or a label that is not a state. */
  plain?: boolean;
  className?: string | undefined;
  children?: ReactNode;
}

export function Badge({ tone, status, plain = false, className, children }: BadgeProps) {
  return (
    <span
      className={className ? `badge ${className}` : 'badge'}
      data-tone={tone}
      data-status={status}
      data-plain={plain ? '' : undefined}
    >
      {children ?? (status ? statusLabel(status) : null)}
    </span>
  );
}

/** A content status as a badge: published ok, draft warn, scheduled sky, archived gray. */
export default function StatusBadge({ status }: { status: string }) {
  return <Badge status={status} />;
}
