import type { ReactNode } from 'react';
import Icon from './Icon';
import { NOTE_ICON, type NoteTone } from '@/lib/admin/tones';

// A note inside islands (Admin v2 F4b): the markup of ui/Note.astro. A note that appears
// after something happens passes `role` ("alert" for an error, "status" otherwise), so it
// is announced; errors are never toasts (ui.md §2.3).

export interface NoteProps {
  tone?: NoteTone;
  role?: 'status' | 'alert' | undefined;
  className?: string | undefined;
  children: ReactNode;
}

export default function Note({ tone = 'info', role, className, children }: NoteProps) {
  return (
    <div className={className ? `note ${className}` : 'note'} data-tone={tone} role={role}>
      <Icon name={NOTE_ICON[tone]} size={16} />
      <div className="note__b">{children}</div>
    </div>
  );
}
