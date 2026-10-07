import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  GATED_LEAD_COLUMNS,
  SAFE_LEAD_COLUMNS,
  SENSITIVE_LEAD_COLUMNS,
} from '@/lib/admin/leadFields';

// Migration 0033: staff tokens read leads through a COLUMN grant. Two things must stay
// true as both sides change:
//   1. The caller's client can read every column the admin selects through it
//      (SAFE_LEAD_COLUMNS). A column missing from the grant fails the whole query, and the
//      lead list, the detail and the dashboard count come back as errors.
//   2. No gated column is ever granted. Those are read as the service role, by the
//      audited paths only, and this file names which files those are.

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');

/**
 * The columns `authenticated` may SELECT on public.leads after every migration, replayed
 * in order: a table-level revoke clears them, a column grant adds, and a table-level
 * grant means every column ('*').
 */
function replayLeadSelectGrant(): Set<string> {
  let columns = new Set<string>();
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const statement =
    /\b(grant|revoke)\s+([a-z_, ]+?)(?:\s*\(([^)]*)\))?\s+on\s+(?:table\s+)?public\.leads\s+(?:to|from)\s+([a-z_, ]+)/gi;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8').replace(/--[^\n]*/g, '');
    for (const match of sql.matchAll(statement)) {
      const [, verb, privileges, columnList, roles] = match;
      const touchesSelect = /\b(select|all)\b/i.test(privileges ?? '');
      const toStaff = /\bauthenticated\b/i.test(roles ?? '');
      if (!touchesSelect || !toStaff) continue;
      if (verb!.toLowerCase() === 'revoke') {
        // Revoking the table privilege revokes the column privileges too (Postgres).
        if (!columnList) columns = new Set();
        else for (const c of columnList.split(',')) columns.delete(c.trim());
      } else if (!columnList) {
        columns = new Set(['*']);
      } else {
        for (const c of columnList.split(',')) columns.add(c.trim());
      }
    }
  }
  return columns;
}

describe('the leads SELECT grant (0033)', () => {
  const granted = replayLeadSelectGrant();

  it('is a column grant, never table-wide', () => {
    expect(granted.has('*')).toBe(false);
    expect(granted.size).toBeGreaterThan(5);
  });

  it("covers every column the admin reads through the caller's client", () => {
    for (const column of SAFE_LEAD_COLUMNS.split(',')) expect(granted, column).toContain(column);
    // The tenant predicate every admin query adds (crud.ts getRow/listRows, the counts).
    expect(granted).toContain('tenant_id');
  });

  it('grants no gated column, ciphertext or retention date', () => {
    const forbidden = [
      ...GATED_LEAD_COLUMNS.split(','),
      ...SENSITIVE_LEAD_COLUMNS,
      'retention_delete_after',
    ];
    for (const column of forbidden) expect(granted, column).not.toContain(column);
  });
});

// ── Who reads gated lead columns ──────────────────────────────────────────────────────

const SRC = join(process.cwd(), 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|astro)$/.test(name) ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(process.cwd(), path).replace(/\\/g, '/'),
  code: readFileSync(path, 'utf8'),
}));

describe('gated lead columns have a short, named list of readers', () => {
  it('only the reveal and the export use the gated projections', () => {
    const users = files
      .filter((f) => /\b(GATED_LEAD_COLUMNS|FULL_LEAD_COLUMNS)\b/.test(f.code))
      .map((f) => f.path)
      .sort();
    expect(users).toEqual([
      'src/lib/admin/leadFields.ts',
      'src/pages/api/admin/leads/[id].ts',
      'src/pages/api/admin/leads/export.ts',
    ]);
  });

  it('only these files touch leads as the service role', () => {
    const readers = files
      .filter((f) => /from\(\s*['"]leads['"]\s*\)/.test(f.code) && /\bserviceClient\b/.test(f.code))
      .map((f) => f.path)
      .sort();
    expect(readers).toEqual([
      // The public form's insert (service role, tenant resolved server-side).
      'src/lib/data/leads.ts',
      // The reveal and the export: after assertCap, a live recheck and a fail-closed audit.
      'src/pages/api/admin/leads/[id].ts',
      'src/pages/api/admin/leads/export.ts',
      // The notification hook: a signed call, re-fetches the row, filters by recipient role.
      'src/pages/api/hooks/notify-lead.ts',
    ]);
  });
});
