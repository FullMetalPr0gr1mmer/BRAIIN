import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Admin v2 C16 (0140) restates one function as 0134 left it (C8's copy of C5's): the orphan rule,
// with the lines marked `-- C16` (an auto-contact with a file a person added is not an
// orphan). This holds the copy to 0134's text plus those lines, so a later edit to the copy (or
// a fix to the rule the copy would silently undo) fails here instead of in production.

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const read = (file: string) => readFileSync(join(MIGRATIONS, file), 'utf8').replace(/\r\n/g, '\n');
const C8 = read('0134_crm_tasks.sql');
const C16 = read('0140_crm_contact_files.sql');

function fn(sql: string, name: string, end: string): string {
  const start = sql.indexOf(`create or replace function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const stop = sql.indexOf(end, start);
  expect(stop, name).toBeGreaterThan(start);
  return sql.slice(start, stop + end.length);
}

const withoutC16 = (text: string) =>
  text
    .split('\n')
    .filter((line) => !/ {2}-- C16$/.test(line))
    .join('\n');

describe('0140 restates the orphan rule with its marked lines only', () => {
  it('app.crm_contact_is_orphan: 0134’s text plus the -- C16 lines', () => {
    const before = fn(C8, 'app.crm_contact_is_orphan', '$$;');
    const after = fn(C16, 'app.crm_contact_is_orphan', '$$;');
    expect(after).toMatch(/public\.crm_contact_files fl/);
    expect(withoutC16(after)).toBe(before);
    expect(after.split('\n').filter((l) => / {2}-- C16$/.test(l))).toHaveLength(2);
  });

  it('app.crm_contact_is_orphan keeps 0134’s grants: the service role still executes it', () => {
    // crm_erase_lead is an INVOKER the service role runs, and it asks the orphan rule; a restated
    // copy that revokes without granting back breaks every lead erasure (the PGlite replay of
    // crm_contacts_orphans and crm_contacts_retention_erase: 42501).
    const grants = (sql: string) => {
      const end = fn(sql, 'app.crm_contact_is_orphan', '$$;');
      const from = sql.indexOf(end) + end.length;
      return sql
        .slice(from, sql.indexOf('\n\n', from))
        .split('\n')
        .filter((l) => /^(revoke|grant) /.test(l));
    };
    expect(grants(C8)).toHaveLength(2);
    expect(grants(C16)).toEqual(grants(C8));
  });

  it('the doors and the sweep reader are SECURITY INVOKER with an empty search_path', () => {
    for (const name of [
      'public.crm_file_add',
      'public.crm_file_remove',
      'public.crm_file_orphans',
    ]) {
      const head = fn(C16, name, 'as $$');
      expect(head, name).toMatch(/security invoker/);
      expect(head, name).not.toMatch(/security definer/);
      expect(head, name).toMatch(/set search_path = ''/);
    }
  });

  it('each door checks the actor live before it reads or writes a file', () => {
    for (const name of ['public.crm_file_add', 'public.crm_file_remove']) {
      const body = fn(C16, name, 'end $$;');
      const check = body.indexOf('app.crm_files_actor_ok(p_tenant, p_actor)');
      expect(check, name).toBeGreaterThan(0);
      expect(check, name).toBeLessThan(body.search(/(from|into) public\.crm_contact_files/));
    }
  });
});
