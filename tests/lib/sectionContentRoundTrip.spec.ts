import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { formToPayload, rowToForm } from '@/lib/admin/formPayload';
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
