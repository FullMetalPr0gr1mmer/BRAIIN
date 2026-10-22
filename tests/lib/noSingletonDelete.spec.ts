import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Migration 0102 (Admin v2 U9) states the grants of the two singletons, `site_profile` and
// `site_settings`, and so withdraws what the bootstrap ALL had left: DELETE, TRUNCATE,
// REFERENCES and TRIGGER for `authenticated` and `service_role` (site_settings' FOR ALL policy
// had admitted an Admin or Developer DELETE). A privilege removal needs a gate, not a grep
// (w3 corrections, rule 6): no code the Worker, an operator script or an Edge Function runs
// may delete either row, through the query builder, in SQL, or through an RPC that names
// either table. Each tenant has one row of each, read on every page; there is nothing to
// delete. Should a delete ever be needed, it belongs in a migration (or a runbook step run as
// the migration role, launch runbook §10), and this test is where that decision is made, on
// purpose. TRUNCATE is tests/lib/noTruncate.spec.ts's.

const ROOTS = ['src', 'scripts', join('supabase', 'functions')];
const TEXT = /\.(ts|tsx|js|mjs|cjs|astro|sql|sh|ps1|json|md)$/;
const TABLE = String.raw`site_(?:settings|profile)`;
/** A builder chain on either table that reaches `.delete(` before any other `.from(`. */
const BUILDER = new RegExp(
  String.raw`\.from\(\s*['"\x60]${TABLE}['"\x60]\s*\)(?:(?!\.from\()[\s\S]){0,600}?\.delete\(`,
  'g',
);
/** The statement (any spelling: ONLY, a schema, a quoted name), and an RPC naming either. */
const LINES = [
  new RegExp(String.raw`\bdelete\s+from\s+(?:only\s+)?(?:"?public"?\.)?"?${TABLE}"?\b`, 'i'),
  new RegExp(String.raw`\brpc\(\s*['"\x60][^'"\x60]*${TABLE}`, 'i'),
];

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') return [];
    return statSync(path).isDirectory() ? files(path) : TEXT.test(name) ? [path] : [];
  });
}

/** Every place in `text` that deletes a singleton row, as 1-based line numbers. */
function singletonDeletes(text: string): number[] {
  const lineOf = (index: number) => text.slice(0, index).split('\n').length;
  const found = new Set<number>();
  for (const match of text.matchAll(BUILDER)) found.add(lineOf(match.index ?? 0));
  text.split('\n').forEach((line, index) => {
    if (LINES.some((re) => re.test(line))) found.add(index + 1);
  });
  return [...found].sort((a, b) => a - b);
}

describe('no code deletes a site_profile or site_settings row (0102 withdrew DELETE)', () => {
  it('scans the Worker, the scripts and the Edge Functions', () => {
    expect(files('src').length).toBeGreaterThan(100);
    expect(files('scripts').length).toBeGreaterThan(5);
  });

  it('none of them deletes either row, through the builder, in SQL or through an RPC', () => {
    const found: string[] = [];
    for (const root of ROOTS) {
      for (const file of files(root)) {
        for (const line of singletonDeletes(readFileSync(file, 'utf8'))) {
          found.push(`${relative('.', file)}:${line}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  it('the patterns catch every way of writing it, and not a read, an update or another table', () => {
    const hits = (text: string) => singletonDeletes(text).length > 0;
    expect(hits("await sb.from('site_settings').delete().eq('tenant_id', t);")).toBe(true);
    expect(
      hits("await sb\n  .from('site_profile')\n  .delete()\n  .eq('tenant_id', auth.tenantId);"),
    ).toBe(true);
    expect(hits("sb.from(`site_profile`).select('version').eq('x', 1).delete()")).toBe(true);
    expect(hits('delete from public.site_settings where tenant_id = $1')).toBe(true);
    expect(hits('DELETE FROM ONLY "site_profile"')).toBe(true);
    expect(hits("await sb.rpc('reset_site_settings', { p_tenant: t })")).toBe(true);
    expect(hits("await sb.from('site_settings').select('timezone').maybeSingle()")).toBe(false);
    expect(hits("await sb.from('site_profile').update(values).eq('tenant_id', t)")).toBe(false);
    expect(hits("sb.from('site_settings').select('x'); sb.from('redirects').delete()")).toBe(false);
    expect(hits('delete from public.redirects where id = $1')).toBe(false);
    expect(hits("await sb.rpc('studio_time_zone')")).toBe(false);
  });
});
