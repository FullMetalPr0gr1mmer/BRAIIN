import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  generate,
  loadBlocks,
  rowForMode as rowForModeRaw,
  OUTPUTS,
} from '../../scripts/gen-seeds.mjs';
import { IDENTITY_FALLBACK } from '@/lib/identity/fallback';
import { HEADER_FALLBACK, FOOTER_FALLBACK } from '@/lib/nav/fallback';

// supabase/seed.sql and supabase/seeds/production.sql are GENERATED from
// supabase/seed-data/*.json (scripts/gen-seeds.mjs). These are the tests that make that
// true rather than aspirational: a hand edit to either file, a placeholder that would go
// live in production, or a seed that forgets its production guard all fail here.

type Row = Record<string, unknown>;
// The generator is plain .mjs; widen its inferred row type to what the data really is.
const rowForMode = rowForModeRaw as unknown as (row: Row, mode: 'published' | 'production') => Row;
interface Block {
  table: string;
  rows: Row[];
  source: string;
}
const blocks = loadBlocks() as unknown as Block[];

describe('generated seed files', () => {
  it('supabase/seed.sql is exactly what the generator produces (no hand edits)', () => {
    expect(readFileSync(OUTPUTS.published, 'utf8')).toBe(generate('published'));
  });

  it('supabase/seeds/production.sql is exactly what the generator produces', () => {
    expect(readFileSync(OUTPUTS.production, 'utf8')).toBe(generate('production'));
  });

  it('seed.sql refuses to run in production, before it writes anything', () => {
    const sql = generate('published');
    const guard = sql.indexOf("exists (select 1 from app.deployment where env = 'production')");
    const firstInsert = sql.indexOf('insert into');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstInsert);
    expect(sql.trimEnd().endsWith('commit;')).toBe(true);
  });

  it('every statement is idempotent (conflict → do nothing, or insert-where-not-exists)', () => {
    for (const mode of ['published', 'production'] as const) {
      const statements = generate(mode)
        .split(';')
        .filter((s: string) => /insert into/.test(s));
      for (const s of statements) {
        expect(/on conflict \([^)]+\) do nothing|where not exists/.test(s), s.slice(0, 80)).toBe(
          true,
        );
      }
    }
  });
});

describe('placeholders never go live in production', () => {
  const placeholders = blocks.flatMap((b) =>
    b.rows.filter((r) => r['__placeholder']).map((r) => ({ table: b.table, row: r })),
  );

  it('the data actually contains placeholders (else this suite proves nothing)', () => {
    expect(placeholders.length).toBeGreaterThan(0);
  });

  it('in production mode no placeholder is published, scheduled or visible', () => {
    for (const { table, row } of placeholders) {
      const out = rowForMode(row, 'production');
      const label = `${table}:${String(row['slug'] ?? row['name'])}`;
      if ('status' in out) expect(['published', 'scheduled'], label).not.toContain(out['status']);
      if ('visible' in out) expect(out['visible'], label).toBe(false);
    }
  });

  it('published mode keeps placeholders as authored (dev/CI/staging mirror the mockup)', () => {
    const published = placeholders.filter(({ row }) => row['status'] === 'published');
    expect(published.length).toBeGreaterThan(0);
    for (const { row } of published) {
      // …unless the row states a published-mode override (the legacy demo rows are
      // archived there so local/CI/staging show exactly the mockup's projects).
      const override = (row['__published'] as Row | undefined)?.['status'];
      expect(rowForMode(row, 'published')['status']).toBe(override ?? 'published');
    }
  });

  it('meta keys never reach SQL', () => {
    for (const mode of ['published', 'production'] as const) {
      expect(generate(mode)).not.toMatch(/__placeholder|__published|__production/);
    }
  });
});

describe('site_profile seed', () => {
  const block = blocks.find((b) => b.table === 'site_profile');
  const row = block?.rows[0] as Row;

  it('matches the code fallback (the two identity copies cannot drift)', () => {
    const p = rowForMode(row, 'production');
    expect(p['brand_name']).toEqual(IDENTITY_FALLBACK.brandName);
    expect(p['contact_email']).toBe(IDENTITY_FALLBACK.contactEmail);
    expect(p['location']).toEqual(IDENTITY_FALLBACK.location);
    expect(p['address_locality']).toEqual(IDENTITY_FALLBACK.addressLocality);
    expect(p['founded_year']).toBe(IDENTITY_FALLBACK.foundedYear);
    expect(p['socials']).toEqual(IDENTITY_FALLBACK.socials);
  });

  it('applications are CLOSED in production and open only in dev/CI/staging', () => {
    expect(rowForMode(row, 'production')['accepting_applications']).toBe(false);
    expect(rowForMode(row, 'published')['accepting_applications']).toBe(true);
  });
});

describe('pages seed', () => {
  it('creates the six compositions the UI v2 routes read', () => {
    const slugs = blocks.find((b) => b.table === 'pages')?.rows.map((r) => r['slug']);
    expect(slugs).toEqual(['home', 'about', 'contact', 'portfolio', 'portfolio-all', 'join']);
  });
});

describe('navigation seed', () => {
  const rows = (location: string) =>
    blocks
      .filter((b) => b.table === 'navigation')
      .flatMap((b) => b.rows)
      .filter((r) => r['location'] === location)
      .map((r) => ({ href: r['href'], label: r['label'], isKey: r['is_key'] === true }));
  const fallback = (nodes: typeof HEADER_FALLBACK) =>
    nodes.map((n) => ({ href: n.href, label: n.label, isKey: n.is_key }));

  it('the seeded menus are exactly the code fallbacks (one list, two copies)', () => {
    // A freshly seeded site and a site on the fallback (DB down) must show the same menu.
    expect(rows('header')).toEqual(fallback(HEADER_FALLBACK));
    expect(rows('footer')).toEqual(fallback(FOOTER_FALLBACK));
  });

  it('marks exactly one header key link — the one kept visible at <=900px', () => {
    expect(rows('header').filter((r) => r.isKey)).toHaveLength(1);
    expect(rows('footer').filter((r) => r.isKey)).toHaveLength(0);
  });

  it('seeds a menu only while it is EMPTY — never into, or back into, an edited one', () => {
    // One guarded block per location: the check runs once, before any of its rows, and
    // looks at the WHOLE location — so production's authored menu is never mixed with ours,
    // and an item an editor deleted is not resurrected when the seed is run again.
    const sql = generate('production');
    const guards = [
      ...sql.matchAll(/if not exists \(select 1 from public\.navigation where [^)]*\)/g),
    ].map((m) => m[0]);
    expect(guards).toHaveLength(2);
    expect(guards[0]).toContain("location = 'header'");
    expect(guards[1]).toContain("location = 'footer'");
    for (const guard of guards) expect(guard).not.toContain('id not in');
    const blocks = sql
      .split('do $seed$')
      .slice(1)
      .filter((b: string) => b.includes('from public.navigation'));
    expect(blocks).toHaveLength(2);
    for (const block of blocks) expect(block).toContain('on conflict (id) do nothing');
  });
});

describe('UI v2 content seed (0020–0025)', () => {
  const rowsOf = (table: string) => blocks.filter((b) => b.table === table).flatMap((b) => b.rows);
  // Tables whose `is_placeholder` COLUMN arms the 0025 production guard.
  const GUARDED = [
    'portfolio',
    'testimonials',
    'team_members',
    'statistics',
    'clients',
    'page_sections',
  ];

  it('every static media key is a file the stills registry will find', () => {
    const media = rowsOf('media_assets').filter((r) => r['provider'] === 'static');
    expect(media.length).toBeGreaterThan(0);
    for (const row of media) {
      const key = String(row['storage_path']);
      expect(key).toMatch(/^stills\/[a-z0-9][a-z0-9/_-]*\.(jpe?g|png|webp|avif)$/);
      expect(existsSync(join(process.cwd(), 'src', 'assets', 'media', key)), key).toBe(true);
    }
  });

  it('a placeholder row in a guarded table also sets the is_placeholder COLUMN', () => {
    // The meta key only demotes the row in production.sql; the column is what the database
    // guard and the dashboard read. A row with one and not the other would slip past both.
    for (const table of GUARDED) {
      for (const row of rowsOf(table).filter((r) => r['__placeholder'])) {
        expect(row['is_placeholder'], `${table}:${String(row['slug'])}`).toBe(true);
      }
    }
  });

  it('production.sql leaves no is_placeholder row live (the 0025 guard would refuse it)', () => {
    for (const table of GUARDED) {
      for (const row of rowsOf(table).filter((r) => r['is_placeholder'] === true)) {
        const out = rowForMode(row, 'production');
        const label = `${table}:${String(row['slug'])}`;
        if ('status' in out) expect(['published', 'scheduled'], label).not.toContain(out['status']);
        if ('visible' in out) expect(out['visible'], label).not.toBe(true);
      }
    }
  });

  it('text[] columns are Postgres array literals — a JSON array would be cast to jsonb', () => {
    const ARRAY_COLUMNS: Record<string, string[]> = {
      media_assets: ['tags'],
      testimonials: ['placements'],
      statistics: ['placements'],
    };
    for (const [table, columns] of Object.entries(ARRAY_COLUMNS)) {
      for (const row of rowsOf(table)) {
        for (const column of columns) {
          if (!(column in row)) continue;
          expect(row[column], `${table}.${column}`).toMatch(/^\{[a-z0-9,_-]*\}$/);
        }
      }
    }
  });

  it('every published quote in dev/CI/staging carries (synthetic) consent; production none', () => {
    const quotes = rowsOf('testimonials');
    expect(quotes.length).toBeGreaterThan(0);
    for (const row of quotes) {
      const pub = rowForMode(row, 'published');
      if (pub['status'] === 'published') expect(pub['consent_obtained_at']).toBeTruthy();
      expect(rowForMode(row, 'production')['consent_obtained_at']).toBeUndefined();
    }
  });

  it('case-study media only points at seeded stills, with one hero and one final each', () => {
    const ids = new Set(rowsOf('media_assets').map((r) => r['id']));
    const perProject = new Map<string, { hero: number; final: number }>();
    for (const row of rowsOf('portfolio_media')) {
      if (row['media_id'] !== undefined)
        expect(ids.has(row['media_id']), String(row['id'])).toBe(true);
      const ref = row['portfolio_id'] as { $ref: { by: { slug: string } } };
      const slug = ref.$ref.by.slug;
      const count = perProject.get(slug) ?? { hero: 0, final: 0 };
      if (row['role'] === 'hero') count.hero += 1;
      if (row['role'] === 'final') count.final += 1;
      perProject.set(slug, count);
    }
    expect(perProject.size).toBeGreaterThan(0);
    for (const [slug, count] of perProject) expect(count, slug).toEqual({ hero: 1, final: 1 });
  });

  it('a project’s services and media are seeded only while it has none', () => {
    // Re-running production.sql on a later deploy must not resurrect a removed service or
    // re-insert a replaced hero (the one-hero index would abort the whole seed).
    for (const table of ['portfolio_services', 'portfolio_media']) {
      const block = (loadBlocks() as unknown as (Block & { unlessAuthored?: string[] })[]).find(
        (b) => b.table === table,
      );
      expect(block?.unlessAuthored, table).toEqual(['portfolio_id']);
    }
  });

  it('no seeded project is called "all" (the catalogue route)', () => {
    for (const row of rowsOf('portfolio')) expect(row['slug']).not.toBe('all');
  });
});
