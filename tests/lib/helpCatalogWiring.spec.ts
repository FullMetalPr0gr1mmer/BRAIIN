import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A slice built before H11's catalog (`app.put_help_guide`) reached main files its edited guide
// under docs/admin-v2/guides and marks where the put goes in its migration with TODO(H11)
// (U10: seo-and-redirects in 0073). The marker is a comment, which the help-set checks skip,
// so the merge that brings the catalog would ship the old guide text with every other test
// green. This turns it red instead: once the catalog is on the branch, no marker may remain
// (U10 review). Standalone on purpose: it reads only the migrations, so it survives the merge
// that replaces the help-set machinery.

const MIGRATIONS = 'supabase/migrations';
const migrations = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((file) => ({ file, sql: readFileSync(`${MIGRATIONS}/${file}`, 'utf8') }));

/** A migration that creates the catalog's put. */
function definesPut(sql: string): boolean {
  return /create\s+(or\s+replace\s+)?function\s+app\.put_help_guide\s*\(/i.test(sql);
}

describe('guides filed for the help catalog', () => {
  it('knows the catalog by its put', () => {
    expect(definesPut('create or replace function app.put_help_guide(p_guide jsonb)')).toBe(true);
    expect(definesPut('CREATE FUNCTION app.put_help_guide (p jsonb)')).toBe(true);
    expect(definesPut('-- select app.put_help_guide($guide$ {} $guide$::jsonb, 1);')).toBe(false);
  });

  it('once app.put_help_guide is on the branch, every TODO(H11) is wired', () => {
    const catalog = migrations.some(({ sql }) => definesPut(sql));
    const unwired = migrations.filter(({ sql }) => sql.includes('TODO(H11)')).map((m) => m.file);
    if (catalog) {
      expect(unwired, 'replace each marker with its app.put_help_guide call').toEqual([]);
    } else {
      // Before H11, the markers are where the puts will go: U10's migration (0073, a number
      // assigned at merge) holds one for seo-and-redirects.
      expect(unwired.some((file) => file.endsWith('_seo.sql'))).toBe(true);
    }
  });
});
