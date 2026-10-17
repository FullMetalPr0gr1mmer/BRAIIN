import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { SECTION_CONTENT_SCHEMAS, type SectionType } from '@schemas/sections';
import { SECTION_UI, SECTION_ADVANCED_ONLY, sectionFields } from '@/lib/admin/sectionUi';
import { objectToPayload } from '@/lib/admin/formPayload';
import type { FieldDef } from '@/lib/admin/uiSchema';

// The typed section editor (SECTION_UI) is zod-free for the admin bundle, so nothing but
// this file keeps it and the real content schemas agreeing. A field the schema does not
// know is an editor that saves a 422; a schema key with no field and no reason is copy an
// editor cannot reach without hand-writing JSON.

const shapeOf = (type: SectionType): Record<string, z.ZodTypeAny> =>
  (SECTION_CONTENT_SCHEMAS[type] as z.AnyZodObject).shape;

/** The content keys a field writes: its own name, or, for an accent stored as two
 *  numbers, those two keys (AccentDef mode 'from' — the hero's accentFromEn / Ar). */
function keysOf(field: FieldDef): string[] {
  return field.kind === 'accent' && field.accent?.mode === 'from'
    ? [field.accent.keys.en, field.accent.keys.ar]
    : [field.name];
}

/** A plausible filled-in form value for one field. */
function sample(field: FieldDef): unknown {
  switch (field.kind) {
    case 'bilingual':
    case 'prose':
      // The explorer's button label must name its discipline through the token (its help
      // says so; the schema refuses a label without it).
      return field.name === 'startLabel'
        ? { en: 'Start {discipline}', ar: 'ابدأ {discipline}' }
        : { en: 'Two words', ar: 'كلمتان هنا' };
    case 'number':
      return 1;
    case 'range':
      return field.range?.min ?? 1;
    // F5b: the form state of the three new kinds (src/lib/admin/formPayload.ts).
    case 'accent':
      return field.accent?.mode === 'from'
        ? { en: { from: 0, to: null }, ar: { from: 0, to: null } }
        : { en: { from: 0, to: 1 }, ar: { from: 0, to: 1 } };
    case 'link':
      return { label: { en: 'See all our work', ar: 'شاهد كل أعمالنا' }, href: '/portfolio' };
    case 'slugRelation':
      return ['hilton-rebrand', 'noon-campaign'].slice(0, field.maxItems ?? 2);
    case 'url':
      return 'https://instagram.com/braiinstatiion';
    case 'repeater':
      return [Object.fromEntries((field.itemFields ?? []).map((f) => [f.name, sample(f)]))];
    case 'object':
      return Object.fromEntries((field.itemFields ?? []).map((f) => [f.name, sample(f)]));
    case 'select':
      return field.options?.[0]?.value ?? 'value';
    case 'checkbox':
      return true;
    case 'media':
      return '5eed0a00-0000-4000-8000-000000000007';
    case 'clip':
      return {
        source: 'path',
        streamUid: '',
        path: '/media/showreel.mp4',
        startS: '14',
        endS: '15.4',
      };
    default:
      // text fields: a value every text key accepts (a slug, a site-relative href)
      return field.name.endsWith('Href') ? '/portfolio' : 'value';
  }
}

const TYPES = Object.keys(SECTION_UI) as SectionType[];

describe('SECTION_UI agrees with SECTION_CONTENT_SCHEMAS', () => {
  it('has an editor for exactly the types that take content', () => {
    expect(new Set(TYPES)).toEqual(new Set(Object.keys(SECTION_CONTENT_SCHEMAS)));
  });

  for (const type of TYPES) {
    it(`${type}: every field is a key of the schema`, () => {
      const keys = Object.keys(shapeOf(type));
      for (const field of SECTION_UI[type] ?? []) {
        for (const key of keysOf(field)) expect(keys, key).toContain(key);
      }
    });

    it(`${type}: every schema key has a field or is deliberately advanced-only`, () => {
      const covered = new Set([
        ...(SECTION_UI[type] ?? []).flatMap(keysOf),
        ...(SECTION_ADVANCED_ONLY[type] ?? []),
      ]);
      for (const key of Object.keys(shapeOf(type))) expect(covered, key).toContain(key);
    });

    it(`${type}: a fully filled editor saves content the schema accepts`, () => {
      const fields = SECTION_UI[type] ?? [];
      const values = Object.fromEntries(fields.map((f) => [f.name, sample(f)]));
      const payload = objectToPayload(values, fields);
      // Every filled field reaches the payload: every schema key is optional, so a shaper
      // that dropped (say) all number overrides would still "validate".
      expect(Object.keys(payload).sort()).toEqual(fields.flatMap(keysOf).sort());
      const parsed = SECTION_CONTENT_SCHEMAS[type]!.safeParse(payload);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      // ...and nothing was stripped by z.object, at the top level or inside repeater items.
      expect(parsed.data).toEqual(payload);
    });

    it(`${type}: an untouched editor saves {} (the built-in copy)`, () => {
      const fields = SECTION_UI[type] ?? [];
      const blankOf = (f: FieldDef): unknown =>
        f.kind === 'bilingual'
          ? { en: '', ar: '' }
          : f.kind === 'repeater'
            ? [{}]
            : f.kind === 'object'
              ? Object.fromEntries((f.itemFields ?? []).map((sub) => [sub.name, blankOf(sub)]))
              : f.kind === 'accent'
                ? { en: { from: null, to: null }, ar: { from: null, to: null } }
                : f.kind === 'link'
                  ? { label: { en: '', ar: '' }, href: '' }
                  : f.kind === 'slugRelation'
                    ? []
                    : null;
      const blank = Object.fromEntries(fields.map((f) => [f.name, blankOf(f)]));
      expect(objectToPayload(blank, fields)).toEqual({});
    });
  }

  it('statistics: the proof band’s rating line is a typed field, not JSON-only (Round 3)', () => {
    const rating = SECTION_UI.statistics!.find((f) => f.name === 'rating')!;
    expect(rating.kind).toBe('object');
    expect(rating.itemFields?.map((f) => [f.name, f.kind, f.required])).toEqual([
      ['value', 'text', true],
      ['label', 'bilingual', true],
    ]);
    expect(rating.help).toMatch(/cannot go live/);
    // Since F5b the two accents are typed word ranges, not JSON.
    expect(SECTION_ADVANCED_ONLY.statistics).toBeUndefined();
  });

  it('“Advanced (JSON)” is down to the one key that is a route decision (F5b)', () => {
    expect(SECTION_ADVANCED_ONLY).toEqual({ hero: ['intro'] });
  });

  it('every accent names a bilingual sibling of its own type, and nothing else does', () => {
    const accentKeys = new Set(['accent', 'lineAccent', 'quotesAccent']);
    for (const type of TYPES) {
      const fields = SECTION_UI[type] ?? [];
      const shape = shapeOf(type);
      for (const field of fields) {
        if (field.kind !== 'accent') continue;
        const sibling = fields.find((f) => f.name === field.accent?.of);
        expect(sibling?.kind, `${type}.${field.name}`).toBe('bilingual');
      }
      // Every schema key that IS an accent range has an accent field writing it. (The
      // contact section's `accent` is a bilingual TEXT, not a range: it is not one of
      // these keys by shape, so it is named out of the check by its type.)
      for (const key of Object.keys(shape)) {
        if (!accentKeys.has(key) || type === 'contact') continue;
        const field = fields.find((f) => keysOf(f).includes(key));
        expect(field?.kind, `${type}.${key}`).toBe('accent');
      }
      // The hero and the slogan band store theirs as two numbers.
      for (const key of ['accentFromEn', 'accentFromAr']) {
        if (!(key in shape)) continue;
        const field = fields.find((f) => keysOf(f).includes(key));
        expect(field?.accent?.mode, `${type}.${key}`).toBe('from');
      }
    }
  });

  it('the card picks are slugs of published featured projects, the button a link', () => {
    const fields = SECTION_UI.selectedWork!;
    const cards = fields.find((f) => f.name === 'cardSlugs')!;
    expect(cards.kind).toBe('slugRelation');
    expect(cards.relation?.valueKey).toBe('slug');
    expect(cards.relation?.resource).toBe('portfolio');
    expect(cards.relation?.filter).toEqual({ is_featured: 'true', status: 'published' });
    expect(cards.maxItems).toBe(2);
    expect(fields.find((f) => f.name === 'button')?.kind).toBe('link');
    // The carousel interval is a slider inside the schema's own bounds.
    const interval = SECTION_UI.testimonials!.find((f) => f.name === 'intervalMs')!;
    expect(interval.kind).toBe('range');
    expect(interval.range).toEqual({ min: 4000, max: 15000, step: 500, suffix: ' ms' });
  });

  it('table-backed and unknown types have no editor', () => {
    expect(sectionFields('team')).toBeNull();
    expect(sectionFields('not-a-type')).toBeNull();
    expect(sectionFields(undefined)).toBeNull();
    expect(sectionFields('hero')).not.toBeNull();
  });
});
