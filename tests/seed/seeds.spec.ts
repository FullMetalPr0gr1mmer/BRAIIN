import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  generate,
  loadBlocks,
  rowForMode as rowForModeRaw,
  OUTPUTS,
} from '../../scripts/gen-seeds.mjs';
import { IDENTITY_FALLBACK } from '@/lib/identity/fallback';

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
    for (const { row } of published)
      expect(rowForMode(row, 'published')['status']).toBe('published');
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
