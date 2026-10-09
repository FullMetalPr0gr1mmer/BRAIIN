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
