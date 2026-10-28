import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// What can be checked about migration 0041 without a database (pgTAP runs only in CI,
// supabase/tests/crm_leads_write.test.sql): the order of its statements where the order is
// the point. Where a later migration restated one of its functions (the leads contract, C14b,
// restated the lead triggers and the note door), the latest definition is the one checked.

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');
const uncommented = (file: string) =>
  readFileSync(join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '');

const SQL = uncommented('0041_crm_leads_write.sql');

const at = (statement: RegExp): number => {
  const match = statement.exec(SQL);
  expect(match, String(statement)).not.toBeNull();
  return match!.index;
};

/** The body of one function in `sql`, from its `create or replace` to the end of its `$$`. */
function bodyIn(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const open = sql.indexOf('$$', start);
  const close = sql.indexOf('end $$;', open);
  return sql.slice(open, close);
}

/** The body of one function as 0041 defines it. */
const body = (name: string): string => bodyIn(SQL, name);

/** The body of one function as the LAST migration that defines it leaves it, and that file. */
function latest(name: string): { file: string; fn: string } {
  const file = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => uncommented(f).includes(`create or replace function ${name}(`))
    .pop();
  expect(file, name).toBeDefined();
  return { file: file!, fn: bodyIn(uncommented(file!), name) };
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

describe('a service-role lead write is the session\u2019s, or no one\u2019s (the leads contract, C14b)', () => {
  // 0041 let the note door name the person it acted for in app.acting_for, for the one write
  // that cleared the legacy notes field. C14b dropped the field, restated the door without that
  // write and the BEFORE phase without the setting: an edit's person is the session's, and a
  // service-role edit made for no one is no one's. pgTAP proves the outcome in CI
  // (crm_leads_write.test.sql); the shape it depends on is pinned here, on the latest
  // definitions.
  const pipeline = latest('app.tg_lead_pipeline');
  const timeline = latest('app.tg_lead_timeline');
  const door = latest('public.crm_delete_lead_note');

  it('the BEFORE phase takes the session alone for an edit, and reads no setting', () => {
    expect(pipeline.fn).toMatch(
      /elsif v_edited then\s+new\.updated_at := now\(\);\s+new\.updated_by := auth\.uid\(\);\s+else/,
    );
    expect(pipeline.fn).not.toMatch(/acting_for|current_setting/);
  });

  it('the AFTER phase takes the person the BEFORE phase recorded', () => {
    expect(timeline.fn).toMatch(
      /v_actor uuid := coalesce\(auth\.uid\(\),\s+case when tg_op = 'INSERT' then new\.created_by else new\.updated_by end\);/,
    );
  });

  it('the note door deletes the note, then records it, and writes no lead and sets nothing', () => {
    const remove = door.fn.indexOf('delete from public.lead_notes');
    const record = door.fn.indexOf("'note_deleted'");
    expect(remove).toBeGreaterThan(0);
    expect(record).toBeGreaterThan(remove);
    expect(door.fn).not.toMatch(/update\s+public\.leads|set_config|acting_for/);
  });

  it('neither phase nor the door names a column the contract dropped', () => {
    for (const { fn } of [pipeline, timeline, door]) {
      expect(fn).not.toMatch(/\b(status|internal_notes|timeline_band|ip_inet)\b/);
    }
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
