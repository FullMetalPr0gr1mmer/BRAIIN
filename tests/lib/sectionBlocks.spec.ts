import { describe, expect, it } from 'vitest';
import {
  SECTION_DOC_MAX_DEPTH,
  SECTION_DOC_MAX_NODES,
  SectionBodySchema,
  SectionDocSchema,
  sectionHrefKept,
} from '@schemas/tiptap';
import {
  GALLERY_MAX_ITEMS,
  GallerySectionContentSchema,
  TextBlockSectionContentSchema,
  VideoSectionContentSchema,
  sectionContentIssues,
} from '@schemas/sections';
import { SectionWriteSchema } from '@schemas/admin';
import { renderTiptapToHtml, sanitizeHref } from '@/lib/content/tiptap';
import { galleryColumns } from '@/lib/sections/blocks';
import { docHasWords } from '@/lib/admin/docWords';

// Admin v2 E10's three blocks, at the write boundary. The Text block's body is "sanitised on
// write" by refusal: SectionDocSchema takes exactly what the admin's editor makes and the
// allowlist renderer emits unchanged, so nothing is stored that the renderer would drop or
// rewrite. The render half (src/lib/content/tiptap.ts) runs on every render regardless; the
// markup is tests/render/sectionBlocks.spec.ts's.

type Node = { type: string; text?: string; attrs?: object; marks?: object[]; content?: Node[] };
const doc = (...content: Node[]) => ({ type: 'doc', content });
const p = (...content: Node[]): Node => ({ type: 'paragraph', content });
const t = (text: string, marks?: object[]): Node =>
  marks ? { type: 'text', text, marks } : { type: 'text', text };
const link = (href: string) => [
  { type: 'link', attrs: { href, target: '_blank', rel: 'noopener' } },
];
const ok = (d: unknown) => SectionDocSchema.safeParse(d).success;

/** What the admin's Tiptap (StarterKit, headings 2 to 4, the toolbar and its shortcuts) makes. */
const EDITOR_OUTPUT = doc(
  { type: 'heading', attrs: { level: 2 }, content: [t('Two')] },
  { type: 'heading', attrs: { level: 3 }, content: [t('Three')] },
  { type: 'heading', attrs: { level: 4 }, content: [t('Four')] },
  p(
    t('bold', [{ type: 'bold' }]),
    t('italic', [{ type: 'italic' }]),
    t('strike', [{ type: 'strike' }]),
    t('underline', [{ type: 'underline' }]),
    t('code', [{ type: 'code' }]),
    { type: 'hardBreak' },
    t('site', link('/contact#inquiry')),
    t('web', link('https://example.com/a?b=c')),
    t('mail', link('mailto:hello@example.com')),
    t('phone', link('tel:+966500000000')),
  ),
  {
    type: 'bulletList',
    content: [{ type: 'listItem', content: [p(t('a'))] }],
  },
  {
    type: 'orderedList',
    attrs: { start: 1, type: null },
    content: [{ type: 'listItem', content: [p(t('b'))] }],
  },
  { type: 'blockquote', content: [p(t('quoted'))] },
  { type: 'codeBlock', attrs: { language: null }, content: [t('x = 1')] },
  { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('y')] },
  { type: 'horizontalRule' },
  { type: 'paragraph' },
);

describe('a section body (SectionDocSchema)', () => {
  it('takes everything the admin editor makes', () => {
    const parsed = SectionDocSchema.safeParse(EDITOR_OUTPUT);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('refuses what the renderer would drop or change, rather than storing it', () => {
    const refused: [string, unknown][] = [
      ['an image', doc(p(t('x')), { type: 'image', attrs: { src: 'https://example.com/i.png' } })],
      ['an unknown node', doc(p(t('x')), { type: 'iframe', content: [t('y')] })],
      ['a table', doc({ type: 'table', content: [p(t('x'))] })],
      ['an unknown mark', doc(p(t('x', [{ type: 'highlight' }])))],
      ['a text style mark', doc(p(t('x', [{ type: 'textStyle', attrs: { color: 'red' } }])))],
      ['a level 1 heading', doc({ type: 'heading', attrs: { level: 1 }, content: [t('x')] })],
      ['a level 5 heading', doc({ type: 'heading', attrs: { level: 5 }, content: [t('x')] })],
      ['a heading with no level', doc({ type: 'heading', content: [t('x')] })],
      ['a javascript: link', doc(p(t('x', link('javascript:alert(1)'))))],
      ['a data: link', doc(p(t('x', link('data:text/html,<b>x</b>'))))],
      ['a scheme-relative link', doc(p(t('x', link('//evil.example/a'))))],
      ['a backslash link', doc(p(t('x', link('/\\evil.example'))))],
      ['a link with no href', doc(p(t('x', [{ type: 'link', attrs: {} }])))],
      [
        'a code language that is markup',
        doc({ type: 'codeBlock', attrs: { language: 'x" onload="y' }, content: [t('z')] }),
      ],
      ['text on a paragraph', doc({ type: 'paragraph', text: 'x' })],
      [
        'marks on a paragraph',
        doc({ type: 'paragraph', marks: [{ type: 'bold' }], content: [t('x')] }),
      ],
      ['a text node with children', doc(p({ type: 'text', text: 'x', content: [t('y')] }))],
      ['a text node with no text', doc(p({ type: 'text' }))],
      ['no words at all', doc(p(), { type: 'horizontalRule' })],
      ['an empty document', doc()],
      ['blank words', doc(p(t('   ')))],
    ];
    for (const [name, d] of refused) expect(ok(d), name).toBe(false);
  });

  it('is bounded in depth and in size before it walks any further', () => {
    let deep: Node = t('x');
    for (let i = 0; i < SECTION_DOC_MAX_DEPTH; i += 1)
      deep = { type: 'blockquote', content: [deep] };
    expect(ok(doc(deep))).toBe(false);
    let fits: Node = p(t('x'));
    for (let i = 0; i < SECTION_DOC_MAX_DEPTH - 2; i += 1)
      fits = { type: 'blockquote', content: [fits] };
    expect(ok(doc(fits))).toBe(true);
    const many = Array.from({ length: SECTION_DOC_MAX_NODES / 2 }, () => p(t('x')));
    expect(ok(doc(...many))).toBe(true);
    expect(ok(doc(...many, p(t('y'))))).toBe(false);
  });

  it('a stored body renders as the editor wrote it: the renderer drops nothing it takes', () => {
    // Every text the schema takes reaches the HTML (an alteration would lose words or links).
    const html = renderTiptapToHtml(EDITOR_OUTPUT);
    for (const word of ['Two', 'Three', 'Four', 'bold', 'site', 'web', 'mail', 'phone', 'quoted']) {
      expect(html).toContain(word);
    }
    expect(html.match(/<a /g)).toHaveLength(4);
    expect(html).not.toMatch(/\sstyle=|<h1/);
  });

  it('keeps a link exactly when the renderer keeps it (sectionHrefKept is sanitizeHref)', () => {
    const hrefs = [
      '/about',
      '/contact#inquiry',
      '#top',
      '?q=1',
      '/a/../b',
      'https://example.com',
      'http://example.com',
      'HTTPS://EXAMPLE.COM',
      'mailto:a@b.c',
      'tel:+1',
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,x',
      'vbscript:x',
      'file:///etc/passwd',
      'ftp://example.com',
      '//evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      '/%5Cevil.example',
      'https:evil.example',
      'https://',
      '',
      '   ',
      'x'.repeat(2049),
      'relative/path',
      'about:blank',
    ];
    for (const href of hrefs) {
      expect(sectionHrefKept(href), JSON.stringify(href)).toBe(sanitizeHref(href) !== null);
    }
    expect(sectionHrefKept(42)).toBe(false);
    expect(sectionHrefKept(undefined)).toBe(false);
  });
});

describe('a body in both languages (SectionBodySchema)', () => {
  const body = { en: doc(p(t('Hello'))), ar: doc(p(t('مرحبا ١٢٣'))) };
  it('needs both, and nothing else', () => {
    expect(SectionBodySchema.safeParse(body).success).toBe(true);
    expect(SectionBodySchema.safeParse({ en: body.en }).success).toBe(false);
    expect(SectionBodySchema.safeParse({ ar: body.ar }).success).toBe(false);
    expect(SectionBodySchema.safeParse({ ...body, fr: body.en }).success).toBe(false);
    expect(SectionBodySchema.safeParse({ en: body.en, ar: doc(p()) }).success).toBe(false);
  });
  it('keeps Arabic digits as written (P-12)', () => {
    const parsed = SectionBodySchema.parse(body);
    expect(JSON.stringify(parsed)).toContain('١٢٣');
  });
});

describe('the three content schemas', () => {
  const id = '5eed0a00-0000-4000-8000-000000000007';

  it('are strict: a stray key is refused, never stored and ignored', () => {
    expect(TextBlockSectionContentSchema.safeParse({ html: '<b>x</b>' }).success).toBe(false);
    expect(GallerySectionContentSchema.safeParse({ images: [] }).success).toBe(false);
    expect(VideoSectionContentSchema.safeParse({ poster: id }).success).toBe(false);
    expect(
      GallerySectionContentSchema.safeParse({ items: [{ mediaId: id, caption: 'x' }] }).success,
    ).toBe(false);
  });

  it('every field is optional: an empty block is valid content (it renders nothing)', () => {
    for (const type of ['textBlock', 'gallery', 'video'] as const) {
      expect(sectionContentIssues(type, {}), type).toEqual([]);
    }
  });

  it('a gallery holds one to twelve media library ids, as the grid writes them', () => {
    const items = (n: number) => Array.from({ length: n }, () => ({ kind: 'image', mediaId: id }));
    expect(GallerySectionContentSchema.safeParse({ items: items(1) }).success).toBe(true);
    expect(GallerySectionContentSchema.safeParse({ items: items(GALLERY_MAX_ITEMS) }).success).toBe(
      true,
    );
    expect(
      GallerySectionContentSchema.safeParse({ items: items(GALLERY_MAX_ITEMS + 1) }).success,
    ).toBe(false);
    expect(GallerySectionContentSchema.safeParse({ items: [] }).success).toBe(false);
    expect(
      GallerySectionContentSchema.safeParse({ items: [{ mediaId: 'not-a-uuid' }] }).success,
    ).toBe(false);
    expect(
      GallerySectionContentSchema.safeParse({ items: [{ kind: 'video', mediaId: id }] }).success,
    ).toBe(false);
  });

  it('a video’s film is a window of a site file; a Stream UID and other paths are refused', () => {
    const v = (clip: object) => VideoSectionContentSchema.safeParse({ mediaId: id, clip }).success;
    expect(v({ path: '/media/showreel.mp4', startS: 14, endS: 15.4 })).toBe(true);
    expect(v({ path: '/media/showreel.mp4' })).toBe(true);
    expect(v({ streamUid: '0123456789abcdef0123456789abcdef' })).toBe(false);
    expect(v({ path: 'https://evil.example/a.mp4' })).toBe(false);
    expect(v({ path: '/media/../secret.mp4' })).toBe(false);
    expect(v({ path: '/media/showreel.mp4', startS: 0, endS: 31 })).toBe(false);
  });

  it('the write boundary refuses a hostile body with a 422 issue on the field', () => {
    const parsed = SectionWriteSchema.safeParse({
      pageId: id,
      type: 'textBlock',
      content: {
        body: {
          en: doc(p(t('x', link('javascript:alert(1)')))),
          ar: doc(p(t('س'))),
        },
      },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(['content', 'body', 'en']);
  });
});

describe('layout and editor helpers', () => {
  it('a gallery takes as many columns as fill its rows', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 12].map(galleryColumns)).toEqual([1, 1, 2, 3, 2, 3, 3, 3, 3]);
  });

  it('a document has words only when some text is more than white space', () => {
    expect(docHasWords(doc(p(t('x'))))).toBe(true);
    expect(docHasWords(doc(p(t('  ')), p()))).toBe(false);
    expect(docHasWords(doc())).toBe(false);
    expect(docHasWords(undefined)).toBe(false);
    expect(
      docHasWords({
        type: 'doc',
        content: [{ type: 'bulletList', content: [{ type: 'listItem', content: [p(t('deep'))] }] }],
      }),
    ).toBe(true);
  });
});
