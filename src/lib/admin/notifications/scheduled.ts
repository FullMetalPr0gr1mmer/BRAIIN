import { can } from '@/lib/authz/matrix';
import { PER_SOURCE, type NotificationSource } from './types';

// "<title> goes live today": the services and posts scheduled for today, from the same
// derived view the dashboard's banner reads (`dashboard_attention`, kind scheduled_today;
// security_invoker, so the caller's RLS decides the rows). For the roles that write that
// content. It counts as new from the start of the view's day, so the first look of the
// day shows it and "Mark all as read" clears it, however late in the day it goes live.

interface AttentionRow {
  entity_type: string;
  id: string;
  title: unknown;
  at: string | null;
}

const EDITOR: Readonly<Record<string, string>> = {
  service: '/admin/services',
  blog_post: '/admin/blog',
};

/** The English title of a bilingual title, or a plain string. */
function titleOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object') {
    const en = (value as { en?: unknown }).en;
    if (typeof en === 'string' && en.trim()) return en.trim();
  }
  return null;
}

const RIYADH_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Riyadh',
  hour: '2-digit',
  minute: '2-digit',
});

export const scheduled: NotificationSource = {
  kind: 'scheduled',
  visible: (role) => can(role, 'services.write') === 'full' || can(role, 'blog.write') === 'full',
  async load({ sb, now }) {
    const { data, error } = await sb
      .from('dashboard_attention')
      .select('entity_type,id,title,at')
      .eq('kind', 'scheduled_today')
      .order('at', { ascending: true })
      .limit(PER_SOURCE);
    if (error) throw new Error(`notifications (scheduled): ${error.message}`);
    // The view's "today" is the database's current_date (UTC).
    const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    return ((data ?? []) as AttentionRow[]).flatMap((row) => {
      const editor = EDITOR[row.entity_type];
      if (!editor) return [];
      const at = row.at && Number.isFinite(Date.parse(row.at)) ? row.at : dayStart;
      return [
        {
          id: `scheduled:${row.entity_type}:${row.id}`,
          kind: 'scheduled' as const,
          icon: 'cal' as const,
          text: `${titleOf(row.title) ?? 'An item'} goes live today`,
          detail: `At ${RIYADH_TIME.format(new Date(at))}, Riyadh time`,
          at,
          since: dayStart,
          href: `${editor}/${row.id}`,
        },
      ];
    });
  },
};
