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

  it('none of them says TRUNCATE (as SQL, an RPC or a word)', () => {
    const found: string[] = [];
    for (const root of ROOTS) {
      for (const file of files(root)) {
        const text = readFileSync(file, 'utf8');
        text.split('\n').forEach((line, index) => {
          // `truncated` (a flag several readers return) is not the statement.
          if (/\btruncate\b/i.test(line)) found.push(`${relative('.', file)}:${index + 1}`);
        });
      }
    }
    expect(found).toEqual([]);
  });
});
