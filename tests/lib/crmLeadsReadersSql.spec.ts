import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEAD_CHANNELS, LEAD_SOURCES } from '@schemas/crm';

// What can be checked about migration 0063 (Admin v2 C4a, the leads readers v2) without a
// database (pgTAP runs in CI: supabase/tests/crm_leads_readers_v2.test.sql): the order of its
// statements, its grants, the one ordering the list and Previous/Next share, and the closed
// lists it repeats from packages/schemas/crm.ts.

const read = (file: string) =>
  readFileSync(join(process.cwd(), 'supabase', 'migrations', file), 'utf8').replace(
    /--[^\n]*/g,
    '',
  );
const SQL = read('0063_crm_leads_readers_v2.sql');

const at = (needle: string): number => {
  const index = SQL.indexOf(needle);
  expect(index, needle).toBeGreaterThanOrEqual(0);
  return index;
};

/** The body of one function, from its `create` to the end of its dollar-quoted body. */
function body(name: string): string {
  const start = SQL.search(
    new RegExp(`create (or replace )?function ${name.replace('.', '\\.')}\\(`),
  );
  expect(start, name).toBeGreaterThanOrEqual(0);
  const open = SQL.indexOf('$$', start);
  const close = SQL.indexOf('$$;', open + 2);
  return SQL.slice(open, close);
}

/** The function signatures 0063 creates or restates, as its grants name them. */
const FUNCTIONS = {
  'app.lead_filter': 'jsonb, boolean',
  'app.lead_over_sla': 'text, boolean, timestamptz, timestamptz, boolean, int',
  'app.leads_matching': 'uuid, jsonb, boolean',
  'public.leads_list': 'uuid, jsonb',
  'public.leads_board': 'uuid, jsonb',
  'public.lead_summary': 'uuid, jsonb',
  'public.lead_neighbours': 'uuid, uuid, jsonb',
} as const;

describe('0063 never queues behind a busy table', () => {
  it('sets a five-second lock timeout before any other statement, once', () => {
    expect(SQL.trimStart()).toMatch(/^set local lock_timeout = '5s';/);
    expect(SQL.match(/lock_timeout/g)).toHaveLength(1);
  });
});

describe('the drops come before the creates', () => {
  it('app.lead_filter and leads_board are dropped, then created (their RETURNS TABLE grows)', () => {
    for (const [drop, create] of [
      [
        'drop function if exists app.lead_filter(jsonb, boolean);',
        'create function app.lead_filter(',
      ],
      [
        'drop function if exists public.leads_board(uuid, jsonb);',
        'create function public.leads_board(',
      ],
    ] as const) {
      expect(at(drop)).toBeLessThan(at(create));
    }
    // Nothing else is dropped: the other readers keep their signatures (create or replace).
    expect(SQL.match(/drop function/g)).toHaveLength(2);
  });

  it('every reader is created after the filter and the matching set it calls', () => {
    const filter = at('create function app.lead_filter(');
    const matching = at('create or replace function app.leads_matching(');
    expect(matching).toBeGreaterThan(filter);
    for (const reader of [
      'create or replace function public.leads_list(',
      'create function public.leads_board(',
      'create or replace function public.lead_summary(',
      'create or replace function public.lead_neighbours(',
    ]) {
      expect(at(reader), reader).toBeGreaterThan(matching);
    }
  });
});

describe('the grants are stated, never inherited (P-14)', () => {
  for (const [name, args] of Object.entries(FUNCTIONS)) {
    it(`${name}: everything revoked, then EXECUTE for authenticated only`, () => {
      const signature = `${name}(${args})`;
      const revoke = SQL.replace(/\s+/g, ' ').indexOf(
        `revoke all on function ${signature} from public, anon, authenticated, service_role;`,
      );
      const grant = SQL.replace(/\s+/g, ' ').indexOf(
        `grant execute on function ${signature} to authenticated;`,
      );
      expect(revoke, `revoke ${signature}`).toBeGreaterThanOrEqual(0);
      expect(grant, `grant ${signature}`).toBeGreaterThan(revoke);
    });
  }

  it('grants nothing to anon or the service role, and nothing on a table', () => {
    const grants = SQL.replace(/\s+/g, ' ').match(/grant [^;]+;/g) ?? [];
    expect(grants).toHaveLength(Object.keys(FUNCTIONS).length);
    for (const grant of grants) {
      expect(grant).toMatch(/^grant execute on function .+ to authenticated;$/);
    }
    // Expand only, and no new read path: no table, column, policy or view changes.
    expect(SQL).not.toMatch(/\balter table\b|\bcreate (or replace )?view\b|\bcreate policy\b/);
  });

  it('every reader runs as the caller: no definer in this file', () => {
    expect(SQL).not.toMatch(/security definer/);
    for (const reader of [
      'leads_matching',
      'leads_list',
      'leads_board',
      'lead_summary',
      'lead_neighbours',
    ]) {
      expect(SQL).toMatch(new RegExp(`function (app|public)\\.${reader}\\([^$]*security invoker`));
    }
  });
});

describe('the postconditions', () => {
  const block = SQL.slice(SQL.lastIndexOf('do $$'));

  it('name every function 0063 creates', () => {
    for (const name of Object.keys(FUNCTIONS)) expect(block, name).toContain(`'${name}(`);
  });

  it("hold the leads grants at 0041's sets exactly (C4a widens no grant)", () => {
    const arrays = (sql: string) => {
      const pick = (name: string) => {
        const match = new RegExp(`${name} constant text\\[\\] := array\\[([^\\]]+)\\]`).exec(sql);
        expect(match, name).not.toBeNull();
        return [...match![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
      };
      return { read: pick('v_read'), write: pick('v_write') };
    };
    const ours = arrays(block);
    const c3 = read('0041_crm_leads_write.sql');
    const theirs = arrays(c3.slice(c3.lastIndexOf('do $$')));
    expect(ours).toEqual(theirs);
  });

  it('check anon, PUBLIC and the service role hold no EXECUTE, and the live check stands', () => {
    expect(block).toMatch(/array\['anon', 'public', 'service_role'\]/);
    expect(block).toContain("policyname = 'leads_live'");
    expect(block).toContain("permissive = 'RESTRICTIVE'");
    expect(block).toContain("current_setting('c4a.leads_columns', true)");
  });
});

describe('one ordering for the list, the board and Previous/Next (D14)', () => {
  it('only app.leads_matching orders the list; the readers read its positions', () => {
    const matching = body('app.leads_matching');
    expect(matching).toMatch(/row_number\(\) over \(/);
    // 'newest' is 0036's order exactly: the case branches are null for it.
    expect(matching).toMatch(
      /order by case when f\.sort = 'starred' then l\.is_starred end desc nulls last,\s+case when f\.sort = 'score' then l\.score end desc nulls last,\s+case when f\.sort = 'oldest' then l\.created_at end asc,\s+l\.created_at desc, l\.id\)/,
    );
    for (const reader of ['public.leads_list', 'public.lead_neighbours', 'public.leads_board']) {
      const fn = body(reader);
      expect(fn, reader).toContain('app.leads_matching(p_tenant, p_filter');
      expect(fn, reader).not.toMatch(/order by[^)]*created_at desc/);
    }
  });

  it('the list and the summary share one SLA rule', () => {
    expect(body('public.leads_list')).toContain('app.lead_over_sla(');
    expect(body('public.lead_summary')).toContain('app.lead_over_sla(');
    expect(body('app.lead_over_sla')).toContain('not p_spam');
  });
});

describe('the filter repeats the schema lists', () => {
  const filter = body('app.lead_filter');
  const list = (pattern: RegExp) => {
    const match = pattern.exec(filter);
    expect(match, String(pattern)).not.toBeNull();
    return [...match![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  };

  it('source: LEAD_SOURCES', () => {
    expect(list(/source not in \(([^)]+)\)/)).toEqual([...LEAD_SOURCES]);
  });

  it('channel: LEAD_CHANNELS', () => {
    expect(list(/channel not in \(([^)]+)\)/)).toEqual([...LEAD_CHANNELS]);
  });

  it("'me' is the session's user, never a value the client sends", () => {
    expect(filter).toMatch(
      /if v_assigned = 'me' then\s+assigned_kind := 'me';\s+assigned_id := auth\.uid\(\);/,
    );
  });

  it('the board refuses a stage, a spam flag, a sort and a page', () => {
    expect(filter).toMatch(
      /if p_board and \(stage is not null or f \?\| array\['spam', 'sort', 'limit', 'offset'\]\)/,
    );
  });
});
