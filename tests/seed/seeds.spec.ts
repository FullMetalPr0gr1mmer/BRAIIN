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
      // Split on a statement's END (`;` then a newline): a value may itself hold `;` — the
      // renderer escapes an apostrophe in a body_html cache as `&#39;` — but a literal never
      // holds a newline (JSON.stringify writes it as a backslash escape).
      const statements = generate(mode)
        .split(/;\n/)
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
  it('creates the seven compositions the UI v2 routes read (Round 2: services)', () => {
    const slugs = blocks.find((b) => b.table === 'pages')?.rows.map((r) => r['slug']);
    expect(slugs).toEqual([
      'home',
      'about',
      'contact',
      'portfolio',
      'portfolio-all',
      'services',
      'join',
    ]);
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
    'service_cases', // 0028
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

describe('About composition seed (UI v2 PR8)', () => {
  const about = (loadBlocks() as unknown as (Block & { unlessAuthored?: string[] })[]).filter(
    (b) => b.source === '51-about.json' && b.table === 'page_sections',
  );
  const rows = about.flatMap((b) => b.rows);

  it('composes /about as the mockup orders it', () => {
    expect(rows.map((r) => r['type'])).toEqual(['aboutWho', 'leadership', 'statistics', 'social']);
  });

  it('seeds into the page only while it has no sections — never into an edited one', () => {
    expect(about.map((b) => b.unlessAuthored)).toEqual([['page_id']]);
  });

  it('every section content validates against its type (else it would render built-ins)', async () => {
    const { sectionContentIssues } = await import('@schemas/sections');
    for (const row of rows) {
      const type = row['type'] as Parameters<typeof sectionContentIssues>[0];
      expect(sectionContentIssues(type, row['content']), String(type)).toEqual([]);
    }
  });

  it('the poster is a seeded still — so it resolves on every environment', () => {
    const who = rows.find((r) => r['type'] === 'aboutWho')!;
    const mediaId = (who['content'] as { mediaId: string }).mediaId;
    const media = blocks.filter((b) => b.table === 'media_assets').flatMap((b) => b.rows);
    const poster = media.find((m) => m['id'] === mediaId);
    expect(poster?.['provider']).toBe('static');
    expect(poster?.['__placeholder']).toBeUndefined();
  });

  it('is real copy, not placeholder content: it ships visible in production too', () => {
    for (const row of rows) expect(rowForMode(row, 'production')['visible']).toBe(true);
  });
});

describe('load order: every reference points at a row an EARLIER block inserts', () => {
  // gen-seeds concatenates the files by name and each block is one statement. A `$ref`
  // resolved before its row exists is a subselect that quietly returns NULL (or a 23503
  // abort), and a bare FK uuid ahead of its row aborts the whole seed. Round 2 moved the
  // stills to 05 and put disciplines at 08 precisely because services (10) point at both.
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  type Ref = { $ref: { table: string; by: Record<string, unknown> } };
  const isRef = (v: unknown): v is Ref => typeof v === 'object' && v !== null && '$ref' in v;

  it('holds for every $ref and every *_id uuid, in both modes', () => {
    const earlier = new Map<string, Row[]>();
    const all: Row[] = [];
    let checked = 0;
    for (const block of blocks) {
      for (const row of block.rows) {
        for (const [column, value] of Object.entries(row)) {
          if (column.startsWith('__')) continue;
          const where = `${block.source}:${block.table}.${column}`;
          if (isRef(value)) {
            const { table, by } = value.$ref;
            const hit = (earlier.get(table) ?? []).some((r) =>
              Object.entries(by).every(([k, v]) => r[k] === v),
            );
            expect(hit, `${where} → ${table} ${JSON.stringify(by)}`).toBe(true);
            checked += 1;
          } else if (
            column.endsWith('_id') &&
            column !== 'tenant_id' &&
            typeof value === 'string' &&
            UUID.test(value)
          ) {
            expect(
              all.some((r) => r['id'] === value),
              `${where} → ${value}`,
            ).toBe(true);
            checked += 1;
          }
        }
      }
      // Only AFTER the whole block: a row cannot rely on a sibling of its own statement.
      earlier.set(block.table, [...(earlier.get(block.table) ?? []), ...block.rows]);
      all.push(...block.rows);
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('files load stills (05) and disciplines (08) before the services (10) that use them', () => {
    const at = (file: string) => blocks.findIndex((b) => b.source === file);
    expect(at('05-media-stills.json')).toBeGreaterThan(-1);
    expect(at('05-media-stills.json')).toBeLessThan(at('08-disciplines.json'));
    expect(at('08-disciplines.json')).toBeLessThan(at('10-services.json'));
    expect(at('42-portfolio.json')).toBeLessThan(at('45-service-cases.json'));
  });
});

describe('Round 2 catalogue seed (0028): five disciplines, 28 services, sample cases', () => {
  const rowsOf = (table: string) => blocks.filter((b) => b.table === table).flatMap((b) => b.rows);
  const refSlug = (v: unknown) => (v as { $ref: { by: { slug: string } } }).$ref.by.slug;

  const DISCIPLINES = ['branding', 'production', 'marketing', 'web', 'events'];
  const SERVICES: Record<string, string[]> = {
    branding: [
      'logo',
      'business-cards',
      'letterhead',
      'brand-guidelines',
      'stationery',
      'packaging',
      'powerpoint-templates',
      'company-profile',
    ],
    production: [
      'motion-graphics',
      'animation',
      'video-editing',
      'photo-video',
      'model-booking',
      'music-vo-sfx',
    ],
    marketing: [
      'marketing-strategy',
      'content-strategy',
      'advertising',
      'social-media',
      'campaigns',
      'content-creation',
      'copywriting',
    ],
    web: ['hosting', 'domain', 'seo-geo-aeo'],
    events: ['venue-booking', '3d-design', 'booth-production', 'booth-installation'],
  };

  it('the disciplines, in the design’s order, each with poster and clip window', () => {
    const d = rowsOf('disciplines');
    expect(d.map((r) => r['slug'])).toEqual(DISCIPLINES);
    expect(d.map((r) => r['sort_order'])).toEqual([10, 20, 30, 40, 50]);
    const windows = d.map((r) => [r['preview_start_s'], r['preview_end_s']]);
    expect(windows).toEqual([
      [5.9, 7.9],
      [0.05, 3.7],
      [3.9, 5.9],
      [15.9, 18.3],
      [13.4, 15.9],
    ]);
    for (const r of d) {
      expect(r['status'], String(r['slug'])).toBe('published');
      expect(r['__placeholder'], String(r['slug'])).toBeUndefined(); // real copy
    }
  });

  it('the 28 services, grouped as the design groups them, sort_order 10…280', () => {
    const s = rowsOf('services');
    expect(s.map((r) => r['slug'])).toEqual(Object.values(SERVICES).flat());
    expect(s.map((r) => r['sort_order'])).toEqual(s.map((_, i) => (i + 1) * 10));
    for (const r of s) {
      const discipline = refSlug(r['discipline_id']);
      expect(SERVICES[discipline], String(r['slug'])).toContain(r['slug']);
      expect(r['preview_video_path']).toBe('/media/showreel.mp4');
      expect(r['status']).toBe('published');
    }
    // the old 14 are gone from fresh databases (production archives or renames them, §6d)
    for (const old of ['branding', 'videography', 'montage', 'gaming', 'merchandise']) {
      expect(s.map((r) => r['slug'])).not.toContain(old);
    }
  });

  it('every service row satisfies the admin write schema (an editor can re-save it)', async () => {
    const { ServiceWriteSchema, DisciplineWriteSchema, ServiceCaseWriteSchema } =
      await import('@schemas/admin');
    for (const r of rowsOf('services')) {
      const parsed = ServiceWriteSchema.safeParse({
        slug: r['slug'],
        title: r['title'],
        blurb: r['blurb'],
        body: r['body'],
        shortTitle: r['short_title'],
        intro: r['intro'],
        valuePoints: r['value_points'],
        deliverables: r['deliverables'],
        clip: {
          path: r['preview_video_path'],
          startS: r['preview_start_s'],
          endS: r['preview_end_s'],
        },
      });
      expect(parsed.success, `${String(r['slug'])}: ${JSON.stringify(parsed.error?.issues)}`).toBe(
        true,
      );
    }
    for (const r of rowsOf('disciplines')) {
      const parsed = DisciplineWriteSchema.safeParse({
        slug: r['slug'],
        name: r['name'],
        short: r['short'],
        blurb: r['blurb'],
        clip: {
          path: r['preview_video_path'],
          startS: r['preview_start_s'],
          endS: r['preview_end_s'],
        },
      });
      expect(parsed.success, String(r['slug'])).toBe(true);
    }
    for (const r of rowsOf('service_cases')) {
      const parsed = ServiceCaseWriteSchema.safeParse({
        serviceId: '11111111-1111-4111-8111-111111111111',
        title: r['title'],
        context: r['context'],
        problems: r['problems'],
        results: r['results'],
      });
      expect(parsed.success, refSlug(r['service_id'])).toBe(true);
    }
  });

  it('the stored body_html is exactly what the renderer derives from the Tiptap body', async () => {
    const { renderTiptapToHtml } = await import('@/lib/content/tiptap');
    for (const r of rowsOf('services')) {
      const body = r['body'] as { en: unknown; ar: unknown };
      expect(r['body_html'], String(r['slug'])).toEqual({
        en: renderTiptapToHtml(body.en),
        ar: renderTiptapToHtml(body.ar),
      });
    }
  });

  it('each service has one sample case, told through a seeded project', () => {
    const cases = rowsOf('service_cases');
    expect(cases.map((r) => refSlug(r['service_id']))).toEqual(Object.values(SERVICES).flat());
    const projects = new Set(rowsOf('portfolio').map((r) => r['slug']));
    for (const r of cases) {
      expect(projects.has(refSlug(r['portfolio_id'])), refSlug(r['service_id'])).toBe(true);
      expect(r['__placeholder']).toBe(true);
      expect(r['is_placeholder']).toBe(true);
      expect(rowForMode(r, 'production')['status']).toBe('draft');
    }
  });

  it('the sample projects link the contract’s 14 services (the Our Work chip row)', () => {
    const links = new Map<string, string[]>();
    for (const r of rowsOf('portfolio_services')) {
      const p = refSlug(r['portfolio_id']);
      links.set(p, [...(links.get(p) ?? []), refSlug(r['service_id'])]);
    }
    expect(Object.fromEntries(links)).toEqual({
      'the-rider': ['photo-video', 'advertising'],
      'kitchen-hours': ['advertising', 'photo-video', 'social-media'],
      notebook: ['logo'],
      ink: ['motion-graphics', 'music-vo-sfx'],
      terrain: ['photo-video'],
      'first-light': ['venue-booking', 'motion-graphics'],
      'dust-trail': ['social-media', 'video-editing'],
      'the-table': ['photo-video'],
      'field-notes': ['hosting', 'content-strategy', 'seo-geo-aeo'],
      'sunday-sessions': ['music-vo-sfx', 'animation'],
      blueprint: ['business-cards', '3d-design'],
      'opening-night': ['photo-video', 'video-editing'],
    });
    expect(new Set([...links.values()].flat()).size).toBe(14);
  });

  it('the home stat reads 28 services; the Services page gets four sample stats', () => {
    const stats = rowsOf('statistics');
    const crafts = stats.find((r) => r['slug'] === 'crafts')!;
    expect(crafts['value']).toBe('28');
    expect(crafts['value_numeric']).toBe(28);
    expect(crafts['label']).toEqual({ en: 'Services under one roof', ar: 'خدمة تحت سقف واحد' });
    const services = stats.filter((r) => String(r['placements']).includes('services'));
    expect(services.map((r) => r['value'])).toEqual(['98%', '12+', '85%', '250+']);
    for (const r of services) {
      expect(r['is_placeholder']).toBe(true);
      // value = number + suffix (the 0023 statistics_value_consistent CHECK)
      expect(r['value']).toBe(`${String(r['value_numeric'])}${String(r['value_suffix'])}`);
    }
  });

  it('no two live quotes share a project (testimonials_one_per_project)', () => {
    const live = rowsOf('testimonials').filter(
      (r) => rowForMode(r, 'published')['status'] === 'published' && r['portfolio_id'],
    );
    const projects = live.map((r) => refSlug(r['portfolio_id']));
    expect(new Set(projects).size).toBe(projects.length);
  });

  it('a delta seed of just this round’s files is available (runbook §6d)', async () => {
    const { onlyBlocks } = (await import('../../scripts/gen-seeds.mjs')) as unknown as {
      onlyBlocks: (files: string[]) => Block[];
    };
    const delta = onlyBlocks(['08-disciplines.json', '45-service-cases.json']);
    expect([...new Set(delta.map((b) => b.table))]).toEqual(['disciplines', 'service_cases']);
    expect(() => onlyBlocks(['99-nope.json'])).toThrow();
  });
});
