import { describe, expect, it, vi } from 'vitest';

// H15 code review (CR7): a section write walked its content's depth twice, once in the payload's
// own check (SectionPayloadSchema) and again in the write's refinement (checkSectionContent).
// The payload's depth refusal is now fatal, so the refinement never runs over content it
// refused, and the refinement no longer walks the depth itself: one walk a write.

const walks = vi.hoisted(() => ({ contents: [] as unknown[] }));
vi.mock('@schemas/jsonDepth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@schemas/jsonDepth')>();
  return {
    ...actual,
    jsonDepthWithin: (value: unknown, maxDepth: number) => {
      walks.contents.push(value);
      return actual.jsonDepthWithin(value, maxDepth);
    },
  };
});

const { SECTION_CONTENT_TOO_DEEP, SectionUpdateSchema, SectionWriteSchema } =
  await import('@schemas/admin');

const PAGE = '22222222-2222-4222-8222-222222222222';
const deepArray = (levels: number): unknown => {
  let value: unknown = 'x';
  for (let i = 0; i < levels; i += 1) value = [value];
  return value;
};
const para = (t: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
});

describe("a section write walks its content's depth once (CR7)", () => {
  it('valid content: one walk, and the write passes', () => {
    const content = {
      heading: { en: 'Words', ar: 'كلمات' },
      body: { en: para('Body'), ar: para('نص') },
    };
    walks.contents.length = 0;
    expect(SectionWriteSchema.safeParse({ pageId: PAGE, type: 'textBlock', content }).success).toBe(
      true,
    );
    expect(walks.contents).toHaveLength(1);
  });

  for (const [name, schema] of [
    ['a write', SectionWriteSchema],
    ['an update', SectionUpdateSchema],
  ] as const) {
    it(`${name} of content past the bound: one walk, one plain refusal, nothing else read`, () => {
      const payload = { pageId: PAGE, type: 'textBlock', content: { body: deepArray(5_000) } };
      walks.contents.length = 0;
      const parsed = schema.safeParse(name === 'an update' ? { ...payload, version: 1 } : payload);
      expect(walks.contents).toHaveLength(1);
      expect(parsed.error?.issues.map((i) => [i.path, i.message])).toEqual([
        [['content'], SECTION_CONTENT_TOO_DEEP],
      ]);
    });
  }

  it('other issues of the write are still reported beside the depth refusal', () => {
    walks.contents.length = 0;
    const parsed = SectionWriteSchema.safeParse({
      pageId: 'not a uuid',
      type: 'textBlock',
      content: { body: deepArray(5_000) },
    });
    expect(walks.contents).toHaveLength(1);
    expect(parsed.error?.issues.map((i) => i.path.join('.')).sort()).toEqual(['content', 'pageId']);
  });
});
