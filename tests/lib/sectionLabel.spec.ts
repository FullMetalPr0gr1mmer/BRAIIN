import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SECTION_LABEL_REFUSED, SectionLabelSchema, SectionWriteSchema } from '@schemas/admin';
import { SECTION_LABEL_MAX } from '@schemas/sectionTypes';

// A section's name in the admin (Admin v2 E1, `page_sections.label`): the schema the routes
// parse it with, and the page editor migration's CHECK, held to the same rule. The name reaches
// other staff (the sections column, and with releases on the publish dialog and the site
// versions: "Section: <name>"), so like a display name (0044) it refuses every Unicode control
// and format character: a bidi override (U+202E) or an isolate (U+2066) would reorder the words
// around it, a zero-width mark (U+200B) hide them.

const cp = (...points: number[]) => String.fromCodePoint(...points);

describe('SectionLabelSchema', () => {
  const parse = (value: unknown) => SectionLabelSchema.safeParse(value);

  it('takes a plain name, English or Arabic, trimmed, up to SECTION_LABEL_MAX characters', () => {
    expect(parse('Closing band')).toMatchObject({ success: true, data: 'Closing band' });
    expect(parse('  Closing band  ')).toMatchObject({ success: true, data: 'Closing band' });
    expect(parse('شريط الشعار')).toMatchObject({ success: true, data: 'شريط الشعار' });
    expect(parse('Hero ١٢٣')).toMatchObject({ success: true, data: 'Hero ١٢٣' });
    expect(parse('a'.repeat(SECTION_LABEL_MAX)).success).toBe(true);
    expect(parse('a'.repeat(SECTION_LABEL_MAX + 1)).success).toBe(false);
  });

  it('reads blank as no name (null: the kind’s own name shows)', () => {
    expect(parse('')).toMatchObject({ success: true, data: null });
    expect(parse('   ')).toMatchObject({ success: true, data: null });
    expect(parse(null)).toMatchObject({ success: true, data: null });
  });

  it('refuses a control or format character: a line break, U+202E, U+200B, an isolate', () => {
    for (const bad of [
      `Two${cp(10)}lines`,
      `Hero${cp(0x202e)} band`,
      `${cp(0x202e)}dnab oreH`,
      `He${cp(0x200b)}ro`,
      `${cp(0x2066)}Hero${cp(0x2069)}`,
      `He${cp(0xfeff)}ro`,
      `Hero${cp(0xad)}band`,
      `Tag${cp(0xe0041)}`,
    ]) {
      const result = parse(bad);
      expect(result.success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('is the write’s label: a refused one refuses the save', () => {
    const base = {
      pageId: '0f0f0f0f-0000-4000-8000-00000000000a',
      type: 'cta',
      content: {},
      visible: false,
      sortOrder: 10,
    };
    expect(SectionWriteSchema.safeParse({ ...base, label: 'Closing band' }).success).toBe(true);
    expect(SectionWriteSchema.safeParse({ ...base, label: `Hero${cp(0x202e)}` }).success).toBe(
      false,
    );
  });
});

describe('the CHECK on page_sections.label is the schema’s rule (0113)', () => {
  const dir = join(process.cwd(), 'supabase/migrations');
  const file = readdirSync(dir).find((name) => /^\d{4}_page_editor\.sql$/.test(name));
  const sql = readFileSync(join(dir, file!), 'utf8');
  const check = sql.slice(
    sql.indexOf('add constraint page_sections_label_shape'),
    sql.indexOf('comment on column public.page_sections.label'),
  );
  const BS = String.fromCharCode(92);
  const hex = (point: number) => point.toString(16).toUpperCase().padStart(4, '0');

  /** `\uXXXX` / `\UXXXXXXXX` escapes and ranges between them, every character accounted for. */
  function codePointRanges(source: string): [number, number][] {
    const escape = `${BS}${BS}u([0-9A-F]{4})|${BS}${BS}U([0-9A-F]{8})`;
    const item = new RegExp(`(?:${escape})(?:-(?:${escape}))?`, 'gy');
    const ranges: [number, number][] = [];
    let consumed = 0;
    for (const m of source.matchAll(item)) {
      const from = parseInt(m[1] ?? m[2] ?? '', 16);
      const end = m[3] ?? m[4];
      ranges.push([from, end ? parseInt(end, 16) : from]);
      consumed += m[0].length;
    }
    expect(consumed, 'every character of the SQL set is an escape or a range').toBe(source.length);
    return ranges;
  }

  it('refuses exactly the characters the schema refuses, code point by code point', () => {
    const source = /label !~ '\[([^'\]]*)\]'/.exec(check)?.[1];
    expect(source, 'the refused class in page_sections_label_shape').toBeTruthy();
    const refused = codePointRanges(source!);
    const within = (point: number) => refused.some(([from, to]) => point >= from && point <= to);
    const mismatches: string[] = [];
    // From 1: NUL cannot reach a text value (Postgres refuses it), so the class omits it.
    for (let point = 1; point <= 0x10ffff; point += 1) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      if (SECTION_LABEL_REFUSED.test(String.fromCodePoint(point)) !== within(point)) {
        mismatches.push(hex(point));
      }
    }
    // A new Unicode version that adds a format character fails here: add it to the class.
    expect(mismatches).toEqual([]);
  });

  it('holds the same length and trim: 1 to SECTION_LABEL_MAX characters, trimmed', () => {
    expect(check).toMatch(new RegExp(`char_length\\(label\\) between 1 and ${SECTION_LABEL_MAX}`));
    expect(check).toContain('label = pg_catalog.btrim(label)');
    expect(check).toMatch(/check \(label is null\s+or \(/);
  });
});
