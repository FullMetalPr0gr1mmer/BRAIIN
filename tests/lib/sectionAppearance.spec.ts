import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  ANCHOR_CODE_OWNED,
  ANCHOR_DISCIPLINE,
  ANCHOR_MAX,
  ANCHOR_TAKEN,
  BACKGROUND_TYPES,
  CODE_ANCHORED_TYPES,
  NO_REVEAL_TYPES,
  RESERVED_ANCHORS,
  RESERVED_ANCHOR_PREFIXES,
  RESERVED_ANCHOR_SUFFIXES,
  SECTION_BACKGROUNDS,
  SECTION_REVEALS,
  SECTION_SPACINGS,
  SPACING_TYPES,
  anchorProblem,
  anchorReserved,
  appearanceProblem,
  takesAnchor,
} from '@schemas/sectionAppearance';
import { SECTION_TYPES } from '@schemas/sectionTypes';
import { SectionUpdateSchema, SectionWriteSchema } from '@schemas/admin';
import { PageSectionRowSchema } from '@schemas/sections';
import { sectionResource } from '@/lib/admin/resources';
import { ValidationError } from '@/lib/admin/errors';
import type { OverlayDb, TableQuery } from '@/lib/release/overlayDb';
import type { AuthContext } from '@/lib/auth/types';
import { appearanceAttrs, applySectionAttrs } from '@/lib/sections/appearance';
import type { SectionData } from '@/lib/sections/types';

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));

// Section appearance (Admin v2 E9): the code map (packages/schemas/sectionAppearance.ts), the
// write schema, the Worker's rules (sectionResource.assertWritable), the render rules
// (src/lib/sections/appearance.ts), the reserved ids against every id the site renders, and the
// E9 migration's CHECKs held equal to the code map.

const PAGE = '22222222-2222-4222-8222-222222222222';
const OTHER_PAGE = '22222222-2222-4222-8222-222222222223';
const ROW = '33333333-3333-4333-8333-000000000001';
const OTHER_ROW = '33333333-3333-4333-8333-000000000002';
const auth = {
  tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  userId: ROW,
  role: 'admin',
} as unknown as AuthContext;

describe('the code map', () => {
  it('names only real section types', () => {
    const known = new Set<string>(SECTION_TYPES);
    for (const list of [BACKGROUND_TYPES, SPACING_TYPES, NO_REVEAL_TYPES, CODE_ANCHORED_TYPES]) {
      for (const type of list) expect(known.has(type), type).toBe(true);
    }
  });

  it('never offers a reveal on a kind that opens a page (§6)', () => {
    for (const type of ['hero', 'aboutWho', 'pageHead', 'workHero', 'aboutStory']) {
      expect(appearanceProblem(type, { reveal: 'fade' })?.field).toBe('reveal');
    }
    expect(appearanceProblem('cta', { reveal: 'rise' })).toBeNull();
  });

  it('offers a background and a spacing to the blocks only', () => {
    expect(appearanceProblem('textBlock', { background: 'ink', spacing: 'roomy' })).toBeNull();
    expect(appearanceProblem('gallery', { background: 'klein' })).toBeNull();
    expect(appearanceProblem('video', { spacing: 'compact' })).toBeNull();
    expect(appearanceProblem('video', { background: 'mist' })?.field).toBe('background');
    expect(appearanceProblem('joinWhy', { spacing: 'compact' })?.field).toBe('spacing');
    expect(appearanceProblem('cta', { background: null, spacing: null, reveal: null })).toBeNull();
  });

  it('offers an anchor where the component names none, never on the hero', () => {
    expect(takesAnchor('textBlock', undefined)).toBe(true);
    expect(takesAnchor('statistics', 'cards')).toBe(true);
    expect(takesAnchor('statistics', 'band')).toBe(false);
    expect(takesAnchor('contactInquiry', undefined)).toBe(false);
    expect(takesAnchor('leadership', undefined)).toBe(false);
    expect(takesAnchor('hero', undefined)).toBe(false);
  });
});

describe('the anchor’s rules', () => {
  it('takes lower-case words joined by single hyphens, up to the cap', () => {
    for (const ok of ['a', 'our-story', 'step-2', 'x1-y2-z3', 'a'.repeat(ANCHOR_MAX)]) {
      expect(anchorProblem(ok), ok).toBeNull();
    }
  });

  it('refuses every other shape', () => {
    for (const bad of [
      '',
      'a'.repeat(ANCHOR_MAX + 1),
      'Our-Story',
      'our--story',
      '-story',
      'story-',
      '2-story',
      'our_story',
      'our story',
      'قصتنا',
      'our.story',
    ]) {
      expect(anchorProblem(bad), bad).not.toBeNull();
    }
  });

  it('refuses the ids the site renders, by name, prefix and ending', () => {
    for (const id of ['main', 'content', 'top', 'inquiry', 'apply', 'projects', 'team']) {
      expect(anchorReserved(id), id).toBe(true);
      expect(anchorProblem(id), id).toMatch(/used by the site itself/);
    }
    for (const id of ['cf-name', 'af-email', 'svc-tab-events', 'site-footer-col-1', 'tm-x']) {
      expect(anchorReserved(id), id).toBe(true);
    }
    for (const id of ['story-heading', 'name-error', 'svc-panel-x-h']) {
      expect(anchorReserved(id), id).toBe(true);
    }
    expect(anchorReserved('our-story')).toBe(false);
    expect(anchorReserved('heading')).toBe(false);
  });
});

describe('the write schema', () => {
  const base = { pageId: PAGE, type: 'textBlock' as const, content: {} };

  it('takes each bucket, and a blank or null as the section’s own', () => {
    for (const background of SECTION_BACKGROUNDS) {
      expect(SectionWriteSchema.parse({ ...base, background }).background).toBe(background);
    }
    for (const spacing of SECTION_SPACINGS) {
      expect(SectionWriteSchema.parse({ ...base, spacing }).spacing).toBe(spacing);
    }
    for (const reveal of SECTION_REVEALS) {
      expect(SectionWriteSchema.parse({ ...base, reveal }).reveal).toBe(reveal);
    }
    const blank = SectionUpdateSchema.parse({
      version: 1,
      background: '',
      spacing: null,
      reveal: '  ',
      anchor: '',
    });
    expect(blank).toMatchObject({ background: null, spacing: null, reveal: null, anchor: null });
  });

  it('writes nothing it was not sent', () => {
    const parsed = SectionUpdateSchema.parse({ version: 1, visible: true });
    for (const key of ['background', 'spacing', 'reveal', 'anchor']) {
      expect(key in parsed, key).toBe(false);
    }
  });

  it('refuses a value outside the bucket, and an anchor the rules refuse', () => {
    for (const bad of [
      { background: 'paper' },
      { background: 'INK' },
      { spacing: 'huge' },
      { reveal: 'slide' },
      { reveal: 1 },
      { anchor: 'Our Story' },
      { anchor: 'main' },
      { anchor: 'x-heading' },
      { anchor: 'a'.repeat(ANCHOR_MAX + 1) },
      { anchor: 7 },
    ]) {
      expect(
        SectionUpdateSchema.safeParse({ version: 1, ...bad }).success,
        JSON.stringify(bad),
      ).toBe(false);
    }
  });

  it('trims an anchor', () => {
    expect(SectionUpdateSchema.parse({ version: 1, anchor: ' our-story ' }).anchor).toBe(
      'our-story',
    );
  });

  it('maps each key to its own column, and nothing else', () => {
    expect(
      sectionResource.toRow({ background: 'ink', spacing: 'roomy', reveal: 'fade', anchor: 'x' }),
    ).toEqual({ background: 'ink', spacing: 'roomy', reveal: 'fade', anchor: 'x' });
    for (const column of ['background', 'spacing', 'reveal', 'anchor']) {
      expect(sectionResource.columns.split(','), column).toContain(column);
    }
  });
});

/** An overlay database answering the anchor's two reads; `asked` records them. */
function dbWith(sections: readonly string[], disciplines: number) {
  const asked: TableQuery[][] = [];
  const db = {
    listMany: async (queries: readonly TableQuery[]) => {
      asked.push([...queries]);
      return queries.map(({ table }) =>
        table === 'page_sections'
          ? sections.map((id) => ({ id }))
          : Array.from({ length: disciplines }, (_, i) => ({ id: String(i) })),
      );
    },
    list: async () => [],
    first: async () => null,
  } as unknown as OverlayDb;
  return { db, asked };
}

type R = Record<string, unknown>;
const check = (merged: R, changed: R, db: OverlayDb, before: R | null = null) =>
  sectionResource.assertWritable!(merged, { auth, sb: {} as never, changed, db, before });

describe('the Worker’s rules (assertWritable)', () => {
  const block = { id: ROW, page_id: PAGE, type: 'textBlock', content: {} };

  it('refuses a choice the kind does not take, on its field', async () => {
    const { db } = dbWith([], 0);
    const cta = { id: ROW, page_id: PAGE, type: 'cta', content: {} };
    for (const [key, value] of [
      ['background', 'ink'],
      ['spacing', 'roomy'],
    ] as const) {
      const out = check({ ...cta, [key]: value }, { [key]: value }, db);
      await expect(out).rejects.toBeInstanceOf(ValidationError);
      await expect(out).rejects.toMatchObject({ field: key });
    }
    const hero = { id: ROW, page_id: PAGE, type: 'hero', content: {}, reveal: 'fade' };
    await expect(check(hero, { reveal: 'fade' }, db)).rejects.toMatchObject({ field: 'reveal' });
    await expect(
      check({ ...block, background: 'ink', spacing: 'roomy', reveal: 'rise' }, block, db),
    ).resolves.toBeUndefined();
  });

  it('refuses a kind change that leaves a choice the new kind does not take', async () => {
    const { db } = dbWith([], 0);
    const merged = { ...block, type: 'cta', background: 'mist' };
    await expect(check(merged, { type: 'cta' }, db)).rejects.toMatchObject({
      field: 'background',
    });
  });

  it('refuses an anchor on a section that names its own', async () => {
    const { db, asked } = dbWith([], 0);
    const form = { id: ROW, page_id: PAGE, type: 'contactInquiry', content: {}, anchor: 'ask' };
    await expect(check(form, { anchor: 'ask' }, db)).rejects.toMatchObject({
      field: 'anchor',
      detail: ANCHOR_CODE_OWNED,
    });
    const band = {
      id: ROW,
      page_id: PAGE,
      type: 'statistics',
      content: { variant: 'band' },
      anchor: 'figures',
    };
    await expect(check(band, { content: band.content }, db)).rejects.toMatchObject({
      detail: ANCHOR_CODE_OWNED,
    });
    expect(asked).toEqual([]);
  });

  it('refuses an anchor another section of the page holds, and a discipline’s slug', async () => {
    const taken = dbWith([OTHER_ROW], 0);
    const row = { ...block, anchor: 'our-story' };
    await expect(check(row, { anchor: 'our-story' }, taken.db)).rejects.toMatchObject({
      field: 'anchor',
      detail: ANCHOR_TAKEN,
    });
    const discipline = dbWith([], 1);
    await expect(check(row, { anchor: 'our-story' }, discipline.db)).rejects.toMatchObject({
      detail: ANCHOR_DISCIPLINE,
    });
  });

  it('asks for the page’s anchor and the disciplines in one bounded go, not counting itself', async () => {
    const { db, asked } = dbWith([ROW], 0);
    const row = { ...block, anchor: 'our-story' };
    await expect(check(row, { anchor: 'our-story' }, db)).resolves.toBeUndefined();
    expect(asked).toEqual([
      [
        {
          table: 'page_sections',
          query: { columns: 'id', eq: { page_id: PAGE, anchor: 'our-story' }, limit: 2 },
        },
        { table: 'disciplines', query: { columns: 'id', eq: { slug: 'our-story' }, limit: 1 } },
      ],
    ]);
  });

  it('reads nothing for a save that restates the anchor, and reads again when the page moves', async () => {
    const stored = { ...block, anchor: 'our-story' };
    const same = dbWith([OTHER_ROW], 1);
    await expect(
      check(stored, { type: 'textBlock', content: {}, anchor: 'our-story' }, same.db, stored),
    ).resolves.toBeUndefined();
    expect(same.asked).toEqual([]);
    const moved = dbWith([OTHER_ROW], 0);
    await expect(
      check({ ...stored, page_id: OTHER_PAGE }, { page_id: OTHER_PAGE }, moved.db, stored),
    ).rejects.toMatchObject({ detail: ANCHOR_TAKEN });
  });

  it('reads nothing for a section with no anchor', async () => {
    const { db, asked } = dbWith([OTHER_ROW], 1);
    await expect(check({ ...block, anchor: null }, { anchor: null }, db)).resolves.toBeUndefined();
    expect(asked).toEqual([]);
  });
});

describe('the public row', () => {
  it('reads the four columns, and a value no CHECK allows as none (the row is kept)', () => {
    const row = PageSectionRowSchema.parse({
      type: 'textBlock',
      content: {},
      visible: true,
      sort_order: 1,
      background: 'purple',
      spacing: 'roomy',
      reveal: 'fade',
      anchor: 'our-story',
    });
    expect(row).toMatchObject({ background: null, spacing: 'roomy', reveal: 'fade' });
    const older = PageSectionRowSchema.parse({
      type: 'slogan',
      content: {},
      visible: true,
      sort_order: 1,
    });
    expect('background' in older).toBe(false);
  });
});

const sec = (
  type: string,
  appearance?: SectionData['appearance'],
  extra: Partial<SectionData> = {},
) => ({ type, ...(appearance ? { appearance } : {}), ...extra }) as SectionData;

describe('the render rules (appearanceAttrs)', () => {
  it('gives a section with nothing chosen nothing', () => {
    expect(appearanceAttrs([sec('hero'), sec('textBlock'), sec('cta', {})])).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('writes each choice the kind takes, the id first', () => {
    const out = appearanceAttrs([
      sec('hero'),
      sec('cta'),
      sec('textBlock', {
        anchor: 'our-story',
        background: 'ink',
        spacing: 'roomy',
        reveal: 'rise',
      }),
    ]);
    expect(out[2]).toEqual({
      id: 'our-story',
      'data-bg': 'ink',
      'data-space': 'roomy',
      'data-reveal': 'rise',
    });
    expect(Object.keys(out[2]!)[0]).toBe('id');
  });

  it('never reveals the first two sections a page shows (§6)', () => {
    const out = appearanceAttrs([
      sec('textBlock', { reveal: 'fade' }),
      sec('cta', { reveal: 'fade' }),
      sec('cta', { reveal: 'fade' }),
    ]);
    expect(out).toEqual([undefined, undefined, { 'data-reveal': 'fade' }]);
  });

  it('drops what the kind does not take, whatever the row says', () => {
    const out = appearanceAttrs([
      sec('slogan'),
      sec('slogan'),
      sec('cta', { background: 'ink', spacing: 'roomy' }),
      sec('hero', { reveal: 'fade', anchor: 'top-band' }),
      sec('contactInquiry', { anchor: 'ask' }),
      sec('statistics', { anchor: 'figures' }, { props: { variant: 'band' } }),
      sec('statistics', { anchor: 'figures' }, { props: { variant: 'cards' } }),
    ]);
    expect(out).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { id: 'figures' },
    ]);
  });

  it('gives an anchor to one element only: reserved, repeated and route ids are dropped', () => {
    const out = appearanceAttrs([
      sec('serviceExplorer', undefined, { data: { disciplines: [{ slug: 'events' }] } }),
      sec('textBlock', { anchor: 'events' }),
      sec('textBlock', { anchor: 'story' }),
      sec('textBlock', { anchor: 'story' }),
      sec('textBlock', { anchor: 'main' }),
      sec('textBlock', { anchor: 'Bad Shape' }),
    ]);
    expect(out.map((a) => a?.['id'])).toEqual([
      undefined,
      undefined,
      'story',
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe('the attributes on the first element (applySectionAttrs)', () => {
  it('writes them right after the tag name, before the component’s own', () => {
    expect(
      applySectionAttrs('<section class="blk-text"><h2>x</h2></section>', {
        id: 'our-story',
        'data-bg': 'ink',
      }),
    ).toBe('<section id="our-story" data-bg="ink" class="blk-text"><h2>x</h2></section>');
  });

  it('skips a leading script or style, and leaves markup with no element alone', () => {
    expect(applySectionAttrs('<style>a{}</style><div class="x">', { 'data-reveal': 'fade' })).toBe(
      '<style>a{}</style><div data-reveal="fade" class="x">',
    );
    expect(applySectionAttrs('', { id: 'a' })).toBe('');
    expect(applySectionAttrs('just text', { id: 'a' })).toBe('just text');
  });

  it('never writes an attribute the element already has (its own id wins)', () => {
    const html = '<section class="x" id="inquiry" aria-label="a > b">';
    expect(applySectionAttrs(html, { id: 'ask', 'data-space': 'roomy' })).toBe(
      '<section data-space="roomy" class="x" id="inquiry" aria-label="a > b">',
    );
    // An attribute named in a quoted value is not the attribute.
    expect(applySectionAttrs('<div title="id=x">', { id: 'ok' })).toBe(
      '<div id="ok" title="id=x">',
    );
  });

  it('writes no value that is not a plain token, and no other attribute name', () => {
    expect(
      applySectionAttrs('<div>', {
        id: 'a" onload="x',
        'data-bg': 'ink',
        onclick: 'x',
        'data-x': '<b>',
      }),
    ).toBe('<div data-bg="ink">');
  });
});

describe('the reserved ids hold every id the site renders', () => {
  // Every id in the render snapshots (every section of every page, every look, the layout and
  // its chrome): each is one the anchor rule refuses, or a discipline's slug (the explorer's
  // panels; refused by the Worker against the tenant's disciplines, dropped at render).
  const DISCIPLINE_SLUGS = ['branding', 'events', 'marketing', 'production', 'web'];

  it('every rendered id is reserved, so no anchor can take one', () => {
    const dir = join(process.cwd(), 'tests/render/__snapshots__');
    const ids = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.snap'))) {
      const text = readFileSync(join(dir, file), 'utf8');
      for (const m of text.matchAll(/ id=\\?"([^"\\]+)/g)) ids.add(m[1]!);
    }
    expect(ids.size).toBeGreaterThan(40);
    const loose = [...ids].filter((id) => !anchorReserved(id) && !DISCIPLINE_SLUGS.includes(id));
    expect(loose).toEqual([]);
  });
});

describe('the E9 migration holds the code map', () => {
  const dir = join(process.cwd(), 'supabase/migrations');
  const file = readdirSync(dir).find((f) => /_section_appearance\.sql$/.test(f));
  const sql = file ? readFileSync(join(dir, file), 'utf8') : '';
  const listIn = (constraint: string, column: string, op: 'in' | 'not in'): string[] => {
    const at = sql.indexOf(`add constraint ${constraint}`);
    expect(at, constraint).toBeGreaterThan(-1);
    const body = sql.slice(at, sql.indexOf(';', at));
    const re = new RegExp(`${column} ${op} \\(([^)]*)\\)`);
    const m = re.exec(body);
    expect(m, `${constraint} ${column} ${op}`).not.toBeNull();
    return [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!).sort();
  };
  const sorted = (list: readonly string[]) => [...list].sort();

  it('exists', () => {
    expect(file).toBeDefined();
  });

  it('the buckets and the kinds that take each', () => {
    expect(listIn('page_sections_background_bucket', 'background', 'in')).toEqual(
      sorted(SECTION_BACKGROUNDS),
    );
    expect(listIn('page_sections_background_bucket', 'type', 'in')).toEqual(
      sorted(BACKGROUND_TYPES),
    );
    expect(listIn('page_sections_spacing_bucket', 'spacing', 'in')).toEqual(
      sorted(SECTION_SPACINGS),
    );
    expect(listIn('page_sections_spacing_bucket', 'type', 'in')).toEqual(sorted(SPACING_TYPES));
    expect(listIn('page_sections_reveal_bucket', 'reveal', 'in')).toEqual(sorted(SECTION_REVEALS));
    expect(listIn('page_sections_reveal_bucket', 'type', 'not in')).toEqual(
      sorted(NO_REVEAL_TYPES),
    );
  });

  it('the anchor’s length, shape and reserved names, prefixes and endings', () => {
    const at = sql.indexOf('add constraint page_sections_anchor_shape');
    const body = sql.slice(at, sql.indexOf(';', at));
    expect(body).toContain(`char_length(anchor) between 1 and ${ANCHOR_MAX}`);
    expect(body).toContain("anchor ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'");
    const names = /array\[([\s\S]*?)\]::text\[\]/.exec(body)![1]!;
    expect([...names.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort()).toEqual(
      sorted(RESERVED_ANCHORS),
    );
    const prefixes = /anchor !~ '\^\(([^)]*)\)-'/.exec(body)![1]!.split('|');
    expect(prefixes.map((p) => `${p}-`).sort()).toEqual(sorted(RESERVED_ANCHOR_PREFIXES));
    const endings = /anchor !~ '-\(([^)]*)\)\$'/.exec(body)![1]!.split('|');
    expect(endings.map((e) => `-${e}`).sort()).toEqual(sorted(RESERVED_ANCHOR_SUFFIXES));
  });

  it('the anchor is unique on its page, checked at commit', () => {
    expect(sql).toMatch(
      /add constraint page_sections_anchor_unique unique \(tenant_id, page_id, anchor\)\s+deferrable initially deferred/,
    );
  });
});
