import { describe, expect, it, vi } from 'vitest';
import type { APIRoute } from 'astro';
import {
  SECTION_CONTENT_MAX_DEPTH,
  SECTION_CONTENT_TOO_DEEP,
  SectionUpdateSchema,
  SectionWriteSchema,
} from '@schemas/admin';
import {
  SECTION_CONTENT_SCHEMAS,
  SECTION_TYPES,
  SECTION_UNKNOWN_SETTING,
  sectionContentIssues,
  type SectionType,
} from '@schemas/sections';
import { jsonDepthWithin } from '@schemas/jsonDepth';
import {
  DRAFT_PAYLOAD_MAX_BYTES,
  DraftPayloadSchema,
  JSON_MEASURE_MAX_DEPTH,
  WriteDraftsOpsSchema,
  jsonBytes,
} from '@schemas/release';
import { collectionRoutes } from '@/lib/admin/resource';
import { sectionResource } from '@/lib/admin/resources';
import { sectionStateFromObject, formToPayload, rowToForm } from '@/lib/admin/formPayload';
import { RESOURCE_UI } from '@/lib/admin/ui';
import { fullSectionContent, objectShapes, sectionShapes } from '../fixtures/sectionShapes';

vi.mock('@/lib/data/systemLog', () => ({ writeSystemLog: async () => true }));
vi.mock('@/lib/admin/audit', () => ({ writeAudit: async () => undefined }));

// H15: two holes in what a section save accepts, found by E10's independent checks.
//
//   * The 64 KB refine stringified the content first, and JSON.stringify overflows the stack past
//     about 4,782 levels: a 19 KB payload threw a RangeError, a 500 for every section type,
//     where a refusal was meant. The same in the release draft payload's byte check.
//   * Section content is stored as sent, and the older types nest objects their schemas read
//     tolerantly, so a key a schema drops on read was stored anyway: a `mediaId` hidden in a
//     heading made that asset anon-readable through 0024's and 0102's `$.**.mediaId`. A write
//     now refuses a key the type does not have, at any level; the read still drops one.

const PAGE = '22222222-2222-4222-8222-222222222222';
const deepArray = (levels: number): unknown => {
  let value: unknown = 'x';
  for (let i = 0; i < levels; i += 1) value = [value];
  return value;
};

describe('jsonDepthWithin', () => {
  it('counts an object or array one level, a scalar none, and never recurses', () => {
    expect(jsonDepthWithin('x', 0)).toBe(true);
    expect(jsonDepthWithin({}, 0)).toBe(false);
    expect(jsonDepthWithin({ a: [1] }, 2)).toBe(true);
    expect(jsonDepthWithin({ a: [1, { b: null }] }, 2)).toBe(false);
    expect(jsonDepthWithin(deepArray(64), 64)).toBe(true);
    expect(jsonDepthWithin(deepArray(65), 64)).toBe(false);
    expect(() => jsonDepthWithin(deepArray(200_000), 64)).not.toThrow();
  });
});

describe('the 64 KB refine on section content: a deep payload is an issue, never a throw', () => {
  // About 20 KB, inside the 64 KB cap: JSON.stringify threw at about 4,782 levels before H15.
  const deep = { stray: deepArray(10_000) };

  for (const type of SECTION_TYPES) {
    it(`${type}: refused on create and on update, with the words, before anything reads it`, () => {
      expect(JSON.stringify(deepArray(4_000)).length).toBeLessThan(65_536);
      for (const parse of [
        () => SectionWriteSchema.safeParse({ pageId: PAGE, type, content: deep }),
        () => SectionUpdateSchema.safeParse({ version: 1, type, content: deep }),
        () => SectionUpdateSchema.safeParse({ version: 1, content: deep }),
      ]) {
        expect(parse).not.toThrow();
        const result = parse();
        expect(result.success).toBe(false);
        expect(result.error?.issues.map((i) => [i.path, i.message])).toEqual([
          [['content'], SECTION_CONTENT_TOO_DEEP],
        ]);
      }
    });
  }

  it(`takes ${SECTION_CONTENT_MAX_DEPTH} levels and refuses one more (the content object is one)`, () => {
    const at = (levels: number) =>
      SectionUpdateSchema.safeParse({ version: 1, content: { a: deepArray(levels - 1) } });
    expect(at(SECTION_CONTENT_MAX_DEPTH).error?.issues ?? []).toEqual([]);
    expect(at(SECTION_CONTENT_MAX_DEPTH + 1).error?.issues[0]?.message).toBe(
      SECTION_CONTENT_TOO_DEEP,
    );
    // The deepest a section writes, a Text block's body at its 8 levels, is well inside.
    expect(jsonDepthWithin(fullSectionContent('textBlock'), 30)).toBe(true);
    // The words are plain (P-12).
    expect(SECTION_CONTENT_TOO_DEEP).not.toMatch(/[–—]|payload|JSON/);
  });

  it('through the API: a 422 with the words, nothing written (it was a 500)', async () => {
    const inserted: unknown[] = [];
    const builder: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'order', 'limit', 'in']) builder[m] = () => builder;
    builder['insert'] = (row: unknown) => {
      inserted.push(row);
      return builder;
    };
    builder['single'] = async () => ({ data: { id: PAGE, version: 1 }, error: null });
    builder['then'] = (resolve: (value: unknown) => unknown) =>
      Promise.resolve(resolve({ data: [], error: null }));
    const sb = { from: () => builder, rpc: async () => ({ data: false, error: null }) };
    const url = new URL('https://admin.example.test/api/admin/sections');
    const ctx = {
      request: new Request(url, {
        method: 'POST',
        // Spelled out: the test's own JSON.stringify would overflow on it, as the refine did.
        body: `{"pageId":"${PAGE}","type":"hero","content":{"stray":${'['.repeat(10_000)}"x"${']'.repeat(10_000)}}}`,
        headers: { 'content-type': 'application/json' },
      }),
      url,
      params: {},
      locals: {
        session: {
          userId: '33333333-3333-4333-8333-000000000999',
          tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          role: 'admin',
          isActive: true,
          email: 'x@example.test',
        },
        supabase: sb,
        cspNonce: 'n',
        csrfToken: 'c',
      },
    } as unknown as Parameters<APIRoute>[0];
    const res = (await collectionRoutes(sectionResource).POST(ctx)) as Response;
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain(SECTION_CONTENT_TOO_DEEP);
    expect(inserted).toEqual([]);
  });
});

describe("the release draft payload's byte check: a deep payload is too large, never a throw", () => {
  const deep = { content: deepArray(10_000) };

  it('jsonBytes measures a deep value as infinitely large, without stringifying it', () => {
    expect(() => jsonBytes(deep)).not.toThrow();
    expect(jsonBytes(deep)).toBe(Number.POSITIVE_INFINITY);
    expect(jsonBytes({ a: 'é' })).toBe(10);
  });

  it('DraftPayloadSchema and the draft writer’s arguments refuse it as too large', () => {
    expect(() => DraftPayloadSchema.safeParse(deep)).not.toThrow();
    expect(DraftPayloadSchema.safeParse(deep).error?.issues[0]?.message).toBe('too-large');
    const op = {
      action: 'put',
      entity_type: 'page_section',
      entity_id: PAGE,
      op: 'update',
      payload: deep,
      fields: ['content'],
      base: {},
      base_version: 1,
      label: null,
    };
    const ops = WriteDraftsOpsSchema.safeParse([op]);
    expect(ops.success).toBe(false);
    expect(ops.error?.issues.some((i) => i.message === 'too-large')).toBe(true);
  });

  it('an article and a section at their own bounds fit inside a draft', () => {
    let node: unknown = {
      type: 'text',
      text: 'x',
      marks: [{ type: 'link', attrs: { href: '/a' } }],
    };
    for (let i = 0; i < 31; i += 1) node = { type: 'blockquote', content: [node] };
    const article = { body: { en: { type: 'doc', content: [node] } } };
    expect(jsonDepthWithin(article, JSON_MEASURE_MAX_DEPTH)).toBe(true);
    expect(jsonBytes(article)).toBeLessThan(DRAFT_PAYLOAD_MAX_BYTES);
    const section = { content: { a: deepArray(SECTION_CONTENT_MAX_DEPTH - 1) } };
    expect(jsonDepthWithin(section, JSON_MEASURE_MAX_DEPTH)).toBe(true);
  });
});

// ── Strict on write, tolerant on read (every section type) ─────────────────────────────

type Path = (string | number)[];
type Bag = Record<string | number, unknown>;

/** The path of every plain object in `value` (arrays walked, not counted). */
function objectPaths(value: unknown, path: Path = []): Path[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => objectPaths(v, [...path, i]));
  if (typeof value !== 'object' || value === null) return [];
  return [path, ...Object.entries(value).flatMap(([k, v]) => objectPaths(v, [...path, k]))];
}
const at = (value: unknown, path: Path): Bag =>
  path.reduce<Bag>((node, step) => node[step] as Bag, value as Bag);
const withKey = (content: unknown, path: Path, key: string, v: unknown): Bag => {
  const copy = structuredClone(content) as Bag;
  at(copy, path)[key] = v;
  return copy;
};
/** `columns.0.title` → `columns[].title`, the shape's own spelling. */
const shapePath = (path: Path): string =>
  path.reduce<string>(
    (out, step) => (typeof step === 'number' ? `${out}[]` : out ? `${out}.${step}` : step),
    '',
  );
/** A Text block body's inside is the Tiptap walk's, not the section schema's (a leaf here). */
const inBody = (type: SectionType, path: Path) =>
  type === 'textBlock' && path[0] === 'body' && path.length > 1;

const TYPES_WITH_CONTENT = SECTION_TYPES.filter((t) => SECTION_CONTENT_SCHEMAS[t] !== undefined);
const HIDDEN = '5eed0a00-0000-4000-8000-0000000000ff';

describe('a write refuses a key the type does not have, at any level (H15)', () => {
  it('the samples are valid and reach every object every type’s schema names', () => {
    const shapes = sectionShapes();
    for (const type of TYPES_WITH_CONTENT) {
      const content = fullSectionContent(type);
      expect(sectionContentIssues(type, content), type).toEqual([]);
      const reached = new Set(
        objectPaths(content)
          .filter((p) => !inBody(type, p))
          .map(shapePath),
      );
      expect([...reached].sort(), type).toEqual([...shapes.get(type)!.keys()].sort());
    }
  });

  it('an extra key on any object of any type is refused on write; the read is unchanged', () => {
    const shapes = sectionShapes();
    let levels = 0;
    let tolerant = 0;
    for (const type of TYPES_WITH_CONTENT) {
      const content = fullSectionContent(type);
      for (const path of objectPaths(content).filter((p) => !inBody(type, p))) {
        levels += 1;
        const where = `${type} ${path.join('.') || '(top)'}`;
        const tampered = withKey(content, path, 'mediaId', HIDDEN);
        // A key the schema names there already is the editor's own, not hidden.
        if (
          objectShapes(SECTION_CONTENT_SCHEMAS[type]!)
            .get(shapePath(path))
            ?.keys.includes('mediaId')
        ) {
          continue;
        }
        const issues = sectionContentIssues(type, tampered);
        expect(issues.length, where).toBeGreaterThan(0);
        // The read is what it was: the loader parses with the same schemas, so where an
        // object's schema is tolerant it takes the row and drops the key (a row stored before
        // H15 renders as it did), and where it is strict (UI v2's) it refused it already.
        const strict = shapes.get(type)!.get(shapePath(path))!.strict;
        const read = SECTION_CONTENT_SCHEMAS[type]!.safeParse(tampered);
        expect(read.success, where).toBe(!strict);
        if (read.success) expect(JSON.stringify(read.data), where).not.toContain(HIDDEN);
        tolerant += strict ? 0 : 1;
      }
    }
    expect(levels).toBeGreaterThan(80);
    // The tolerant objects H15 closes on write: the older types' text, accents, clips, media.
    expect(tolerant).toBeGreaterThan(40);
  });

  it('the older types name the key and the place, in plain words', () => {
    const cases: [SectionType, Record<string, unknown>, Path][] = [
      [
        'aboutWho',
        { heading: { en: 'Who we are', ar: 'من نحن', mediaId: HIDDEN } },
        ['heading', 'mediaId'],
      ],
      ['hero', { sub: { en: 'a', ar: 'ب' }, poster: HIDDEN }, ['poster']],
      ['cta', { accent: { en: { from: 0, mediaId: HIDDEN } } }, ['accent', 'en', 'mediaId']],
      [
        'workIntro',
        { media: [{ mediaId: HIDDEN, clip: { path: '/media/showreel.mp4', mediaId: HIDDEN } }] },
        ['media', 0, 'clip', 'mediaId'],
      ],
      [
        'aboutIntro',
        { columns: [{ title: { en: 'a', ar: 'ب' }, body: { en: 'a', ar: 'ب' }, x: 1 }] },
        ['columns', 0, 'x'],
      ],
      [
        'social',
        { links: [{ label: 'IG', user: '@b', href: 'https://instagram.com/b', icon: 'x' }] },
        ['links', 0, 'icon'],
      ],
    ];
    for (const [type, content, path] of cases) {
      expect(sectionContentIssues(type, content), type).toEqual([
        { code: 'custom', path: ['content', ...path], message: SECTION_UNKNOWN_SETTING },
      ]);
    }
    expect(SECTION_UNKNOWN_SETTING).not.toMatch(/[–—]|schema|key|JSON/);
  });

  it('through SectionWriteSchema and the PATCH check, on the content field', () => {
    const content = { heading: { en: 'Who we are', ar: 'من نحن', mediaId: HIDDEN } };
    const write = SectionWriteSchema.safeParse({ pageId: PAGE, type: 'aboutWho', content });
    expect(write.error?.issues.map((i) => [i.path, i.message])).toEqual([
      [['content', 'heading', 'mediaId'], SECTION_UNKNOWN_SETTING],
    ]);
    const patch = sectionResource.assertWritable!(
      { page_id: PAGE, type: 'aboutWho', content },
      { auth: {} as never, sb: {} as never, changed: { content } },
    );
    return expect(patch).rejects.toMatchObject({
      field: 'content',
      detail: `heading.mediaId: ${SECTION_UNKNOWN_SETTING}`,
    });
  });
});

describe('the page editor never sends a key the type does not have', () => {
  const fields = RESOURCE_UI['sections']!.fields;

  it('a stored stray key is dropped by a typed save (the save succeeds); hero.intro still rides', () => {
    const stored = {
      type: 'hero',
      content: {
        headline: { en: 'Old words', ar: 'كلمات قديمة' },
        intro: true,
        poster: HIDDEN,
        legacy: { mediaId: HIDDEN },
      },
    };
    const state = sectionStateFromObject(stored.content, 'hero');
    expect(state.extra).toEqual({ intro: true });
    const payload = formToPayload(rowToForm(stored, fields), fields);
    expect(payload['content']).toEqual({ headline: stored.content.headline, intro: true });
    expect(sectionContentIssues('hero', payload['content'])).toEqual([]);
  });

  it('a stray key nested in any object of any type is dropped by an untouched typed save', () => {
    // H15 review (COR-1): the typed save rebuilt every nested value from its fields but a
    // bilingual, prose or rich-text pair, which it sent back whole, so a key hidden inside one
    // (`heading.mediaId`) made an untouched typed save of that row refused.
    let planted = 0;
    const refused: string[] = [];
    const carried: string[] = [];
    for (const type of TYPES_WITH_CONTENT) {
      const content = fullSectionContent(type);
      for (const path of objectPaths(content).filter((p) => !inBody(type, p))) {
        if (
          objectShapes(SECTION_CONTENT_SCHEMAS[type]!)
            .get(shapePath(path))
            ?.keys.includes('mediaId')
        ) {
          continue;
        }
        planted += 1;
        const row = { type, content: withKey(content, path, 'mediaId', HIDDEN) };
        const payload = formToPayload(rowToForm(row, fields), fields);
        const where = `${type} ${path.join('.') || '(top)'}`;
        if (sectionContentIssues(type, payload['content']).length > 0) refused.push(where);
        if (JSON.stringify(payload['content']).includes(HIDDEN)) carried.push(where);
      }
    }
    expect(refused).toEqual([]);
    expect(carried).toEqual([]);
    expect(planted).toBeGreaterThan(80);
  });

  /** Every leaf of a value, by path: what a round trip must give back. */
  const leaves = (value: unknown, path = ''): Map<string, unknown> => {
    const out = new Map<string, unknown>();
    const stack: [unknown, string][] = [[value, path]];
    while (stack.length > 0) {
      const [next, at] = stack.pop()!;
      if (typeof next === 'object' && next !== null) {
        for (const [k, v] of Object.entries(next)) stack.push([v, at ? `${at}.${k}` : k]);
      } else {
        out.set(at, next);
      }
    }
    return out;
  };

  /**
   * What an untouched typed save loses today, a known gap recorded in H15's as-built note as a
   * follow-up (COR-6, older than H15): the Our Work intro's media items have no field for their
   * alt override, so a typed save drops it. Remove the entry when that field exists.
   */
  const KNOWN_LOSSES: Readonly<Partial<Record<SectionType, readonly string[]>>> = {
    workIntro: ['media.0.altOverride.ar', 'media.0.altOverride.en'],
  };

  for (const type of TYPES_WITH_CONTENT) {
    it(`${type}: a full stored row, re-saved untouched, passes the strict write and keeps its values`, () => {
      const row = { type, content: fullSectionContent(type) };
      const payload = formToPayload(rowToForm(row, fields), fields);
      expect(sectionContentIssues(type, payload['content']), type).toEqual([]);
      const before = leaves(row.content);
      const after = leaves(payload['content']);
      const lost = [...before.keys()].filter((k) => !after.has(k)).sort();
      expect(lost, type).toEqual(KNOWN_LOSSES[type] ?? []);
      for (const [k, v] of after) {
        if (before.has(k)) expect(v, `${type} ${k}`).toEqual(before.get(k));
      }
    });
  }
});
