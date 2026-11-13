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
const C16 = read(/_crm_contact_files\.sql$/);
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
    // CINT-W-1 / XS-1: the other's company only when the survivor names none or the same one.
    expect(lines).toMatch(/company_id = case when k\.company_id is not null then k\.company_id/);
    expect(lines).toMatch(/when k\.company_name is null/);
    expect(lines).toMatch(/or app\.crm_name_key\(k\.company_name\) = \(select co\.name_key/);
    expect(lines).not.toMatch(/coalesce\(k\.company_id, d\.company_id\)/);
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
    const gone = after.indexOf(
      'delete from public.crm_contacts c where c.tenant_id = t.id and c.merged_into is not null',
    );
    for (const move of [
      'update public.crm_contact_files f set contact_id = c.merged_into',
      'update public.crm_contact_imports i set contact_id = c.merged_into',
    ]) {
      expect(after.indexOf(move), move).toBeGreaterThan(0);
      expect(after.indexOf(move), move).toBeLessThan(gone);
    }
  });

  it('the purge follows set-based: never the raising follow, never a lock per tombstone (CINT-SEC-1)', () => {
    const after = fn(CINT, 'app.purge_crm');
    expect(after).not.toMatch(/crm_tombstone_follow/);
    expect(after).not.toMatch(/pg_advisory/);
    expect(after).not.toMatch(/raise /);
  });

  it('keeps every lawful-basis row a contact carries (CINT-SEC-2)', () => {
    expect(CINT).toMatch(
      /alter table public\.crm_contact_imports drop constraint crm_contact_imports_one;/,
    );
    expect(CINT).toMatch(
      /create index crm_contact_imports_contact_idx on public\.crm_contact_imports \(tenant_id, contact_id\);/,
    );
  });

  it('audits an auto-company a merge removed, in a row of its own after the merge row (CINT-W-4)', () => {
    const merge = fn(CINT, 'public.crm_merge_contacts');
    const mergeRow = merge.indexOf("'crm.contact.merge', 'contact'");
    const companyRow = merge.indexOf("'crm.contact.merge.company_removed'");
    expect(mergeRow).toBeGreaterThan(0);
    expect(companyRow).toBeGreaterThan(mergeRow);
    // The company is captured once the tombstone has let it go, and before the follow.
    const captured = merge.indexOf('v_removed_company := d.company_id;');
    expect(captured).toBeGreaterThan(merge.indexOf('merged_into = p_keep, merged_at = now()'));
    expect(marked(merge)).toMatch(/'removed_company', v_removed_company/);
  });

  it('restates the file removal as C16 wrote it plus the lines marked -- C-int (CINT-W-3)', () => {
    const after = fn(CINT, 'public.crm_file_remove');
    expect(unmarked(after)).toBe(fn(C16, 'public.crm_file_remove'));
    const lines = marked(after);
    // Only when the named record's own row is gone, only its survivor's row, only that file.
    expect(lines).toMatch(/if v_path is null then/);
    expect(lines).toMatch(/f\.tenant_id = p_tenant and f\.id = p_file/);
    expect(lines).toMatch(/c\.merged_into is not null/);
    expect(CINT).toMatch(
      /revoke all on function public\.crm_file_remove\(uuid, uuid, uuid, uuid\) from public, anon, authenticated, service_role;\ngrant execute on function public\.crm_file_remove\(uuid, uuid, uuid, uuid\) to service_role;/,
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
    // Every basis row moves: the survivor keeps its own and gains the other's (CINT-SEC-2).
    expect(follow).toMatch(
      /update public\.crm_contact_imports i set contact_id = v_keep\n\s+where i\.tenant_id = p_tenant and i\.contact_id = p_tombstone;/,
    );
  });
});
