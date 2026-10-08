import type { Counter } from './types';

// New leads, beside Leads. The same query as the dashboard's card, so a badge and a card
// never disagree.
export const leads: Counter = (sb, tenantId) =>
  sb
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'new');
