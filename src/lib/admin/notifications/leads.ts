import { can } from '@/lib/authz/matrix';
import { resolveLeadInterests, withInterestLabels } from '@/lib/leads/interestLabel';
import { PER_SOURCE, windowStart, type NotificationSource } from './types';

// "New inquiry from <name>", with the service or discipline they asked about. For the
// holders of `leads.manage` only, through the caller's client: the column grant (0033)
// and the live check decide the rest. Only what the lead list itself shows: the name and
// the interest, never contact details, budget or the message. Spam is left out.

interface LeadRow {
  id: string;
  name: string | null;
  service_of_interest: string | null;
  discipline_of_interest: string | null;
  created_at: string;
}

export const leads: NotificationSource = {
  kind: 'leads',
  visible: (role) => can(role, 'leads.manage') === 'full',
  async load({ sb, auth, now, labels }) {
    const { data, error } = await sb
      .from('leads')
      .select('id,name,service_of_interest,discipline_of_interest,created_at')
      .eq('tenant_id', auth.tenantId)
      .eq('is_spam', false)
      .gte('created_at', windowStart(now))
      .order('created_at', { ascending: false })
      .limit(PER_SOURCE);
    if (error) throw new Error(`notifications (leads): ${error.message}`);
    const rows = (data ?? []) as LeadRow[];
    const interests =
      labels && rows.length > 0 ? await resolveLeadInterests(sb, auth.tenantId, rows) : null;
    return rows.map((row) => {
      const labelled = interests ? withInterestLabels(row, interests) : null;
      const interest = labelled?.service_label?.en ?? labelled?.discipline_label?.en ?? null;
      const name = row.name?.trim() || 'someone';
      return {
        id: `leads:${row.id}`,
        kind: 'leads' as const,
        icon: 'inbox' as const,
        text: `New inquiry from ${name}`,
        detail: interest,
        at: row.created_at,
        since: row.created_at,
        // The lead's own page (C4b); a lead the reader can no longer see answers a 404 there.
        href: `/admin/leads/${row.id}`,
      };
    });
  },
};
