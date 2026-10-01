import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_JOIN_SECTIONS,
  HERO_PRESETS,
  ensureJoinApply,
  withHeroPreset,
  type SectionData,
} from '@/lib/sections/types';
import {
  JOIN_APPLY_COPY,
  JOIN_CACHE_ENTITIES,
  JOIN_STEPS_COPY,
  JOIN_WHY_COPY,
  composeJoinPage,
  firstVisibleType,
  joinAnswer,
  shown,
  withBrand,
  withJoinData,
} from '@/lib/sections/join';
import { tierATags } from '@/lib/http/cacheTags';
import { PAGE_META } from '@/lib/seo/pageMeta';
import { splitAccent } from '@/lib/text/accent';
import type { Accent } from '@schemas/media';
import {
  HeroSectionContentSchema,
  JOIN_ITEMS_MAX,
  JoinApplySectionContentSchema,
  JoinStepsSectionContentSchema,
  JoinWhySectionContentSchema,
  SECTION_CONTENT_SCHEMAS,
  type SectionType,
} from '@schemas/sections';
import { loadBlocks } from '../../scripts/gen-seeds.mjs';

// The Join page (/join, /ar/join): the hero preset, the composition and its route
// guarantees, the no-JS answer (?status=), the three bands' content schemas, and the
// built-in copy (the mockup's, verbatim, but for the "Fourteen crafts" rewrite — J-6).

const preset = HERO_PRESETS.join;
const ORDER = ['hero', 'joinWhy', 'joinSteps', 'joinApply'];

describe("HERO_PRESETS.join — 'Join the station'", () => {
  it('gives an empty hero the design’s join copy and the banner layout', () => {
    const [hero] = withHeroPreset([{ type: 'hero' }], 'join');
    expect(hero!.props).toEqual(preset.content);
    expect(hero!.data).toEqual({
      banner: true,
      ctaHref: '#apply',
      clip: { start: 17.4, end: 18.3 },
    });
    expect(hero!.props!['headline']).toEqual({ en: 'Join the station', ar: 'انضم إلى المحطة' });
    expect(hero!.props!['ctaLabel']).toEqual({ en: 'Apply now', ar: 'قدّم الآن' });
  });

  it('the accent is the third word in both languages (the design’s <em>)', () => {
    expect(preset.content.headline.en.split(' ')[preset.content.accentFromEn]).toBe('station');
    expect(preset.content.headline.ar.split(' ')[preset.content.accentFromAr]).toBe('المحطة');
  });

  it('is valid hero content (headline bounds, accent indices)', () => {
    const parsed = HeroSectionContentSchema.safeParse(preset.content);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('plays its own window of the loop, inside the clip limit', () => {
    expect(preset.data.clip.end - preset.data.clip.start).toBeGreaterThan(0);
    expect(preset.data.clip.end - preset.data.clip.start).toBeLessThanOrEqual(30);
  });
});

describe('the Join composition', () => {
  it('is the design order: banner hero, why, how it works, the application', () => {
    expect(DEFAULT_JOIN_SECTIONS.map((s) => s.type)).toEqual(ORDER);
  });

  it('the seeded composition is the default one (dev/CI/staging render what code would)', () => {
    type Row = { type: string; content: Record<string, unknown>; sort_order: number };
    const blocks = (
      loadBlocks() as unknown as {
        table: string;
        source: string;
        unlessAuthored?: string[];
        rows: Row[];
      }[]
    ).filter((b) => b.table === 'page_sections' && b.source === '55-join-page.json');
    expect(blocks).toHaveLength(1);
    // Seeded only while the page has no sections — never into an edited one.
    expect(blocks[0]!.unlessAuthored).toEqual(['page_id']);
    const rows = [...blocks[0]!.rows].sort((a, b) => a.sort_order - b.sort_order);
    expect(rows.map((r) => r.type)).toEqual(ORDER);
    for (const row of rows) {
      expect(JSON.stringify(row)).toContain('"slug":"join"');
      expect(row.content, row.type).toEqual({});
      const schema = SECTION_CONTENT_SCHEMAS[row.type as SectionType];
      expect(schema?.safeParse(row.content).success, row.type).toBe(true);
    }
  });

  it('an empty composition renders the default, with the preset and the answer applied', () => {
    const out = composeJoinPage([], 'ok');
    expect(out.map((s) => s.type)).toEqual(ORDER);
    expect(out[0]!.data).toMatchObject({ banner: true, ctaHref: '#apply' });
    expect(out[3]!.data).toEqual({ answer: 'ok' });
    expect(composeJoinPage([], null)[3]!.data).toEqual({ answer: null });
  });

  it('an authored composition keeps its order, with the form guaranteed', () => {
    const authored: SectionData[] = [
      { type: 'joinSteps' },
      { type: 'hero', props: { sub: { en: 'Authored', ar: 'مكتوب' } } },
      { type: 'joinApply', visible: false },
    ];
    const out = composeJoinPage(authored, null);
    expect(out.map((s) => s.type)).toEqual(['joinSteps', 'hero', 'joinApply']);
    expect(out[1]!.props!['sub']).toEqual({ en: 'Authored', ar: 'مكتوب' });
    expect(out[1]!.props!['headline']).toEqual(preset.content.headline);
    expect(out[2]!.visible).toBe(true);
  });

  it('does not mutate the shared defaults', () => {
    const before = JSON.stringify(DEFAULT_JOIN_SECTIONS);
    composeJoinPage(DEFAULT_JOIN_SECTIONS, 'closed');
    expect(JSON.stringify(DEFAULT_JOIN_SECTIONS)).toBe(before);
  });
});

describe('ensureJoinApply: the form cannot leave the page', () => {
  it('shows a hidden application band', () => {
    const out = ensureJoinApply([{ type: 'hero' }, { type: 'joinApply', visible: false }]);
    expect(out[1]).toEqual({ type: 'joinApply', visible: true });
  });

  it('puts a removed one back at the end, where the design has it', () => {
    expect(ensureJoinApply([{ type: 'hero' }, { type: 'joinWhy' }]).map((s) => s.type)).toEqual([
      'hero',
      'joinWhy',
      'joinApply',
    ]);
    expect(ensureJoinApply([])).toEqual([{ type: 'joinApply' }]);
  });

  it('keeps one copy only (the form’s ids are fixed)', () => {
    const out = ensureJoinApply([
      { type: 'joinApply', props: { note: { en: 'first', ar: 'أول' } } },
      { type: 'joinWhy' },
      { type: 'joinApply', props: { note: { en: 'second', ar: 'ثاني' } } },
    ]);
    expect(out.filter((s) => s.type === 'joinApply')).toHaveLength(1);
    expect(out[0]!.props!['note']).toEqual({ en: 'first', ar: 'أول' });
  });
});

describe('withJoinData: route data, never CMS content', () => {
  it('hands the answer to the application band only, after the content', () => {
    const out = withJoinData(
      [{ type: 'hero' }, { type: 'joinApply', props: { answer: 'ok' } as Record<string, unknown> }],
      { answer: 'closed' },
    );
    expect(out[0]).toEqual({ type: 'hero' });
    expect(out[1]!.data).toEqual({ answer: 'closed' });
    // An authored key of the same name stays in props (and the strict schema refuses it).
    expect(out[1]!.props).toEqual({ answer: 'ok' });
    expect(JoinApplySectionContentSchema.safeParse({ answer: 'ok' }).success).toBe(false);
  });
});

describe('joinAnswer: the no-JS answer page', () => {
  const answer = (query: string) => joinAnswer(new URLSearchParams(query));

  it('the bare URL is not an answer (Tier A)', () => {
    expect(answer('')).toEqual({ present: false, status: null });
    expect(answer('utm_source=x')).toEqual({ present: false, status: null });
  });

  it('a known status is rendered', () => {
    expect(answer('status=ok')).toEqual({ present: true, status: 'ok' });
    expect(answer('status=bad_type')).toEqual({ present: true, status: 'bad_type' });
    expect(answer('x=1&status=closed')).toEqual({ present: true, status: 'closed' });
  });

  it('any other value is still an answer request (never cached), rendering nothing', () => {
    expect(answer('status=')).toEqual({ present: true, status: null });
    expect(answer('status=%3Cscript%3E')).toEqual({ present: true, status: null });
    expect(answer('status=OK')).toEqual({ present: true, status: null });
  });
});

describe('the Join page’s cache tags and head', () => {
  it('cover the composition and the identity, within the purge limit', () => {
    const tags = tierATags({ route: 'join', locale: 'ar', entities: JOIN_CACHE_ENTITIES });
    expect(tags).toEqual(
      expect.arrayContaining(['route:join', 'page:join', 'site:identity', 'nav:all', 'locale:ar']),
    );
    expect(tags.length).toBeLessThanOrEqual(30);
  });

  it('PAGE_META.join names the page and promises no roles list', () => {
    expect(PAGE_META.join.en.title).toBe('Join us');
    expect(PAGE_META.join.ar.title).toBe('انضم إلينا');
    for (const locale of ['en', 'ar'] as const) {
      expect(PAGE_META.join[locale].description).toContain('%brand%');
      expect(PAGE_META.join[locale].description.length).toBeGreaterThan(60);
    }
    expect(PAGE_META.join.en.description).not.toMatch(/open roles/i);
  });

  it('opens under the overlay header only on its hero', () => {
    expect(firstVisibleType(composeJoinPage([], null))).toBe('hero');
    const noHero = composeJoinPage([{ type: 'hero', visible: false }, { type: 'joinWhy' }], null);
    expect(firstVisibleType(noHero)).toBe('joinWhy');
    expect(shown(noHero, 'hero')).toBe(false);
  });
});

describe('Join section content (CMS overrides)', () => {
  const pair = { en: 'Two words', ar: 'كلمتان هنا' };

  it('accepts every copy override', () => {
    expect(
      JoinWhySectionContentSchema.safeParse({
        tag: pair,
        heading: pair,
        accent: { en: { from: 1 }, ar: { from: 1 } },
        lead: pair,
        items: [{ heading: pair, text: pair }],
      }).success,
    ).toBe(true);
    expect(
      JoinStepsSectionContentSchema.safeParse({
        tag: pair,
        heading: pair,
        lead: pair,
        items: [{ heading: pair, text: pair, time: pair }],
      }).success,
    ).toBe(true);
    expect(
      JoinApplySectionContentSchema.safeParse({
        tag: pair,
        heading: pair,
        lead: pair,
        groupAbout: pair,
        groupRole: pair,
        groupWork: pair,
        note: pair,
        successMessage: pair,
      }).success,
    ).toBe(true);
  });

  it('bounds the items: one to four', () => {
    const items = (n: number) => Array.from({ length: n }, () => ({ heading: pair, text: pair }));
    expect(JoinWhySectionContentSchema.safeParse({ items: items(JOIN_ITEMS_MAX) }).success).toBe(
      true,
    );
    expect(JoinWhySectionContentSchema.safeParse({ items: items(5) }).success).toBe(false);
    expect(JoinWhySectionContentSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it('a step needs its time label', () => {
    expect(
      JoinStepsSectionContentSchema.safeParse({ items: [{ heading: pair, text: pair }] }).success,
    ).toBe(false);
  });

  it('refuses keys that belong to code (strict): the form, its fields, its options', () => {
    expect(JoinApplySectionContentSchema.safeParse({ fields: [] }).success).toBe(false);
    expect(JoinApplySectionContentSchema.safeParse({ consent: pair }).success).toBe(false);
    expect(JoinApplySectionContentSchema.safeParse({ submitLabel: pair }).success).toBe(false);
    expect(JoinWhySectionContentSchema.safeParse({ reasons: [] }).success).toBe(false);
    expect(
      JoinStepsSectionContentSchema.safeParse({
        items: [{ heading: pair, text: pair, time: pair, icon: 'x' }],
      }).success,
    ).toBe(false);
  });

  it('requires both languages (indexable copy)', () => {
    expect(JoinWhySectionContentSchema.safeParse({ heading: { en: 'Only English' } }).success).toBe(
      false,
    );
  });
});

describe('the built-in copy', () => {
  const COPIES = { why: JOIN_WHY_COPY, steps: JOIN_STEPS_COPY, apply: JOIN_APPLY_COPY };

  it('each accent lands on the design’s <em> words', () => {
    const accented = (text: string, copy: { accent: Accent }, locale: 'en' | 'ar') =>
      splitAccent(text, copy.accent[locale])
        .filter((r) => r.accent)
        .map((r) => r.text)
        .join('');
    expect(accented(JOIN_WHY_COPY.en.heading, JOIN_WHY_COPY, 'en')).toBe('leaves the building');
    expect(accented(JOIN_WHY_COPY.ar.heading, JOIN_WHY_COPY, 'ar')).toBe('يطلع للعالم');
    expect(accented(JOIN_STEPS_COPY.en.heading, JOIN_STEPS_COPY, 'en')).toBe('first brief');
    expect(accented(JOIN_STEPS_COPY.ar.heading, JOIN_STEPS_COPY, 'ar')).toBe('أول بريف');
    expect(accented(JOIN_APPLY_COPY.en.heading, JOIN_APPLY_COPY, 'en')).toBe('make');
    expect(accented(JOIN_APPLY_COPY.ar.heading, JOIN_APPLY_COPY, 'ar')).toBe('تصنع');
  });

  it('has the design’s four reasons and four steps in both languages', () => {
    for (const locale of ['en', 'ar'] as const) {
      expect(JOIN_WHY_COPY[locale].items).toHaveLength(4);
      expect(JOIN_STEPS_COPY[locale].items).toHaveLength(4);
      for (const step of JOIN_STEPS_COPY[locale].items) expect(step.time.trim()).not.toBe('');
    }
    expect(JOIN_STEPS_COPY.ar.items[2]!.time).toBe('حوالي ٤٥ دقيقة');
    expect(JOIN_WHY_COPY.ar.items[1]!.text).toBe(
      'بدون شهور من المراقبة. تشتغل على مشاريع تطلع فعلاً، مع ناس طلّعوا كثير.',
    );
  });

  it('says five disciplines, never the stale "fourteen crafts" (J-6)', () => {
    const all = JSON.stringify(COPIES);
    expect(all).not.toMatch(/fourteen|أربع عشرة/i);
    expect(JOIN_WHY_COPY.en.items[0]!.heading).toBe('Five disciplines, one room');
    expect(JOIN_WHY_COPY.ar.items[0]!.heading).toBe('خمسة تخصصات، غرفة واحدة');
    expect(JOIN_WHY_COPY.en.lead).toMatch(/^Five disciplines and 28 services sit in the same room/);
  });

  it('names the studio only through %brand% (the brand is data)', () => {
    expect(JSON.stringify(COPIES)).not.toMatch(/Braiin|بريّن/);
    expect(JOIN_WHY_COPY.en.tag).toBe('Why %brand%');
    expect(withBrand(JOIN_WHY_COPY.ar.tag, 'بريّن ستيشن')).toBe('ليش بريّن ستيشن');
    expect(withBrand('%brand% and %brand%', 'X')).toBe('X and X');
  });
});

describe('join.css: what keeps the page still', () => {
  const css = readFileSync(join(process.cwd(), 'public/styles/join.css'), 'utf8');

  it('the lead line and the closed notice share one grid cell, swapped by visibility', () => {
    expect(css).toMatch(/\.join-apply__lead > p \{\s*grid-area: 1 \/ 1;/);
    expect(css).toMatch(/\.join-apply__lead\[data-closed='true'\] > \.join-apply__p,/);
    expect(css).not.toMatch(/join-apply__closed[^{]*\{[^}]*display:\s*none/);
  });

  it('the CV zone’s texts are stacks, and Remove keeps its space while hidden', () => {
    expect(css).toMatch(/\.af-drop__t > \*,\s*\.af-drop__s > \* \{\s*grid-area: 1 \/ 1;/);
    expect(css).toMatch(/\.af-drop\[data-state='empty'\] \.af-drop__x \{\s*visibility: hidden;/);
  });

  it('the band under the banner caps its head in em, never ch (CLAUDE.md §6, R3-0)', () => {
    // .sec-head's 16ch / 46ch would re-wrap when the web font replaces its fallback — in
    // the first screen. Both caps are overridden in em, in both scripts.
    expect(css).toMatch(/\n\.join-why \.sec-head h2 \{\s*max-width: [\d.]+em;/);
    expect(css).toMatch(/html\[dir='rtl'\] \.join-why \.sec-head h2 \{\s*max-width: [\d.]+em;/);
    expect(css).toMatch(/\n\.join-why \.sec-head p \{\s*max-width: [\d.]+em;/);
    expect(css).toMatch(/html\[dir='rtl'\] \.join-why \.sec-head p \{\s*max-width: [\d.]+em;/);
    expect(css).not.toMatch(/\.join-why[^{]*\{[^}]*max-width:\s*[\d.]+ch/);
  });
});
