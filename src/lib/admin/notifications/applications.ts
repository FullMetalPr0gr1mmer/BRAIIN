import { can } from '@/lib/authz/matrix';
import { PER_SOURCE, windowStart, type NotificationSource } from './types';

// "New application for <role>": the role the applicant applied for, and nothing that
// names the applicant. Admin only (`applications.manage`, owner decision J6), behind the
// table's live Admin check (0029). Spam is left out.

interface ApplicationRow {
  id: string;
  role: string | null;
  created_at: string;
}

export const applications: NotificationSource = {
  kind: 'applications',
  visible: (role) => can(role, 'applications.manage') === 'full',
  async load({ sb, auth, now }) {
    const { data, error } = await sb
      .from('job_applications')
      .select('id,role,created_at')
      .eq('tenant_id', auth.tenantId)
      .neq('status', 'spam')
      .gte('created_at', windowStart(now))
      .order('created_at', { ascending: false })
      .limit(PER_SOURCE);
    if (error) throw new Error(`notifications (applications): ${error.message}`);
    return ((data ?? []) as ApplicationRow[]).map((row) => ({
      id: `applications:${row.id}`,
      kind: 'applications' as const,
      icon: 'hand' as const,
      text: row.role?.trim() ? `New application for ${row.role.trim()}` : 'New job application',
      detail: null,
      at: row.created_at,
      since: row.created_at,
      href: '/admin/applications',
    }));
  },
};
