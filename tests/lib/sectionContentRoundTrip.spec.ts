import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  formToPayload,
  rowToForm,
  shownSectionValues,
  type SectionContentState,
} from '@/lib/admin/formPayload';
import { accentGroups, sectionFields } from '@/lib/admin/sectionUi';
import { RESOURCE_UI } from '@/lib/admin/uiSchema';
import { sectionContentIssues, type SectionType } from '@schemas/sections';

// Section content through the REAL form path (Admin v2 F5b review): a stored row is loaded
// by rowToForm and saved by formToPayload untouched, as a save that only flips `visible`
// does. Whatever the editor did not change must come back byte for byte; a save is never
// allowed to drop, move or rewrite stored copy on its own.

const fields = RESOURCE_UI['sections']!.fields;
const trip = (type: string, content: unknown): unknown =>
  formToPayload(rowToForm({ type, content, page_id: 'p', visible: true }, fields), fields)[
    'content'
  ];

describe('every seeded page section saves back unchanged', () => {
  const dir = join(process.cwd(), 'supabase/seed-data');
  const rows: { id: string; type: string; content: unknown }[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
    const doc = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
      blocks?: { table: string; rows: { id: string; type: string; content: unknown }[] }[];
    };
    for (const block of doc.blocks ?? []) {
      if (block.table === 'page_sections') rows.push(...block.rows);
    }
  }

  it('finds the seeded sections', () => {
    expect(rows.length).toBeGreaterThanOrEqual(36);
  });

  for (const row of rows) {
    it(`${row.type} ${row.id}`, () => {
      expect(trip(row.type, row.content)).toEqual(row.content);
    });
  }
});

describe('a save keeps values the editor did not change (review L5)', () => {
  it('a hero accent past the end of its headline is not moved onto the last word', () => {
    // From word 6 of two: the page colours nothing, and an unrelated save must not
    // start colouring the last word.
    const content = {
      headline: { en: 'One two', ar: 'واحد اثنان' },
      accentFromEn: 5,
      accentFromAr: 1,
    };
    expect(trip('hero', content)).toEqual(content);
  });

  it('a range accent running past its heading is not shortened', () => {
    const content = {
      heading: { en: 'One two three', ar: 'واحد اثنان' },
      accent: { en: { from: 1, to: 9 } },
    };
    expect(trip('cta', content)).toEqual(content);
  });

  it('a testimonials interval off the slider step is not snapped', () => {
    expect(trip('testimonials', { intervalMs: 7250 })).toEqual({ intervalMs: 7250 });
  });
});

describe('an accent stored without its heading is kept (review H1)', () => {
  // Each colours words the form does not show: the built-in heading, or a page preset's
  // (withHeroPreset puts the preset headline under an authored accent).
  const cases: [string, Record<string, unknown>][] = [
    ['hero', { accentFromEn: 1, accentFromAr: 0 }],
    ['slogan', { accentFromEn: 2 }],
    ['cta', { accent: { en: { from: 1 } } }],
    ['cta', { accent: { en: { from: 1, to: 3 }, ar: { from: 0 } } }],
  ];
  for (const [type, content] of cases) {
    it(`${type} ${JSON.stringify(content)}`, () => {
      expect(sectionContentIssues(type as SectionType, content)).toEqual([]);
      expect(trip(type, content)).toEqual(content);
    });
  }

  it('beside a heading in the other language only, each half keeps its own rule', () => {
    const content = { heading: { en: 'One two', ar: '' }, accent: { ar: { from: 2 } } };
    expect(trip('cta', content)).toEqual(content);
  });
});

describe('built-in copy through the real form path (review M4)', () => {
  // A cta section with nothing stored, its built-in copy known (what E1 will pass): the
  // state is built the way SectionContentField's `set` leaves it after an edit.
  const ctaFields = sectionFields('cta')!;
  const builtIn = {
    tag: { en: 'Get in touch', ar: 'تواصل معنا' },
    heading: { en: 'Say hello there', ar: 'قل مرحبا هنا' },
    accent: { en: { from: 1 }, ar: { from: 1 } },
  };
  const edited = (patch: Record<string, unknown>) => {
    const loaded = rowToForm({ type: 'cta', content: {}, page_id: 'p' }, fields);
    const content = loaded['content'] as SectionContentState;
    const state: SectionContentState = {
      ...content,
      builtIn,
      together: accentGroups(ctaFields),
      values: { ...content.values, ...patch },
    };
    return formToPayload({ ...loaded, content: state }, fields)['content'];
  };
  /** The accent as the field shows it before the editor touches it. */
  const shownAccent = () =>
    shownSectionValues({}, ctaFields, builtIn).values['accent'] as Record<string, unknown>;

  it('a form nobody changed stores nothing', () => {
    expect(edited({})).toEqual({});
  });

  it('a heading edited keeps the highlight the form shows, held to the new words', () => {
    expect(edited({ heading: { en: 'Say hi there', ar: 'قل مرحبا هنا' } })).toEqual({
      heading: { en: 'Say hi there', ar: 'قل مرحبا هنا' },
      accent: { en: { from: 1 }, ar: { from: 1 } },
    });
    // One word left in English: the highlight moves onto it rather than vanishing.
    expect(edited({ heading: { en: 'Hello', ar: 'قل مرحبا هنا' } })).toEqual({
      heading: { en: 'Hello', ar: 'قل مرحبا هنا' },
      accent: { en: { from: 0 }, ar: { from: 1 } },
    });
  });

  it('the accent alone moved stores the heading it counts with it', () => {
    expect(edited({ accent: { ...shownAccent(), en: { from: 2, to: null } } })).toEqual({
      heading: builtIn.heading,
      accent: { en: { from: 2 }, ar: { from: 1 } },
    });
  });

  it('beside a prefilled heading, the accent counts the words on screen', () => {
    const { values, own } = shownSectionValues({}, ctaFields, builtIn);
    expect(values['heading']).toEqual(builtIn.heading);
    expect(values['accent']).toMatchObject({
      en: { from: 1, to: null },
      ar: { from: 1, to: null },
    });
    expect(own.size).toBe(0);
  });
});
