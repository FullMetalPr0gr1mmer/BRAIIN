import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The six-slice CRM integration's migration (Admin v2 C-int, docs/admin-v2/as-built/
// C-LAST-INTEGRATION.md): it restates C12's merge door and purge, each as C12 wrote it plus the
// lines marked `-- C-int`, so no earlier slice's line is lost; pgTAP crm_last_integration proves
// what the lines do.

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const read = (pattern: RegExp) =>
  readFileSync(
    join(MIGRATIONS, readdirSync(MIGRATIONS).find((f) => pattern.test(f)) ?? ''),
    'utf8',
  ).replace(/\r\n/g, '\n');
const C12 = read(/_crm_merge\.sql$/);
const CINT = read(/_crm_last_integration\.sql$/);
const MARK = / {2}-- C-int$/;

function fn(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const stop = sql.indexOf('end $$;', start);
  expect(stop, name).toBeGreaterThan(start);
  return sql.slice(start, stop + 'end $$;'.length);
}
const unmarked = (body: string) =>
  body
    .split('\n')
    .filter((line) => !MARK.test(line))
    .join('\n');
const marked = (body: string) =>
  body
    .split('\n')
    .filter((line) => MARK.test(line))
    .join('\n');

describe('the integration migration (C-int)', () => {
  it('restates the merge door as C12 wrote it plus the lines marked -- C-int', () => {
    const after = fn(CINT, 'public.crm_merge_contacts');
    expect(unmarked(after)).toBe(fn(C12, 'public.crm_merge_contacts'));
    const lines = marked(after);
    // C16: the add door's per-contact lock on the record going away; C11: the company kept or
    // taken, none on the tombstone; C9b: only defined fields carried; C15 and C16: the follow.
    expect(lines).toMatch(
      /pg_advisory_xact_lock\(hashtextextended\('crm-files:' \|\| p_drop::text, 0\)\)/,
    );
    expect(lines).toMatch(/company_id = coalesce\(k\.company_id, d\.company_id\),/);
    expect(lines).toMatch(/^ +company_id = null,/m);
    expect(lines).toMatch(/jsonb_array_elements\(s\.custom_fields\)[\s\S]*\|\| k\.custom;/);
    expect(lines).toMatch(/perform app\.crm_tombstone_follow\(p_tenant, p_drop\);/);
  });

  it('takes the file lock before it locks a row, and follows only once the tombstone is made', () => {
    const merge = fn(CINT, 'public.crm_merge_contacts');
    const fileLock = merge.indexOf("'crm-files:' || p_drop::text");
    expect(fileLock).toBeGreaterThan(merge.indexOf("'crm-email:'"));
    expect(fileLock).toBeLessThan(merge.indexOf('for update'));
    const follow = merge.indexOf('app.crm_tombstone_follow(p_tenant, p_drop)');
    expect(follow).toBeGreaterThan(merge.indexOf('merged_into = p_keep, merged_at = now()'));
    expect(follow).toBeLessThan(merge.indexOf('insert into public.audit_log'));
  });

  it('keeps the answer and the audit row free of a file count (crm.files is Admin’s; Sales merges)', () => {
    const merge = fn(CINT, 'public.crm_merge_contacts');
    const tail = merge.slice(merge.indexOf('insert into public.audit_log'));
    expect(tail).not.toMatch(/files/);
  });

  it('restates the purge as C12 wrote it plus the lines marked -- C-int, before the tombstones go', () => {
    const after = fn(CINT, 'app.purge_crm');
    expect(unmarked(after)).toBe(fn(C12, 'app.purge_crm'));
    const follow = after.indexOf('app.crm_tombstone_follow(c.tenant_id, c.id)');
    expect(follow).toBeGreaterThan(0);
    expect(follow).toBeLessThan(
      after.indexOf(
        'delete from public.crm_contacts c where c.tenant_id = t.id and c.merged_into is not null',
      ),
    );
  });

  it('the follow is a pinned definer the service role alone runs, moving only off a tombstone', () => {
    const follow = fn(CINT, 'app.crm_tombstone_follow');
    expect(follow).toMatch(/security definer set search_path = ''/);
    expect(follow).toMatch(/c\.merged_into is not null/);
    expect(follow).toMatch(/errcode = 'P0002'/);
    expect(CINT).toMatch(
      /revoke all on function app\.crm_tombstone_follow\(uuid, uuid\) from public, anon, authenticated, service_role;\n[^\n]*\ngrant execute on function app\.crm_tombstone_follow\(uuid, uuid\) to service_role;/,
    );
    // A basis row moves only when the survivor has none (one per contact, C15's key).
    expect(follow).toMatch(/not exists \(select 1 from public\.crm_contact_imports o/);
  });
});
