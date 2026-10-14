import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { LocalizedTextSchema } from '@schemas/content';
import {
  SECTION_CONTENT_SCHEMAS,
  STAT_BAND_VARIANTS,
  sectionContentIssues,
  type SectionType,
} from '@schemas/sections';
import { RENDERED_SECTION_TYPES, type RenderedSectionType } from '@/lib/sections/registry';
import { SECTION_COPY, builtInContent, builtInLook } from '@/lib/sections/copy';
import { HERO_PRESETS } from '@/lib/sections/types';

// The built-in section copy as data (Admin v2 F6, ui.md AV-23): one module per type in
// src/lib/sections/copy/, which the components render and the page editor will prefill its
// fields with. These are the data's own guarantees; that the components render exactly
// this data is tests/render/sectionCopy.spec.ts, and that the move changed no byte is
// tests/render/sections.spec.ts.

const sorted = (xs: Iterable<string>) => [...xs].sort();

type Zod = z.ZodTypeAny;
const unwrap = (s: Zod): Zod => {
  if (s instanceof z.ZodOptional || s instanceof z.ZodNullable) return unwrap(s.unwrap() as Zod);
  if (s instanceof z.ZodEffects) return unwrap(s.innerType() as Zod);
  if (s instanceof z.ZodDefault) return unwrap(s._def.innerType as Zod);
  return s;
};
const TEXT = unwrap(LocalizedTextSchema);

/** Does a field hold words a visitor reads: text, or a list or object of them? */
function bearsText(s: Zod): boolean {
  const u = unwrap(s);
  if (u === TEXT) return true;
  if (u instanceof z.ZodArray) return bearsText(u.element as Zod);
  if (u instanceof z.ZodObject)
    return Object.values(u.shape as Record<string, Zod>).some(bearsText);
  return false;
}

const shapeOf = (type: SectionType): Record<string, Zod> | null => {
  const schema = SECTION_CONTENT_SCHEMAS[type];
  if (!schema) return null;
  const u = unwrap(schema);
  return u instanceof z.ZodObject ? (u.shape as Record<string, Zod>) : null;
};

/**
 * Text fields with no built-in value, each with its reason. Anything else a type's content
 * schema holds as text must have a built-in in some look, or the page editor would show an
 * empty field over words the visitor reads.
 */
const NO_BUILT_IN: Partial<Record<RenderedSectionType, Record<string, string>>> = {
  // A claim: it exists only where authored (the seeded row is flagged is_placeholder).
  statistics: { rating: 'the services proof band shows a rating only where one is authored' },
  // Data, not words: "Since {year}" around the public identity's founding year (labels.since).
  clientsMarquee: { note: 'the founding year from the public identity, or nothing' },
  // An image reference: its only text is `altOverride`, over the media library row's alt.
  workIntro: { media: 'frames are media library images, their alt text the library’s' },
};

/** Every `{ en, ar }` pair of strings in a value, with where it is. */
function pairs(value: unknown, at: string, out: [string, { en: string; ar: string }][] = []) {
  if (Array.isArray(value)) value.forEach((v, i) => pairs(v, `${at}[${i}]`, out));
  else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.en === 'string' && typeof o.ar === 'string') {
      out.push([at, { en: o.en, ar: o.ar }]);
    } else for (const [k, v] of Object.entries(o)) pairs(v, `${at}.${k}`, out);
  }
  return out;
}

const looks = (type: RenderedSectionType) => Object.entries(SECTION_COPY[type].content);

describe('the copy registry', () => {
  it('has one entry per rendered section type, and nothing else', () => {
    expect(sorted(Object.keys(SECTION_COPY))).toEqual(sorted(RENDERED_SECTION_TYPES));
  });

  it('every look is valid content for its type, as a write would check it', () => {
    for (const type of RENDERED_SECTION_TYPES) {
      for (const [look, content] of looks(type)) {
        expect(sectionContentIssues(type, content), `${type}.${look}`).toEqual([]);
      }
    }
  });

  it('every look names only fields its type has (the lenient schemas would let a typo through)', () => {
    for (const type of RENDERED_SECTION_TYPES) {
      const shape = shapeOf(type);
      for (const [look, content] of looks(type)) {
        const keys = Object.keys(content);
        if (!shape) expect(keys, `${type}.${look}`).toEqual([]);
        else for (const k of keys) expect(Object.keys(shape), `${type}.${look}.${k}`).toContain(k);
      }
    }
  });

  it('every text field of every type has a built-in value, or a stated reason not to', () => {
    const missing: string[] = [];
    const stale: string[] = [];
    for (const type of RENDERED_SECTION_TYPES) {
      const shape = shapeOf(type);
      if (!shape) continue;
      const covered = new Set(looks(type).flatMap(([, c]) => Object.keys(c)));
      const exempt = NO_BUILT_IN[type] ?? {};
      for (const [field, schema] of Object.entries(shape)) {
        if (!bearsText(schema)) continue;
        if (!covered.has(field) && !(field in exempt)) missing.push(`${type}.${field}`);
        if (covered.has(field) && field in exempt) stale.push(`${type}.${field}`);
      }
      for (const field of Object.keys(exempt)) {
        if (!(field in shape)) stale.push(`${type}.${field}`);
      }
    }
    expect(missing, 'text fields with no built-in value').toEqual([]);
    expect(stale, 'NO_BUILT_IN entries that have one, or name no field').toEqual([]);
  });

  it('notVerbatim names fields of the type that do have a built-in', () => {
    for (const type of RENDERED_SECTION_TYPES) {
      const covered = new Set(looks(type).flatMap(([, c]) => Object.keys(c)));
      for (const f of SECTION_COPY[type].notVerbatim) {
        expect(covered.has(f), `${type}.${f}`).toBe(true);
      }
    }
  });

  it('each `together` group is two or more fields with a built-in, in no other group', () => {
    // That the groups are the right ones (each needed, none missing) is the render spec's.
    for (const type of RENDERED_SECTION_TYPES) {
      const { together, notVerbatim } = SECTION_COPY[type];
      const covered = new Set(looks(type).flatMap(([, c]) => Object.keys(c)));
      const seen = new Set<string>();
      for (const group of together) {
        expect(group.length, `${type}: ${group.join(' + ')}`).toBeGreaterThan(1);
        for (const f of group) {
          expect(covered.has(f), `${type}.${f} has no built-in`).toBe(true);
          expect(notVerbatim, `${type}.${f} is never stored as written`).not.toContain(f);
          expect(seen.has(f), `${type}.${f} is in two groups`).toBe(false);
          seen.add(f);
        }
      }
    }
  });
});

describe('the words', () => {
  const all = RENDERED_SECTION_TYPES.flatMap((type) => [
    ...pairs(SECTION_COPY[type].content, type),
    ...pairs(SECTION_COPY[type].labels, `${type}.labels`),
  ]);

  it('reach every pair of text in the registry', () => {
    // A guard on the walker itself: the registry holds a few hundred pairs.
    expect(all.length).toBeGreaterThan(150);
  });

  it('are written in both languages, and the Arabic is Arabic', () => {
    for (const [at, { en, ar }] of all) {
      expect(en.trim(), at).not.toBe('');
      expect(ar.trim(), at).not.toBe('');
      expect(ar, `${at} has no Arabic letter`).toMatch(/[؀-ۿ]/);
    }
  });

  it('never spell the studio: the brand is the public identity, %brand% in copy', () => {
    for (const [at, { en, ar }] of all) {
      // The seeded brand is "Braiin Statiion" / "بريّن ستيشن" (with or without the shadda).
      expect(`${en} ${ar}`, at).not.toMatch(/braiin|بريّ?ن/i);
    }
  });

  it('keep the design’s Arabic-Indic digits where it wrote them (never transformed)', () => {
    const ar = (type: RenderedSectionType) =>
      pairs(SECTION_COPY[type].content, type).map(([, p]) => p.ar);
    expect(ar('joinSteps')).toContain('حوالي ٤٥ دقيقة');
    expect(ar('joinWhy').some((s) => s.startsWith('خمسة تخصصات و٢٨ خدمة'))).toBe(true);
  });
});

describe('builtInLook / builtInContent', () => {
  it('the hero takes its page’s preset on contact, services and join, the home copy elsewhere', () => {
    for (const page of ['contact', 'services', 'join'] as const) {
      expect(builtInLook('hero', { page })).toBe(page);
      // The preset's copy IS the registry's (withHeroPreset applies HERO_PRESETS).
      expect(builtInContent('hero', { page })).toBe(HERO_PRESETS[page].content);
    }
    expect(builtInLook('hero', { page: 'home' })).toBe('default');
    expect(builtInLook('hero', { page: 'about' })).toBe('default');
    expect(builtInLook('hero')).toBe('default');
  });

  it('the discipline cards take the page layout only on /services', () => {
    expect(builtInLook('servicesOverview', { page: 'services' })).toBe('page');
    expect(builtInLook('servicesOverview', { page: 'home' })).toBe('home');
    expect(builtInLook('servicesOverview')).toBe('home');
  });

  it('social and statistics follow the section’s variant, with their defaults', () => {
    expect(builtInLook('social', { variant: 'klein' })).toBe('klein');
    expect(builtInLook('social', { variant: 'paper' })).toBe('paper');
    expect(builtInLook('social', { variant: 'nonsense' })).toBe('paper');
    expect(builtInLook('social')).toBe('paper');
    for (const v of STAT_BAND_VARIANTS) expect(builtInLook('statistics', { variant: v })).toBe(v);
    expect(builtInLook('statistics', { variant: 'nonsense' })).toBe('cards');
    expect(builtInLook('statistics')).toBe('cards');
  });

  it('every look a place can pick exists, and a one-look type is always `default`', () => {
    for (const type of RENDERED_SECTION_TYPES) {
      const content = SECTION_COPY[type].content;
      const places = [
        {},
        { page: 'contact' },
        { page: 'services' },
        { page: 'join' },
        ...STAT_BAND_VARIANTS.map((variant) => ({ variant })),
        { variant: 'klein' },
      ];
      for (const place of places) {
        const look = builtInLook(type, place);
        expect(content, `${type} in ${JSON.stringify(place)}`).toHaveProperty(look);
        expect(builtInContent(type, place)).toBe(content[look]);
      }
      if (Object.keys(content).length === 1) expect(Object.keys(content)).toEqual(['default']);
    }
  });
});

describe('the standard says what is built (CLAUDE.md §8, Section engine)', () => {
  // The registry's readers outside src/lib/sections/copy/: the page editor's door
  // (builtInContent, SECTION_COPY). Until one exists, the binding standard must not state
  // the editor's prefill as fact; once one does, it must stop calling the editor unbuilt.
  const src = join(process.cwd(), 'src');
  const readers = readdirSync(src, { recursive: true, encoding: 'utf8' })
    .map((f) => f.split(sep).join('/'))
    .filter((f) => /\.(ts|tsx|astro)$/.test(f) && !f.startsWith('lib/sections/copy/'))
    .filter((f) =>
      /\b(builtInContent|builtInLook|SECTION_COPY)\b/.test(readFileSync(join(src, f), 'utf8')),
    );
  const md = readFileSync(join(process.cwd(), 'CLAUDE.md'), 'utf8');
  const at = md.indexOf('- **Section engine:**');
  const passage = md.slice(at, md.indexOf('\n', at));

  it('names the storage rule the render spec holds: whole looks and `together` groups', () => {
    expect(at).toBeGreaterThan(-1);
    expect(passage).toContain('`together`');
    expect(passage).toContain('`notVerbatim`');
    expect(passage).toContain('tests/render/sectionCopy.spec.ts');
  });

  it('describes the page editor as built only once something reads the registry for it', () => {
    if (readers.length > 0) {
      expect(passage, `read by ${readers.join(', ')}`).not.toMatch(/not built yet/);
    } else {
      expect(passage).toMatch(/page editor \(E1, AV-25, not built yet\) is to prefill/);
      expect(passage).not.toMatch(/page editor prefills/);
    }
  });
});
