import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RELEASE_MAX_ITEMS } from '@schemas/release';

// What can be checked about migration 0051 (Admin v2 R4) without a database: the shape of
// its dynamic SQL, where the shape is the security property. pgTAP proves the behaviour in
// CI (supabase/tests/release_apply.test.sql); this pins how the statements are built, so a
// later edit cannot start concatenating a name or a value into SQL without failing here.

const DIR = join(process.cwd(), 'supabase', 'migrations');
const load = (file: string) => readFileSync(join(DIR, file), 'utf8').replace(/--[^\n]*/g, '');
const SQL = load('0051_release_apply.sql');

/**
 * Every migration that states `public.apply_release`, in the order they apply (0051, then
 * R10's restatement, 0104 until it is renumbered at merge): each is pinned below, and the last
 * is the one the database runs.
 */
const APPLY_FILES = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .filter((f) => load(f).includes('create or replace function public.apply_release('));

/** The body of one function in a text, from its `create or replace` to the end of its `$$`. */
function bodyIn(text: string, name: string): string {
  const start = text.indexOf(`create or replace function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const open = text.indexOf('$$', start);
  const close = text.indexOf('$$;', open + 2);
  return text.slice(open + 2, close);
}

/** The header of one function in a text: its arguments and settings, up to the body. */
function headerIn(text: string, name: string): string {
  const start = text.indexOf(`create or replace function ${name}(`);
  return text.slice(start, text.indexOf('$$', start));
}

const body = (name: string) => bodyIn(SQL, name);
const header = (name: string) => headerIn(SQL, name);

interface FormatCall {
  /** The format string, its adjacent literals joined. */
  template: string;
  /** The arguments after it, as written. */
  args: string[];
}

/** Every `format(...)` call in a text: its template and its arguments (top level only). */
function formatCalls(text: string): FormatCall[] {
  const calls: FormatCall[] = [];
  const re = /\bformat\(/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let i = m.index + m[0].length;
    const parts: string[] = [];
    // The template: one or more adjacent single-quoted literals.
    for (;;) {
      while (/\s/.test(text[i]!)) i++;
      if (text[i] !== "'") break;
      let j = i + 1;
      let lit = '';
      for (;;) {
        if (text[j] === "'" && text[j + 1] === "'") {
          lit += "'";
          j += 2;
        } else if (text[j] === "'") {
          break;
        } else {
          lit += text[j];
          j++;
        }
      }
      parts.push(lit);
      i = j + 1;
    }
    // The arguments: split on commas at depth 0, quotes respected.
    const args: string[] = [];
    let depth = 0;
    let cur = '';
    let quoted = false;
    for (; i < text.length; i++) {
      const c = text[i]!;
      if (quoted) {
        cur += c;
        if (c === "'") quoted = false;
        continue;
      }
      if (c === "'") {
        quoted = true;
        cur += c;
      } else if (c === '(') {
        depth++;
        cur += c;
      } else if (c === ')') {
        if (depth === 0) break;
        depth--;
        cur += c;
      } else if (c === ',' && depth === 0) {
        args.push(cur.trim());
        cur = '';
      } else {
        cur += c;
      }
    }
    if (cur.trim()) args.push(cur.trim());
    calls.push({ template: parts.join(''), args: args.slice(args[0] === '' ? 1 : 0) });
  }
  return calls;
}

/** The placeholders of a template, in order (%% is a literal percent sign). */
const placeholders = (template: string) =>
  [...template.replace(/%%/g, '').matchAll(/%([A-Za-z])/g)].map((m) => m[1]!);

// The three variables that hold a comma-separated list built from quoted names, and the only
// things a `%s` may splice into a statement.
const LISTS = ['v_list', 'v_list_cols', 'v_list_sel'];

describe('migration 0051 runs inside its own lock timeout', () => {
  it('sets lock_timeout before any other statement', () => {
    expect(SQL.trimStart().startsWith("set local lock_timeout = '5s';")).toBe(true);
  });
});

describe.each(APPLY_FILES)('%s', (file) => {
  const TEXT = load(file);

  describe('apply_release: settings and identity', () => {
    const head = headerIn(TEXT, 'public.apply_release');
    const fn = bodyIn(TEXT, 'public.apply_release');

    it('is SECURITY INVOKER, with an empty search_path and its lock waits bounded', () => {
      expect(head).toMatch(/language plpgsql volatile security invoker\s+set search_path = ''/);
      expect(head).toContain("set lock_timeout = '5s'");
      // Its statement_timeout bounds nothing inside a call; the migration must not say it does.
      expect(TEXT).not.toMatch(/must pin[^;]*statement_timeout/);
      expect(head).not.toMatch(/security definer/);
    });

    it('takes the full signature; before R11 it refuses schedule and fire, from R11 it runs them', () => {
      expect(TEXT).toContain(
        'public.apply_release(uuid, text, text, jsonb, text, text, uuid, uuid, timestamptz)',
      );
      const refuses = /if p_mode in \('schedule', 'fire'\) then\s+raise exception[^;]*R11/.test(fn);
      const runs = fn.includes("p_mode not in ('publish', 'dry_run', 'schedule', 'fire')");
      expect(refuses !== runs, file).toBe(true);
      if (runs) expect(file >= '0105', file).toBe(true);
    });

    it('refuses every caller but the service role, before anything else', () => {
      const first = fn.indexOf('if ');
      expect(fn.slice(first, fn.indexOf('end if;', first))).toMatch(
        /current_user::text <> 'service_role'/,
      );
    });

    it('caps a release at RELEASE_MAX_ITEMS', () => {
      expect(Number(/c_max_items constant int := (\d+);/.exec(fn)?.[1])).toBe(RELEASE_MAX_ITEMS);
    });

    it('switches role only to authenticated and back to the service role', () => {
      const roles = [...fn.matchAll(/set local role (\w+)/g)].map((m) => m[1]);
      expect(new Set(roles)).toEqual(new Set(['authenticated', 'service_role']));
    });

    it('puts the claims, the role and the token back on success and in its error handler', () => {
      // Two restores: the block's `when others` handler and step 9.
      const restores = fn.split("execute 'set local role service_role';").slice(1);
      expect(restores).toHaveLength(2);
      for (const after of restores) {
        const next = after.slice(0, after.indexOf("set_config('app.release_item', '', true)") + 60);
        for (const setting of [
          "set_config('request.jwt.claims', v_saved_claims, true)",
          "set_config('request.jwt.claim.sub', v_saved_sub, true)",
          "set_config('request.jwt.claim.role', v_saved_role, true)",
          "set_config('app.release_apply', '', true)",
          "set_config('app.release_id', '', true)",
          "set_config('app.release_item', '', true)",
        ]) {
          expect(next, setting).toContain(setting);
        }
      }
    });

    it('builds the claims from the live profile it read, never from the caller', () => {
      expect(fn).toMatch(
        /'app_metadata', pg_catalog\.jsonb_build_object\('role', p_role, 'tenant_id', v_tenant\)/,
      );
      // v_tenant is assigned once, from profiles.
      const assigns = [...fn.matchAll(/(select [^;]*into v_tenant|v_tenant :=)/g)];
      expect(assigns).toHaveLength(1);
      expect(assigns[0]![0]).toMatch(/select p\.tenant_id into v_tenant/);
      expect(fn).toMatch(/from public\.profiles p\s+where p\.id = p_actor\s+and p\.is_active/);
    });

    it('passes lock timeouts, deadlocks and serialization failures through, never as BR422', () => {
      const busy =
        /if v_state in \([^)]*'55P03', '40P01', '40001'\) then\s+raise exception '%', v_msg using errcode = v_state/g;
      // Both handlers: the per-change block's and the outer block's.
      expect([...fn.matchAll(busy)]).toHaveLength(2);
      const inner = fn.indexOf("if v_state in ('55P03', '40P01', '40001') then");
      expect(inner).toBeGreaterThan(0);
      // ...before the per-change handler turns anything else into a refusal.
      expect(inner).toBeLessThan(fn.indexOf("'apply_release: the database refused a change'"));
    });

    it('writes the audit row before it switches back (as the publisher, in the transaction)', () => {
      const audit = fn.indexOf('insert into public.audit_log');
      const back = fn.indexOf("execute 'set local role service_role';");
      expect(audit).toBeGreaterThan(fn.indexOf("execute 'set local role authenticated';"));
      expect(audit).toBeLessThan(back);
    });
  });

  describe('apply_release: the dynamic SQL', () => {
    const fn = bodyIn(TEXT, 'public.apply_release');
    const calls = formatCalls(fn);

    it('runs only format()-built statements, the stored statement, or a role switch', () => {
      const executes = [...fn.matchAll(/\bexecute\s+([^;]+);/g)].map((m) => m[1]!.trim());
      expect(executes.length).toBeGreaterThan(0);
      for (const target of executes) {
        const allowed =
          target.startsWith('pg_catalog.format(') ||
          /^'set local role (authenticated|service_role)'$/.test(target) ||
          /^v_it ->> 'sql' using /.test(target);
        expect(allowed, target).toBe(true);
      }
    });

    it('every stored statement is a format() result', () => {
      for (const m of fn.matchAll(/v_sql := ([^;]*);/g)) {
        expect(m[1]!.startsWith('pg_catalog.format(') || m[1] === 'null', m[1]).toBe(true);
      }
      for (const m of fn.matchAll(/'sql', ([^,)]+)/g)) {
        expect(['v_sql', 'pg_catalog.format(']).toContain(
          m[1]!.startsWith('pg_catalog.format(') ? 'pg_catalog.format(' : m[1]!.trim(),
        );
      }
    });

    it('quotes every identifier with %I and splices only quoted-name lists with %s', () => {
      expect(calls.length).toBeGreaterThan(5);
      for (const call of calls) {
        const marks = placeholders(call.template);
        expect(
          marks.every((p) => ['I', 'L', 's'].includes(p)),
          call.template,
        ).toBe(true);
        marks.forEach((p, i) => {
          if (p === 's')
            expect(LISTS, `${call.template} <- ${call.args[i]}`).toContain(call.args[i]);
        });
      }
    });

    it('builds each %s list from %I/%L-quoted parts only', () => {
      const statements = fn.split(';');
      for (const list of LISTS) {
        // A plpgsql `... into v_a, v_b` naming the list (not SQL's `insert into`).
        const building = statements.filter((s) =>
          new RegExp(String.raw`\binto\s+(?:\w+,\s*)*${list}\b`).test(s),
        );
        // ...and nothing else assigns it.
        expect(fn).not.toMatch(new RegExp(String.raw`\b${list}\s*:=`));
        expect(building.length, list).toBeGreaterThan(0);
        for (const s of building) {
          const aggs = [...s.matchAll(/string_agg\(\s*([^\s(]+)/g)].map((m) => m[1]!);
          expect(aggs.length, s).toBeGreaterThan(0);
          for (const agg of aggs) expect(agg, s).toBe('pg_catalog.format');
          for (const call of formatCalls(s)) {
            const marks = placeholders(call.template);
            expect(
              marks.every((p) => p === 'I' || p === 'L'),
              call.template,
            ).toBe(true);
          }
        }
      }
    });

    it('binds every value: nothing is concatenated into a statement', () => {
      for (const call of calls) {
        for (const arg of call.args) expect(arg, call.template).not.toMatch(/\|\|/);
        // A value never appears in a template: the table, key and columns come in through %I,
        // the data through $1 (jsonb_populate_record), $2 (the tenant) and $3 (the key).
        expect(call.template).not.toMatch(/'%[sIL]'/);
      }
      expect(fn).toMatch(/using v_it -> 'row', v_tenant, \(v_it ->> 'entity_id'\)::uuid/);
    });

    it('checks every patch key against the registry before building a statement', () => {
      const check = fn.indexOf('c.col <> all (v_reg.columns)');
      const exempt = fn.indexOf('c.col = any (v_reg.exempt_columns)');
      const firstBuild = fn.indexOf("'insert into public.%I");
      expect(check).toBeGreaterThan(0);
      expect(exempt).toBeGreaterThan(0);
      expect(firstBuild).toBeGreaterThan(check);
    });
  });
});

describe('the apply the database runs (the last statement of it)', () => {
  const fn = bodyIn(load(APPLY_FILES[APPLY_FILES.length - 1]!), 'public.apply_release');

  it('is restated after 0051 (R10)', () => {
    expect(APPLY_FILES[0]).toBe('0051_release_apply.sql');
    expect(APPLY_FILES.length).toBeGreaterThan(1);
  });

  it('a create a restore staged keeps the date the ledger saw it removed with (R10, 0104)', () => {
    // Which creates carry the restore's mark: read from the locked drafts, never the request.
    expect(fn).toMatch(
      /into v_restored\s+from public\.content_drafts d\s+where d\.tenant_id = v_tenant and d\.id = any \(v_draft_ids\)\s+and d\.op = 'create' and d\.origin_kind = 'restore'/,
    );
    // The date: the ledger's last removal of that row, in the publisher's tenant.
    expect(fn).toMatch(
      /select nullif\(i\.before -> 'published_at', 'null'::jsonb\) into v_pub\s+from public\.content_release_items i\s+where i\.tenant_id = v_tenant and i\.entity_type = v_it ->> 'entity_type'\s+and i\.entity_id = \(v_it ->> 'entity_id'\)::uuid and i\.op = 'delete'\s+order by i\.id desc\s+limit 1;/,
    );
    // Only for a restore's create; every other first publish is still stamped now().
    expect(fn).toMatch(
      /if \(v_it ->> 'has_published_at'\)::boolean and v_restored \? \(v_it ->> 'draft_id'\) then/,
    );
    const kept = fn.indexOf('if v_pub is not null then');
    expect(kept).toBeGreaterThan(0);
    expect(fn.indexOf("'published_at', pg_catalog.now()")).toBeGreaterThan(kept);
  });
});

describe('the other 0051 functions', () => {
  it('the capture trigger is a definer with an empty search_path, cheap outside a release', () => {
    const head = header('app.tg_release_capture');
    expect(head).toMatch(/security definer set search_path = ''/);
    const fn = body('app.tg_release_capture');
    // The token is asked first, and nothing else runs without it.
    expect(fn.trimStart().indexOf('begin')).toBeGreaterThan(-1);
    const begin = fn.indexOf('\nbegin');
    expect(fn.slice(begin).trimStart()).toMatch(
      /^begin\s+if not app\.release_token_valid\(\) then\s+return null;/,
    );
    expect(fn).not.toMatch(/app\.release_apply/);
  });

  it('the link-set helper and the purge recorder are SECURITY INVOKER with an empty search_path', () => {
    expect(header('app.apply_portfolio_children')).toMatch(/security invoker set search_path = ''/);
    expect(header('public.record_release_purge')).toMatch(/security invoker set search_path = ''/);
  });

  it('save_portfolio keeps its signature and delegates its child sets', () => {
    const head = header('public.save_portfolio');
    expect(head).toMatch(
      /p_id uuid,\s+p_version int,\s+p_values jsonb,\s+p_service_ids uuid\[\] default null,\s+p_media jsonb default null\s+\) returns table \(id uuid, version int\)/,
    );
    expect(head).toContain('security invoker set search_path = public, app, pg_temp');
    const fn = body('public.save_portfolio');
    expect(fn).toContain(
      'perform app.apply_portfolio_children(v_tenant, v_new.id, p_service_ids, p_media);',
    );
    expect(fn).not.toMatch(/delete from public\.portfolio_(services|media)/);
  });
});

describe('0051 can run twice', () => {
  it('replaces functions, drops a trigger before creating it, and creates no table', () => {
    expect(SQL).not.toMatch(/create function/);
    expect(SQL).not.toMatch(/create (table|index|policy|sequence|type)\b/);
    const drop = SQL.indexOf("execute format('drop trigger if exists %I on public.%I'");
    const create = SQL.indexOf(
      "execute format('create trigger %I after insert or update or delete",
    );
    expect(drop).toBeGreaterThan(0);
    expect(create).toBeGreaterThan(drop);
  });
});
