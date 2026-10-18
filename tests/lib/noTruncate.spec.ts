import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Migration 0066 (Admin v2 R5) took TRUNCATE away from every API role on every table the
// release guard watches: TRUNCATE fires no row trigger, so neither the guard nor the capture
// would see it. A privilege removal needs a gate, not a grep (w3 corrections, rule 6): no
// code the Worker, an operator script or an Edge Function runs may truncate anything. Seeds
// and restores run as the migration role, outside these folders. Should a TRUNCATE ever be
// needed, it belongs in a migration (or a runbook step run as the migration role), and this
// test is where that decision is made, on purpose.

const ROOTS = ['src', 'scripts', join('supabase', 'functions')];
const TEXT = /\.(ts|tsx|js|mjs|cjs|astro|sql|sh|ps1|json|md)$/;
/** The statement (any spelling: TABLE, ONLY, IF EXISTS, a quoted name), and an RPC naming it. */
const TRUNCATES = [
  /\btruncate\s+(table\s+)?(only\s+)?(if\s+exists\s+)?["a-z_]/i,
  /\brpc\(\s*['"`][^'"`]*truncate/i,
];

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules') return [];
    return statSync(path).isDirectory() ? files(path) : TEXT.test(name) ? [path] : [];
  });
}

describe('no code truncates a table (0066 revoked TRUNCATE from every API role)', () => {
  it('scans the Worker, the scripts and the Edge Functions', () => {
    expect(files('src').length).toBeGreaterThan(100);
    expect(files('scripts').length).toBeGreaterThan(5);
  });

  it('none of them runs TRUNCATE, as a statement or through an RPC', () => {
    const found: string[] = [];
    for (const root of ROOTS) {
      for (const file of files(root)) {
        const text = readFileSync(file, 'utf8');
        text.split('\n').forEach((line, index) => {
          if (TRUNCATES.some((re) => re.test(line))) {
            found.push(`${relative('.', file)}:${index + 1}`);
          }
        });
      }
    }
    expect(found).toEqual([]);
  });

  it('the patterns catch every way of writing it, and not a privilege check or `truncated`', () => {
    const hits = (line: string) => TRUNCATES.some((re) => re.test(line));
    expect(hits('truncate public.services;')).toBe(true);
    expect(hits('  TRUNCATE TABLE ONLY public.redirects CASCADE')).toBe(true);
    expect(hits('truncate table if exists "portfolio_media"')).toBe(true);
    expect(hits("await sb.rpc('truncate_services')")).toBe(true);
    expect(
      hits("has_table_privilege(r.oid, 'app.deployment', 'insert,update,delete,truncate')"),
    ).toBe(false);
    expect(hits('return { rows, truncated: true };')).toBe(false);
  });
});
