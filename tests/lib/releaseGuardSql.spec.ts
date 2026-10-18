import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// What can be checked about migration 0066 (Admin v2 R5) without a database: the shape of the
// guard and of its neighbours, where the shape is the security property. pgTAP proves the
// behaviour in CI (release_guard, release_capture, release_attention and rls_media_public);
// this pins what a later edit must not undo: no depth exemption, the token checked first,
// every allow path returning its row, identifiers through %I, the TRUNCATE revoke over the
// same tables as the guard, and no GUC set by any of it.

const RAW = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '0066_release_guard.sql'),
  'utf8',
);
const SQL = RAW.replace(/--[^\n]*/g, '');

/** The body of one function, from its `create ... function` to the end of its `$$`. */
function body(name: string): string {
  const start = SQL.search(
    new RegExp(`create (or replace )?function ${name.replace('.', '\\.')}\\(`),
  );
  expect(start, name).toBeGreaterThanOrEqual(0);
  const open = SQL.indexOf('$$', start);
  const close = SQL.indexOf('$$', open + 2);
  return SQL.slice(open + 2, close);
}

/** The header of one function: its arguments and settings, up to the body. */
function header(name: string): string {
  const start = SQL.search(
    new RegExp(`create (or replace )?function ${name.replace('.', '\\.')}\\(`),
  );
  return SQL.slice(start, SQL.indexOf('$$', start));
}

const DEFINERS = [
  'app.tg_release_guard',
  'app.tg_release_capture',
  'app.tg_release_links_stash',
  'app.tg_release_links_capture',
  'app.portfolio_link_sets',
  'app.publish_scheduled',
];

describe('migration 0066: the release guard', () => {
  it('takes its locks with a 5 s timeout, first', () => {
    expect(SQL.trim().startsWith("set local lock_timeout = '5s';")).toBe(true);
  });

  it('has no depth exemption in any function it defines', () => {
    for (const name of DEFINERS) expect(body(name), name).not.toMatch(/pg_trigger_depth/i);
    // The postconditions (the last DO block) are the only other place the word appears.
    expect(SQL.slice(0, SQL.lastIndexOf('do $$'))).not.toMatch(/pg_trigger_depth/i);
  });

  it('every definer pins search_path to empty', () => {
    for (const name of DEFINERS) {
      expect(header(name), name).toMatch(/security definer set search_path = ''\s+as\s*$/);
    }
  });

  it('the guard checks the release token before anything else', () => {
    const guard = body('app.tg_release_guard');
    const begin = guard.indexOf('\nbegin\n');
    expect(begin).toBeGreaterThan(0);
    expect(guard.slice(begin + 7).trimStart()).toMatch(/^if app\.release_token_valid\(\) then/);
  });

  it('every allow path returns OLD for a DELETE and NEW otherwise, never null', () => {
    const guard = body('app.tg_release_guard');
    const returns = [...guard.matchAll(/return (\w+);/g)].map((m) => m[1]);
    // Four allow paths (token, no API request, releases off, immediate column): the first
    // three return OLD on a DELETE then NEW; the immediate column is an UPDATE's only.
    expect(returns).toEqual(['old', 'new', 'old', 'new', 'old', 'new', 'new']);
    for (const m of guard.matchAll(/if tg_op = 'DELETE' then\s+return (\w+);/g)) {
      expect(m[1]).toBe('old');
    }
    expect(guard).not.toMatch(/return null/);
    expect(body('app.tg_release_links_stash')).not.toMatch(/return null/);
  });

  it('refuses with 42501 and the words staff see', () => {
    const guard = body('app.tg_release_guard');
    expect(guard).toContain("raise exception 'Live content changes only through a release.'");
    expect(guard).toContain("errcode = '42501'");
  });

  it('the trigger loops quote every identifier with %I', () => {
    const creates = [...SQL.matchAll(/execute format\('(create|drop) trigger[^;]*;/g)].map(
      (m) => m[0],
    );
    expect(creates.length).toBeGreaterThanOrEqual(6);
    for (const stmt of creates) {
      expect(stmt).not.toMatch(/%s|%L/);
      expect(stmt).toMatch(/%I/);
    }
  });

  it('the TRUNCATE revoke covers exactly the tables the guard loop does', () => {
    const loops = [
      ...SQL.matchAll(
        /for t in\s+(select e\.table_name from app\.release_entities e\s+union all\s+select x from unnest\(array\[[^\]]*\]\) as x\s+order by 1)\s+loop\s+([\s\S]*?)end loop;/g,
      ),
    ];
    expect(loops).toHaveLength(2);
    expect(loops[0]![1]).toBe(loops[1]![1]);
    expect(loops[0]![2]).toContain('__release_guard');
    expect(loops[1]![2]).toMatch(
      /revoke truncate on public\.%I from public, anon, authenticated, service_role/,
    );
  });

  it('sets no GUC: no set_config, no SET of the claims or the token', () => {
    for (const name of DEFINERS) expect(body(name), name).not.toMatch(/set_config/i);
    expect(body('public.media_usage')).not.toMatch(/set_config/i);
    expect(SQL).not.toMatch(/set_config\s*\(/i);
    expect(SQL).not.toMatch(/app\.release_apply/);
  });

  it('media_usage v4 is INVOKER with every name qualified', () => {
    expect(header('public.media_usage')).toMatch(/security invoker set search_path = ''/);
    const fn = body('public.media_usage');
    // Every relation is schema-qualified, and every function call is pg_catalog's or app's.
    for (const m of fn.matchAll(/\bfrom\s+([a-z_][a-z_.]*)/g)) {
      expect(m[1], m[0]).toMatch(/^(public|pg_catalog)\./);
    }
    for (const m of fn.matchAll(/\b([a-z_][a-z_0-9.]*)\s*\(/g)) {
      const name = m[1]!;
      if (['exists', 'coalesce', 'nullif', 'in', 'and', 'or', 'select', 'as', 'v'].includes(name)) {
        continue;
      }
      expect(name, m[0]).toMatch(/^(pg_catalog|app)\./);
    }
    // Every branch leads with the tenant.
    const branches = fn.split(/union all/);
    expect(branches).toHaveLength(9);
    for (const branch of branches) {
      expect(branch).toMatch(/where \w+\.tenant_id = app\.effective_tenant_id\(\)/);
    }
  });

  it('publish_scheduled skips a tenant with releases on', () => {
    expect(body('app.publish_scheduled')).toContain('and not app.releases_enabled(tenant_id)');
  });
});
