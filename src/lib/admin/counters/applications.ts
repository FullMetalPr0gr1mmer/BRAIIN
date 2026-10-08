import type { Counter } from './types';

// New job applications, beside Job applications. The same query as the dashboard's card,
// so a badge and a card never disagree.
export const applications: Counter = (sb, tenantId) =>
  sb
    .from('job_applications')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('status', 'new');
