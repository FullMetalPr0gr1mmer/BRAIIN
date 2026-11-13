import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { ROLES } from '@/lib/auth/types';
import { ROLE_CAPS } from '@/lib/authz/matrix';
import { readContactPeople, readRetentionMonths } from '@/lib/crm/contactPage';
import { readTaskOwners } from '@/lib/crm/taskPage';
import { libraryFor, QUICK_DEFAULTS } from '@/lib/admin/quickActions';

// Admin v2 C10b: Sales gains crm.contacts and crm.tasks. What the contacts and tasks screens
// read for a Sales user, where it differs from what an Admin needed: the retention horizon
// (Sales is not CMS staff, so it reads no site_settings row) and who may own a contact or a
// task (Sales colleagues now may).

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const auth = { tenantId: TENANT, userId: 'u', role: 'sales' } as unknown as AuthContext;

function client(answers: Record<string, { data: unknown; error: unknown }>) {
  const calls: string[] = [];
  const sb = {
    rpc: async (fn: string, args?: unknown) => {
      calls.push(args === undefined ? `rpc:${fn}` : `rpc:${fn}:${JSON.stringify(args)}`);
      return answers[fn] ?? { data: null, error: { code: 'PGRST202' } };
    },
    from: (table: string) => {
      calls.push(`from:${table}`);
      throw new Error(`no table read expected (${table})`);
    },
  } as unknown as SupabaseClient;
  return { sb, calls };
}

describe('the contact page reads the retention horizon through its door (C10b)', () => {
  it('one call to crm_contact_retention_months, no table read', async () => {
    const { sb, calls } = client({ crm_contact_retention_months: { data: 18, error: null } });
    expect(await readRetentionMonths(sb)).toBe(18);
    expect(calls).toEqual(['rpc:crm_contact_retention_months']);
  });

  it('null when the door refuses, answers null, or answers something that is not months', async () => {
    for (const answer of [
      { data: null, error: { code: '42501' } },
      { data: null, error: null },
      { data: 0, error: null },
      { data: 2.5, error: null },
      { data: '24', error: null },
    ]) {
      const { sb } = client({ crm_contact_retention_months: answer });
      expect(await readRetentionMonths(sb), JSON.stringify(answer)).toBeNull();
    }
  });

  it('the page no longer reads site_settings, which only CMS staff read', () => {
    const code = readFileSync('src/lib/crm/contactPage.ts', 'utf8');
    expect(code).not.toMatch(/from\(\s*['"]site_settings['"]\s*\)/);
    // The migration's number is assigned at merge (scripts/renumber-migration.mjs): by name.
    const file = readdirSync('supabase/migrations').find((f) =>
      /^\d{4}_crm_sales_contacts\.sql$/.test(f),
    );
    expect(file, 'the Sales contacts migration').toBeDefined();
    const sql = readFileSync(`supabase/migrations/${file!}`, 'utf8');
    expect(sql).toMatch(
      /create or replace function public\.crm_contact_retention_months\(\) returns int\s+language sql stable security invoker set search_path = ''/,
    );
    expect(sql).toContain(
      'grant execute on function public.crm_contact_retention_months() to authenticated;',
    );
  });
});

describe('Sales colleagues may own a contact and a task (C10b)', () => {
  const PEOPLE = [
    { id: 'p1', display_name: 'Amal', role: 'admin' },
    { id: 'p2', display_name: 'Dev', role: 'developer' },
    { id: 'p3', display_name: 'Sami', role: 'sales' },
  ];

  it('the owner pickers offer Admin and Sales, never Developer (O-7)', async () => {
    const { sb } = client({ crm_people: { data: PEOPLE, error: null } });
    const [people, owners] = await Promise.all([
      readContactPeople(sb, auth),
      readTaskOwners(sb, auth),
    ]);
    expect(people).toEqual([
      { id: 'p1', name: 'Amal', canOwn: true },
      { id: 'p2', name: 'Dev', canOwn: false },
      { id: 'p3', name: 'Sami', canOwn: true },
    ]);
    expect(owners).toEqual([
      { id: 'p1', name: 'Amal' },
      { id: 'p3', name: 'Sami' },
    ]);
  });
});

describe('Sales starts with My tasks among its quick actions (C10b)', () => {
  it('a library action it may use, after Open leads', () => {
    expect(QUICK_DEFAULTS.sales.slice(0, 2)).toEqual(['open-leads', 'my-tasks']);
    expect(libraryFor('sales').map((a) => a.id)).toContain('my-tasks');
    for (const role of ROLES)
      if (ROLE_CAPS[role]['crm.tasks'] === 'none')
        expect(QUICK_DEFAULTS[role], role).not.toContain('my-tasks');
  });
});
