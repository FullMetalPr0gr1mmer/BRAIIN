import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// What can be checked about R10's migration (0104, a placeholder number renumbered at merge)
// without a database. pgTAP proves the behaviour in CI (supabase/tests/release_versions.test.sql);
// the backfill runs once, at migration time, before any test can see it, so its order is
// pinned here (replayed in PGlite during the review: two snapshots of one entity written in one
// transaction with the same version kept the order they were written in).

const DIR = join(process.cwd(), 'supabase', 'migrations');
const FILE = readdirSync(DIR).find((f) => /^\d{4}_release_versions\.sql$/.test(f));
const SQL = readFileSync(join(DIR, FILE ?? 'missing'), 'utf8').replace(/--[^\n]*/g, '');

describe('0104: the history already kept is numbered once, in the order it was written', () => {
  const backfill = SQL.slice(
    SQL.indexOf('update public.content_versions v'),
    SQL.indexOf(';', SQL.indexOf('update public.content_versions v')),
  );

  it('orders ties of one transaction by their place in the table before their random ids', () => {
    expect(backfill).toMatch(
      /partition by c\.tenant_id, c\.entity_type, c\.entity_id\s+order by c\.created_at, c\.version, c\.ctid, c\.id\)/,
    );
  });

  it('writes only rows with no number, so a second run reorders nothing', () => {
    expect(backfill).toMatch(/where v\.id = n\.id\s+and v\.seq is null$/);
  });

  it('numbers them before the trigger exists, which then numbers every insert', () => {
    expect(SQL.indexOf('update public.content_versions v')).toBeLessThan(
      SQL.indexOf('create trigger content_versions_seq'),
    );
  });
});
