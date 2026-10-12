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

describe('a service-role lead write names whom it acts for in app.acting_for', () => {
  // The note door clears a legacy field for the person deleting its mirror. Writing
  // updated_by could not say who that is: a value equal to the lead's last editor reads as
  // unchanged, and the deleter usually saved the field last. pgTAP proves the outcome in CI
  // (crm_leads_write.test.sql); the shape it depends on is pinned here.
  it('the BEFORE phase takes the session first, then the named person, and nothing written', () => {
    expect(body('app.tg_lead_pipeline')).toMatch(
      /elsif v_edited then\s+new\.updated_at := now\(\);\s+new\.updated_by := coalesce\(auth\.uid\(\),\s+nullif\(current_setting\('app\.acting_for', true\), ''\)::uuid\);\s+else/,
    );
  });

  it('the AFTER phase takes the person the BEFORE phase recorded', () => {
    expect(body('app.tg_lead_timeline')).toMatch(
      /v_actor uuid := coalesce\(auth\.uid\(\),\s+case when tg_op = 'INSERT' then new\.created_by else new\.updated_by end\);/,
    );
  });

  it('the door names the deleter for its one write, then puts back what was there', () => {
    const door = body('public.crm_delete_lead_note');
    const name = door.indexOf("set_config('app.acting_for', p_actor::text, true)");
    const write = door.indexOf('update public.leads l set internal_notes = null');
    const restore = door.indexOf("set_config('app.acting_for', coalesce(v_acting, ''), true)");
    const remove = door.indexOf('delete from public.lead_notes');
    expect(name).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(name);
    expect(restore).toBeGreaterThan(write);
    expect(remove).toBeGreaterThan(restore);
    expect(door.slice(write, restore)).not.toMatch(/updated_by/);
  });

  it('only ever sets it for the transaction, so a pooled connection never carries it on', () => {
    const sets = SQL.match(/set_config\('app\.acting_for',[^\n]*/g) ?? [];
    expect(sets).toHaveLength(2);
    for (const set of sets) expect(set.trimEnd()).toMatch(/, true\);$/);
  });
});

describe('0041 never queues behind a busy table', () => {
  it('sets a five-second lock timeout for the migration before any other statement', () => {
    // It locks leads, profiles and lead_events ACCESS EXCLUSIVE; a wait behind a long reader
    // would stall sign-ins, the admin and the contact form. `set local`: transaction-local.
    expect(SQL.trimStart()).toMatch(/^set local lock_timeout = '5s';/);
    expect(SQL.match(/lock_timeout/g)).toHaveLength(1);
  });
});

describe('the postconditions check every grant the doors stand on', () => {
  // The DO block that ends 0041 fails the push when a grant is wrong. A gap here would fail
  // closed (a door answering 42501), but at the first erasure or export rather than at the
  // push, so the final review's list is pinned. A check preceded by `not` names a privilege
  // the role must hold; any other names one it must not.
  const block = SQL.slice(SQL.lastIndexOf('do $$'));
  const checks = [
    ...block.matchAll(
      /(not\s+)?has_(table|any_column|schema|function)_privilege\(\s*'([^']+)',\s*'([^']+)',\s*'([^']+)'\s*\)/g,
    ),
  ].flatMap(([, not, kind, role, object, privileges]) =>
    privileges!
      .split(',')
      .map((p) => `${not ? 'holds' : 'lacks'} ${kind} ${role} ${object} ${p.trim()}`),
  );
  const TABLE = ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger'];
  const COLUMN = ['select', 'insert', 'update', 'references'];

  it('anon and PUBLIC hold nothing on leads or leads_safe, table-wide or on a column', () => {
    for (const role of ['anon', 'public']) {
      for (const object of ['public.leads', 'public.leads_safe']) {
        for (const p of TABLE) expect(checks).toContain(`lacks table ${role} ${object} ${p}`);
        for (const p of COLUMN) expect(checks).toContain(`lacks any_column ${role} ${object} ${p}`);
      }
    }
  });

  it('staff still read leads_safe, write nothing through it, and insert no lead column', () => {
    expect(checks).toContain('holds table authenticated public.leads_safe select');
    for (const p of TABLE.filter((p) => p !== 'select')) {
      expect(checks).toContain(`lacks table authenticated public.leads_safe ${p}`);
    }
    for (const p of ['insert', 'update', 'references']) {
      expect(checks).toContain(`lacks any_column authenticated public.leads_safe ${p}`);
    }
    for (const p of ['insert', 'references']) {
      expect(checks).toContain(`lacks any_column authenticated public.leads ${p}`);
    }
  });

  it('the service role holds what its doors run on, and may not rewrite a thread note', () => {
    for (const held of [
      'schema service_role app usage',
      'table service_role public.lead_notes select',
      'table service_role public.lead_notes delete',
      'table service_role public.lead_events select',
      'table service_role public.lead_events insert',
      'table service_role public.crm_settings select',
      'function service_role app.lead_score(text[], jsonb) execute',
    ]) {
      expect(checks).toContain(`holds ${held}`);
    }
    expect(checks).toContain('lacks table service_role public.lead_notes update');
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
