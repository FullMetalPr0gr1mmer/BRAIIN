import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CRM_FILE_NAME_REFUSED, CrmFileNameSchema } from '@schemas/crmFiles';

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

  it('the name CHECK refuses exactly what CRM_FILE_NAME_REFUSED refuses (C16-SEC-4)', () => {
    const table = C16.slice(C16.indexOf('create table public.crm_contact_files ('));
    const source = /name !~ '\[([^'\]]*)\]'/.exec(table)?.[1];
    expect(source, 'the refused class in the name CHECK').toBeTruthy();
    // `\uXXXX` / `\UXXXXXXXX` escapes and ranges between them, every character accounted for.
    const escape = String.raw`\\u([0-9A-F]{4})|\\U([0-9A-F]{8})`;
    const item = new RegExp(`(?:${escape})(?:-(?:${escape}))?`, 'gy');
    const ranges: [number, number][] = [];
    let consumed = 0;
    for (const m of source!.matchAll(item)) {
      const from = parseInt(m[1] ?? m[2] ?? '', 16);
      const end = m[3] ?? m[4];
      ranges.push([from, end ? parseInt(end, 16) : from]);
      consumed += m[0].length;
    }
    expect(consumed, 'every character of the SQL set is an escape or a range').toBe(source!.length);
    const mismatches: string[] = [];
    // From 1: NUL cannot reach a text value. Surrogates are no code point a text value holds.
    for (let cp = 1; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const js = CRM_FILE_NAME_REFUSED.test(String.fromCodePoint(cp));
      const sql = ranges.some(([from, to]) => cp >= from && cp <= to);
      if (js !== sql) mismatches.push(cp.toString(16).toUpperCase());
    }
    // A new Unicode version that adds a format character fails here: add it to the class.
    expect(mismatches).toEqual([]);
    // The slash and the backslash: a second, plain class.
    const backslash = String.fromCharCode(92);
    expect(table).toContain(`and name !~ '[/${backslash}${backslash}]'),`);
  });

  it('the schema refuses a bidi override and keeps an Arabic name', () => {
    expect(CrmFileNameSchema.safeParse('invoice\u202Efdp.exe').success).toBe(false);
    expect(CrmFileNameSchema.safeParse('a\u2066b.pdf').success).toBe(false);
    expect(CrmFileNameSchema.safeParse('عقد هدى.pdf').success).toBe(true);
  });

  it('the storage belt is checked, not assumed (0045’s postcondition, C16-SEC-2)', () => {
    const post = C16.slice(C16.indexOf('═══ 10. Postconditions'));
    // The belt, when present, must be exactly the one §9 creates.
    expect(post).toContain(
      "'RESTRICTIVE ALL {anon,authenticated} (bucket_id <> ''crm-files''::text) (bucket_id <> ''crm-files''::text)'",
    );
    // Without it, a permissive storage.objects policy admitting anon or authenticated refuses
    // the push, by membership, PUBLIC included.
    expect(post).toMatch(/pl\.polpermissive/);
    expect(post).toMatch(/x\.role_oid = 0/);
    expect(post).toMatch(/pg_has_role\('anon', x\.role_oid, 'member'\)/);
    expect(post).toMatch(/pg_has_role\('authenticated', x\.role_oid, 'member'\)/);
    expect(post).toMatch(/has_table_privilege\('service_role', 'storage\.objects', 'select'\)/);
    // §9 no longer waves a missing belt through with a warning.
    const bucket = C16.slice(C16.indexOf('═══ 9. The bucket'), C16.indexOf('═══ 10.'));
    expect(bucket).not.toMatch(/raise warning 'C16: not permitted/);
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
