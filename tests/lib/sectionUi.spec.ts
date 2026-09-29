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
      for (const field of SECTION_UI[type] ?? []) expect(keys).toContain(field.name);
    });

    it(`${type}: every schema key has a field or is deliberately advanced-only`, () => {
      const covered = new Set([
        ...(SECTION_UI[type] ?? []).map((f) => f.name),
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
      expect(Object.keys(payload).sort()).toEqual(fields.map((f) => f.name).sort());
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
    // the accents stay JSON-only, recorded: there is no accent field kind
    expect(SECTION_ADVANCED_ONLY.statistics).toEqual(['accent', 'lineAccent']);
  });

  it('table-backed and unknown types have no editor', () => {
    expect(sectionFields('team')).toBeNull();
    expect(sectionFields('not-a-type')).toBeNull();
    expect(sectionFields(undefined)).toBeNull();
    expect(sectionFields('hero')).not.toBeNull();
  });
});
