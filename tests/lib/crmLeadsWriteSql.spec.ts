import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// What can be checked about migration 0041 without a database (pgTAP runs only in CI,
// supabase/tests/crm_leads_write.test.sql): the order of its statements where the order is
// the point.

const SQL = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0041_crm_leads_write.sql'),
  'utf8',
).replace(/--[^\n]*/g, '');

const at = (statement: RegExp): number => {
  const match = statement.exec(SQL);
  expect(match, String(statement)).not.toBeNull();
  return match!.index;
};

/** The body of one function, from its `create or replace` to the end of its `$$`. */
function body(name: string): string {
  const start = SQL.indexOf(`create or replace function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const open = SQL.indexOf('$$', start);
  const close = SQL.indexOf('end $$;', open);
  return SQL.slice(open, close);
}

describe('leads_bulk_update judges what it did not change in a second statement', () => {
  // A lead another session changes while the UPDATE waits on it is left alone (READ
  // COMMITTED re-checks the version). Judged in the same statement, its old version still
  // matched and it came back "skipped"; a second statement takes a fresh snapshot and sees
  // the version that won. pgTAP cannot open the second session this needs, so the shape is
  // pinned here.
  const fn = body('public.leads_bulk_update');
  const update = fn.indexOf('update public.leads l');
  const into = fn.indexOf('into v_applied');
  const judged = fn.indexOf('return query');

  it('the UPDATE answers only what it changed, into a variable', () => {
    expect(update).toBeGreaterThan(0);
    expect(into).toBeGreaterThan(update);
    expect(fn.slice(update, into)).not.toMatch(/'conflict'|'skipped'|'missing'/);
  });

  it('the outcomes come from a later statement that reads the leads again', () => {
    expect(judged).toBeGreaterThan(into);
    const judging = fn.slice(judged);
    expect(judging).not.toMatch(/update public\.leads/);
    expect(judging).toMatch(/left join public\.leads l/);
    expect(judging).toMatch(/'conflict'/);
    // VOLATILE: each statement of the function takes its own snapshot.
    expect(SQL).toMatch(
      /returns table \(lead_id uuid, lead_version int, outcome text\)\s+language plpgsql volatile/,
    );
  });
});

describe('0041 runs twice cleanly', () => {
  it('drops the assignee key before the unique constraint it depends on', () => {
    // Postgres refuses to drop a unique constraint a foreign key still references, so on a
    // second run the old order failed at the profiles drop.
    const dropKey = at(/alter table public\.leads drop constraint if exists leads_assignee_fk/);
    const dropUnique = at(
      /alter table public\.profiles drop constraint if exists profiles_tenant_id_id/,
    );
    const addUnique = at(/alter table public\.profiles add constraint profiles_tenant_id_id/);
    const addKey = at(/alter table public\.leads add constraint leads_assignee_fk/);
    expect(dropKey).toBeLessThan(dropUnique);
    expect(dropUnique).toBeLessThan(addUnique);
    expect(addUnique).toBeLessThan(addKey);
  });
});
