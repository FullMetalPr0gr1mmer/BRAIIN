import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RELEASE_ENTITY_TYPES } from '@schemas/release';
import { RELEASE_LINKS, SEO_TARGET_TABLES } from '@/lib/release/links';
import { RELEASE_REGISTRY } from '@/lib/release/registry';

// The publish's link fence (Admin v2 R6, src/lib/release/links.ts) must know every column a
// release writes that names another row, with the table and the ON DELETE the migrations declare:
// a column it missed would be written by the apply with no tenant check (R4 review 9).

const DIR = join(process.cwd(), 'supabase', 'migrations');
const SQL = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(DIR, f), 'utf8'))
  .join('\n')
  .replace(/\s+/g, ' ');

describe('RELEASE_LINKS', () => {
  it('names every allowlisted column that holds another row’s id', () => {
    for (const type of RELEASE_ENTITY_TYPES) {
      const entry = RELEASE_REGISTRY[type];
      const ids = entry.columns.filter((c) => c.endsWith('_id') && c !== 'entity_id');
      const named = (RELEASE_LINKS[type] ?? []).map((l) => l.column);
      expect([...named].sort(), type).toEqual([...ids].sort());
    }
  });

  it('each link is the foreign key the migrations declare, ON DELETE included', () => {
    for (const [type, links] of Object.entries(RELEASE_LINKS)) {
      for (const link of links ?? []) {
        const single = new RegExp(
          String.raw`${link.column} uuid( not null)? references public\.${link.table} \(id\) on delete ${link.removed}`,
        );
        const composite = new RegExp(
          String.raw`foreign key \(tenant_id, ${link.column}\) references public\.${link.table} \(tenant_id, id\) on delete ${link.removed}`,
        );
        expect(single.test(SQL) || composite.test(SQL), `${type}.${link.column}`).toBe(true);
      }
    }
  });

  it('entity SEO targets are the four types its CHECK allows', () => {
    expect(SQL).toContain(
      "entity_type text not null check (entity_type in ('service', 'blog_post', 'portfolio', 'page'))",
    );
    expect(Object.keys(SEO_TARGET_TABLES).sort()).toEqual([
      'blog_post',
      'page',
      'portfolio',
      'service',
    ]);
  });
});
