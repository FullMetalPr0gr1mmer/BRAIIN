import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { readPeople } from '@/lib/crm/leadPage';
import { readTaskOwners } from '@/lib/crm/taskPage';

// A lead's page lists whom the lead can go to and, for crm.tasks holders, whom a task can go
// to. Both lists come from public.crm_people, which is read once per request (Admin v2 C8
// review, C8-PERF-1: one subrequest, README P-15), and a failed read leaves both empty.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const auth = { tenantId: TENANT, userId: 'u', role: 'admin' } as unknown as AuthContext;

function client(answer: { data: unknown; error: unknown }) {
  const calls: { fn: string; args: unknown }[] = [];
  const sb = {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return answer;
    },
  } as unknown as SupabaseClient;
  return { sb, calls };
}

const PEOPLE = [
  { id: 'p1', display_name: 'Amal', role: 'admin' },
  { id: 'p2', display_name: 'Dev', role: 'developer' },
];

describe('the CRM directory, once per request', () => {
  it('the lead page’s two lists cost one crm_people read', async () => {
    const { sb, calls } = client({ data: PEOPLE, error: null });
    const [people, owners] = await Promise.all([readPeople(sb, auth), readTaskOwners(sb, auth)]);
    expect(calls).toEqual([{ fn: 'crm_people', args: { p_tenant: TENANT } }]);
    expect(people.map((p) => p.id)).toEqual(['p1', 'p2']);
    // A task goes only to a crm.tasks holder (Admin).
    expect(owners).toEqual([{ id: 'p1', name: 'Amal' }]);
  });

  it('another request (another client) reads again', async () => {
    const a = client({ data: PEOPLE, error: null });
    const b = client({ data: PEOPLE, error: null });
    await readPeople(a.sb, auth);
    await readTaskOwners(b.sb, auth);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  it('a failed read leaves both lists empty, still once', async () => {
    const { sb, calls } = client({ data: null, error: { code: '42501' } });
    expect(await readPeople(sb, auth)).toEqual([]);
    expect(await readTaskOwners(sb, auth)).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
