import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {
  SECTION_DOC_MARKS,
  SECTION_DOC_MAX_DEPTH,
  SECTION_DOC_MAX_NODES,
  SECTION_DOC_NODES,
  SectionBodySchema,
  SectionDocSchema,
  TiptapDocSchema,
  sectionDocProblem,
  sectionHrefKept,
} from '@schemas/tiptap';
import {
  GALLERY_MAX_ITEMS,
  GallerySectionContentSchema,
  SECTION_CONTENT_SCHEMAS,
  TextBlockSectionContentSchema,
  VideoSectionContentSchema,
  sectionContentIssues,
} from '@schemas/sections';
import { SectionWriteSchema } from '@schemas/admin';
import { renderSectionDocToHtml, renderTiptapToHtml, sanitizeHref } from '@/lib/content/tiptap';
import { galleryColumns, sectionMediaIds } from '@/lib/sections/blocks';
import { docHasWords, richTextArabicGap } from '@/lib/admin/docWords';
import { toggleLabel } from '@/lib/client/clips';

// Admin v2 E10's three blocks, at the write boundary. The Text block's body is "sanitised on
// write" by refusal: SectionDocSchema takes exactly what the admin's editor makes and the
// allowlist renderer emits unchanged, so nothing is stored that the renderer would drop or
// rewrite. The render half (src/lib/content/tiptap.ts renderSectionDocToHtml) runs the same
// walk on every render; the markup is tests/render/sectionBlocks.spec.ts's.

type Node = { type: string; text?: string; attrs?: object; marks?: object[]; content?: Node[] };
const doc = (...content: Node[]) => ({ type: 'doc', content });
const p = (...content: Node[]): Node => ({ type: 'paragraph', content });
const t = (text: string, marks?: object[]): Node =>
  marks ? { type: 'text', text, marks } : { type: 'text', text };
const link = (href: string) => [
  { type: 'link', attrs: { href, target: '_blank', rel: 'noopener' } },
];
const li = (...content: Node[]): Node => ({ type: 'listItem', content });
const ok = (d: unknown) => SectionDocSchema.safeParse(d).success;

/** The admin's editor (RichText.tsx): Tiptap 3's StarterKit, headings 2 to 4. */
const editor = getSchema([
  StarterKit.configure({ heading: { levels: [2, 3, 4] }, link: { openOnClick: false } }),
]);
/** Whether the editor's own ProseMirror schema takes a document (so the editor can make it). */
const editorTakes = (d: unknown): boolean => {
  try {
    editor.nodeFromJSON(d).check();
    return true;
  } catch {
    return false;
  }
};
/** A document as the editor stores it: every attribute written out, defaults included. */
const asEditorStores = (d: unknown): unknown => editor.nodeFromJSON(d).toJSON();

/** What the admin's Tiptap (StarterKit, headings 2 to 4, the toolbar and its shortcuts) makes. */
const EDITOR_OUTPUT = doc(
  { type: 'heading', attrs: { level: 2 }, content: [t('Two')] },
  { type: 'heading', attrs: { level: 3 }, content: [t('Three')] },
  { type: 'heading', attrs: { level: 4 }, content: [t('Four')] },
  // H2 pressed on an empty line, then left (it renders nothing).
  { type: 'heading', attrs: { level: 2 } },
  p(
    t('bold', [{ type: 'bold' }]),
    t('italic', [{ type: 'italic' }]),
    t('strike', [{ type: 'strike' }]),
    t('underline', [{ type: 'underline' }]),
    t('code', [{ type: 'code' }]),
    t('bold italic', [{ type: 'bold' }, { type: 'italic' }]),
    { type: 'hardBreak' },
    t('site', link('/contact#inquiry')),
    t('web', link('https://example.com/a?b=c')),
    t('mail', link('mailto:hello@example.com')),
    t('phone', link('tel:+966500000000')),
  ),
  // Bold over two lines: ProseMirror's addMark marks every inline node in the range, the line
  // break included (as a pasted `<b>a<br>b</b>` does), and Tiptap's JSON keeps that mark.
  p(
    t('first line', [{ type: 'bold' }]),
    { type: 'hardBreak', marks: [{ type: 'bold' }] },
    t('second line', [{ type: 'bold' }]),
  ),
  {
    type: 'bulletList',
    content: [li(p(t('a')), { type: 'bulletList', content: [li(p(t('nested')))] }), li(p())],
  },
  {
    type: 'orderedList',
    attrs: { start: 1, type: null },
    content: [li(p(t('b')))],
  },
  {
    type: 'blockquote',
    content: [p(t('quoted')), { type: 'bulletList', content: [li(p(t('q')))] }],
  },
  { type: 'codeBlock', attrs: { language: null }, content: [t('x = 1')] },
  { type: 'codeBlock', attrs: { language: 'ts' }, content: [t('y')] },
  { type: 'horizontalRule' },
  { type: 'paragraph' },
);

/** A body of `paragraphs` paragraphs, each two text runs (one a link): 3 nodes a paragraph. */
const bodyOf = (paragraphs: number) =>
  doc(
    ...Array.from({ length: paragraphs }, (_, i) =>
      p(t(`Some words in paragraph ${i} `, [{ type: 'bold' }]), t('a link', link(`/p/${i}`))),
    ),
  );

/** A JSON array nested `n` deep (`[[[…]]]`), whose String() overflows the stack. */
const deepArray = (n: number): unknown => JSON.parse('['.repeat(n) + ']'.repeat(n));

describe('a section body (SectionDocSchema)', () => {
  it('takes everything the admin editor makes, as the editor stores it', () => {
    const parsed = SectionDocSchema.safeParse(EDITOR_OUTPUT);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    // The editor's own schema takes it too, and its stored form (every attribute written out:
    // a link's target, rel, class and title, a list's start and type) passes the walk.
    expect(editorTakes(EDITOR_OUTPUT)).toBe(true);
    const stored = asEditorStores(EDITOR_OUTPUT);
    expect(JSON.stringify(stored)).toContain('"title":null');
    expect(sectionDocProblem(stored)).toBeNull();
  });

  it('knows the same node, mark and attribute names as the editor', () => {
    expect(Object.keys(editor.nodes).sort()).toEqual(['doc', ...SECTION_DOC_NODES].sort());
    expect(Object.keys(editor.marks).sort()).toEqual([...SECTION_DOC_MARKS].sort());
    // Every attribute the editor defines, at a value it writes, passes; that is the list.
    const attrs = (spec: { attrs?: object | null }) => Object.keys(spec.attrs ?? {}).sort();
    expect(attrs(editor.nodes['heading']!.spec)).toEqual(['level']);
    expect(attrs(editor.nodes['orderedList']!.spec)).toEqual(['start', 'type']);
    expect(attrs(editor.nodes['codeBlock']!.spec)).toEqual(['language']);
    expect(attrs(editor.marks['link']!.spec)).toEqual(['class', 'href', 'rel', 'target', 'title']);
    for (const name of SECTION_DOC_NODES) {
      if (!['heading', 'orderedList', 'codeBlock'].includes(name)) {
        expect(attrs(editor.nodes[name]!.spec), name).toEqual([]);
      }
    }
    for (const name of SECTION_DOC_MARKS) {
      if (name !== 'link') expect(attrs(editor.marks[name]!.spec), name).toEqual([]);
    }
    // A pasted link's own attributes are kept as the editor reads them (text, or a number).
    const pasted = doc(
      p(
        t('x', [
          {
            type: 'link',
            attrs: { href: '/a', target: '_self', rel: 'me', class: 'c', title: 2024 },
          },
        ]),
      ),
    );
    expect(editorTakes(pasted)).toBe(true);
    expect(ok(pasted)).toBe(true);
    // A pasted numbered list whose start is not a number is stored with a null start.
    const list = doc({
      type: 'orderedList',
      attrs: { start: null, type: 'a' },
      content: [li(p(t('x')))],
    });
    expect(ok(list)).toBe(true);
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
      ['a heading with no level set', doc({ type: 'heading', attrs: {}, content: [t('x')] })],
      ['a javascript: link', doc(p(t('x', link('javascript:alert(1)'))))],
      ['a data: link', doc(p(t('x', link('data:text/html,<b>x</b>'))))],
      ['a scheme-relative link', doc(p(t('x', link('//evil.example/a'))))],
      ['a backslash link', doc(p(t('x', link('/\\evil.example'))))],
      ['a link with no href', doc(p(t('x', [{ type: 'link', attrs: {} }])))],
      ['a link with no attributes', doc(p(t('x', [{ type: 'link' }])))],
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
      // The renderer writes `<br />` and `<hr />` and drops whatever is inside them.
      ['words inside a line break', doc(p(t('x'), { type: 'hardBreak', content: [t('lost')] }))],
      ['words inside a rule', doc(p(t('x')), { type: 'horizontalRule', content: [t('lost')] })],
      ['marks on a rule', doc(p(t('x')), { type: 'horizontalRule', marks: [{ type: 'bold' }] })],
      [
        'a line break carrying a link the renderer drops',
        doc(p(t('x'), { type: 'hardBreak', marks: link('javascript:alert(1)') })),
      ],
      ['a text node with no text', doc(p({ type: 'text' }))],
      ['no words at all', doc(p(), { type: 'horizontalRule' })],
      ['an empty document', doc()],
      ['blank words', doc(p(t('   ')))],
    ];
    for (const [name, d] of refused) expect(ok(d), name).toBe(false);
  });

  // E10-C3: StarterKit's content model. Each of these is refused by the editor's own schema
  // too, so no editor output is lost to it, and each would render broken markup (<li> outside
  // a list, <ul><p>, <p><p>) if stored.
  it('refuses a layout the editor cannot make (its content model)', () => {
    const misplaced: [string, unknown][] = [
      ['a list item at the top', doc(li(p(t('x'))))],
      ['a list item in a quote', doc({ type: 'blockquote', content: [li(p(t('x')))] })],
      ['a paragraph straight in a list', doc({ type: 'bulletList', content: [p(t('x'))] })],
      ['words straight in a list', doc({ type: 'orderedList', content: [t('x')] })],
      ['a paragraph in a paragraph', doc(p(p(t('x'))))],
      ['a list in a paragraph', doc(p({ type: 'bulletList', content: [li(p(t('x')))] }))],
      [
        'a heading in a heading',
        doc({ type: 'heading', attrs: { level: 2 }, content: [p(t('x'))] }),
      ],
      [
        'a heading in a code block',
        doc({ type: 'codeBlock', content: [{ type: 'heading', attrs: { level: 2 } }] }),
      ],
      [
        'a line break in a code block',
        doc({ type: 'codeBlock', content: [{ type: 'hardBreak' }] }),
      ],
      [
        'bold words in a code block',
        doc({ type: 'codeBlock', content: [t('x', [{ type: 'bold' }])] }),
      ],
      ['words straight in the document', doc(t('x'))],
      ['words straight in a quote', doc({ type: 'blockquote', content: [t('x')] })],
      ['a line break straight in a list item', doc({ type: 'bulletList', content: [li(t('x'))] })],
      ['a rule in a paragraph', doc(p(t('x'), { type: 'horizontalRule' }))],
      ['an empty list', doc(p(t('x')), { type: 'bulletList', content: [] })],
      ['a list with no content at all', doc(p(t('x')), { type: 'orderedList' })],
      ['an empty quote', doc(p(t('x')), { type: 'blockquote' })],
      ['an empty list item', doc(p(t('x')), { type: 'bulletList', content: [li()] })],
      [
        'a list item that opens with a heading',
        doc({
          type: 'bulletList',
          content: [li({ type: 'heading', attrs: { level: 2 }, content: [t('x')] }, p(t('y')))],
        }),
      ],
    ];
    for (const [name, d] of misplaced) {
      expect(sectionDocProblem(d), name).not.toBeNull();
      expect(editorTakes(d), `${name}: the editor's schema refuses it too`).toBe(false);
    }
  });

  // E10-S4: attributes are the editor's, by name, with scalar values; nothing rides along.
  it('refuses an attribute the editor does not write, or a value that is not a scalar', () => {
    const id = '5eed0a00-0000-4000-8000-000000000007';
    const refused: [string, unknown][] = [
      [
        'a mediaId on a paragraph',
        doc({ type: 'paragraph', attrs: { mediaId: id }, content: [t('x')] }),
      ],
      [
        'a mediaId on a heading',
        doc({ type: 'heading', attrs: { level: 2, mediaId: id }, content: [t('x')] }),
      ],
      [
        'a mediaId on a link',
        doc(p(t('x', [{ type: 'link', attrs: { href: '/a', mediaId: id } }]))),
      ],
      ['a mediaId on a bold mark', doc(p(t('x', [{ type: 'bold', attrs: { mediaId: id } }])))],
      ['a mediaId on text', doc(p({ type: 'text', text: 'x', attrs: { mediaId: id } }))],
      ['a mediaId as a stray node key', doc({ ...p(t('x')), mediaId: id } as Node)],
      [
        'a list nested in a link title',
        doc(p(t('x', [{ type: 'link', attrs: { href: '/a', title: deepArray(4500) } }]))),
      ],
      [
        'an object as a link target',
        doc(p(t('x', [{ type: 'link', attrs: { href: '/a', target: { a: 1 } } }]))),
      ],
      [
        'a deep list as an attribute',
        doc({ type: 'paragraph', attrs: { junk: deepArray(4500) }, content: [t('x')] }),
      ],
      [
        'a list start that is text',
        doc({ type: 'orderedList', attrs: { start: '1' }, content: [li(p(t('x')))] }),
      ],
      [
        'a list start that is a fraction',
        doc({ type: 'orderedList', attrs: { start: 1.5 }, content: [li(p(t('x')))] }),
      ],
      ['a level that is text', doc({ type: 'heading', attrs: { level: '2' }, content: [t('x')] })],
      [
        'a language that is a number',
        doc({ type: 'codeBlock', attrs: { language: 7 }, content: [t('x')] }),
      ],
      [
        'a style on a list item',
        doc({ type: 'bulletList', content: [{ ...li(p(t('x'))), attrs: { style: 'x' } }] }),
      ],
      [
        'an attribute on a quote',
        doc({ type: 'blockquote', attrs: { cite: 'x' }, content: [p(t('x'))] }),
      ],
      [
        'attrs that are a list on a rule',
        doc(p(t('x')), { type: 'horizontalRule', attrs: [] as unknown as object }),
      ],
    ];
    for (const [name, d] of refused) {
      expect(sectionDocProblem(d), name).not.toBeNull();
    }
    // An empty attribute object (as ProseMirror may write one) is no attribute.
    expect(
      ok(doc({ type: 'paragraph', attrs: {}, content: [t('x', [{ type: 'bold', attrs: {} }])] })),
    ).toBe(true);
  });

  it('refuses the same formatting twice on the same words, and a long list of marks at once', () => {
    expect(ok(doc(p(t('x', [{ type: 'bold' }, { type: 'bold' }]))))).toBe(false);
    expect(
      ok(
        doc(
          p(
            t('x', [
              { type: 'link', attrs: { href: '/a' } },
              { type: 'link', attrs: { href: '/b' } },
            ]),
          ),
        ),
      ),
    ).toBe(false);
    expect(editorTakes(doc(p(t('x', [{ type: 'bold' }, { type: 'bold' }]))))).toBe(false);
    // 3,900 bold marks on one text (a 62 KB payload once rendered 3,900 nested <strong>): the
    // count is refused before a single mark is read.
    const many = Array.from({ length: 3900 }, () => ({ type: 'bold' }));
    const bomb = doc(p(t('x', many)));
    expect(JSON.stringify(bomb).length).toBeLessThan(65_536);
    expect(sectionDocProblem(bomb)).toBe('The same formatting is set twice on the same words.');
    // Every mark type once is the most a word may carry.
    const all = SECTION_DOC_MARKS.map((type) =>
      type === 'link' ? { type, attrs: { href: '/a' } } : { type },
    );
    expect(ok(doc(p(t('x', all))))).toBe(true);
  });

  it('is bounded in depth and in size before it walks any further', () => {
    let deep: Node = p(t('x'));
    for (let i = 0; i < SECTION_DOC_MAX_DEPTH; i += 1)
      deep = { type: 'blockquote', content: [deep] };
    expect(ok(doc(deep))).toBe(false);
    let fits: Node = p(t('x'));
    for (let i = 0; i < SECTION_DOC_MAX_DEPTH - 2; i += 1)
      fits = { type: 'blockquote', content: [fits] };
    expect(ok(doc(fits))).toBe(true);
    const many = Array.from({ length: SECTION_DOC_MAX_NODES / 2 }, () => p(t('x')));
    expect(ok(doc(...many))).toBe(true);
    expect(sectionDocProblem(doc(...many, p(t('y'))))).toBe(
      'This text is too long for one block. Split it into two Text blocks.',
    );
  });

  it('a nesting bomb inside the 64 KB payload is refused, not a stack overflow', () => {
    // zod's recursive TiptapNodeSchema throws a RangeError near 1,900 levels (measured): the
    // section walk reads the raw JSON iteratively and stops at SECTION_DOC_MAX_DEPTH.
    let bomb: Node = p(t('x'));
    for (let i = 0; i < 1900; i += 1) bomb = { type: 'blockquote', content: [bomb] };
    const d = doc(bomb);
    expect(JSON.stringify(d).length).toBeLessThan(65_536);
    expect(() => SectionDocSchema.safeParse(d)).not.toThrow();
    expect(ok(d)).toBe(false);
    expect(
      sectionContentIssues('textBlock', { body: { en: d, ar: d } }).map((i) => i.message),
    ).toContain('This text has too many levels inside each other. Use fewer lists inside lists.');
  });

  // E10-S1: a node's or a mark's `type` nested 3,500 deep. String() of it recursed through
  // Array.prototype.join and threw a RangeError inside the walk; every path returns an issue.
  it('a type, or a mark type, nested 3,500 deep is an issue, never a throw', () => {
    const typeBomb = doc({ type: deepArray(3500) as string, content: [t('x')] });
    const markBomb = doc(p(t('x', [{ type: deepArray(3500) }])));
    const fine = doc(p(t('س')));
    for (const [name, d] of [
      ['type', typeBomb],
      ['mark type', markBomb],
    ] as const) {
      const content = { body: { en: d, ar: fine } };
      expect(JSON.stringify(content).length, name).toBeLessThan(65_536);
      expect(() => sectionDocProblem(d), name).not.toThrow();
      expect(sectionDocProblem(d), name).toMatch(
        /^A Text block cannot show this .*\("object"\)\.$/,
      );
      expect(() => sectionContentIssues('textBlock', content), name).not.toThrow();
      expect(sectionContentIssues('textBlock', content).length, name).toBeGreaterThan(0);
      const load = SECTION_CONTENT_SCHEMAS.textBlock!.safeParse(content);
      expect(load.success, name).toBe(false);
      const write = SectionWriteSchema.safeParse({
        pageId: '5eed0a00-0000-4000-8000-000000000007',
        type: 'textBlock',
        content,
      });
      expect(write.success, name).toBe(false);
      expect(write.error?.issues[0]?.path, name).toEqual(['content', 'body', 'en']);
      expect(() => renderSectionDocToHtml(d), name).not.toThrow();
      expect(renderSectionDocToHtml(d), name).toBe('');
    }
  });

  // E10 check: the attrs allowlist read inherited Object.prototype members. `constructor` and
  // `toString` found a function and were accepted (a hidden mediaId rode in that way), and
  // `__proto__`, `hasOwnProperty` and `valueOf` made the walk throw. Parsed with JSON.parse, as a
  // request body is, so `__proto__` is an own key.
  it('an attribute named after an Object.prototype member is refused, never accepted or thrown', () => {
    const MEDIA = '{"mediaId":"5eed0a00-0000-4000-8000-0000000000aa"}';
    const fine = doc(p(t('س')));
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
      const bodies: [string, unknown][] = [
        [
          `${name} on a paragraph`,
          JSON.parse(
            `{"type":"doc","content":[{"type":"paragraph","attrs":{"${name}":${MEDIA}},"content":[{"type":"text","text":"x"}]}]}`,
          ),
        ],
        [
          `${name} on a heading`,
          JSON.parse(
            `{"type":"doc","content":[{"type":"heading","attrs":{"level":2,"${name}":${MEDIA}},"content":[{"type":"text","text":"x"}]}]}`,
          ),
        ],
        [
          `${name} on a bold mark`,
          JSON.parse(
            `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x","marks":[{"type":"bold","attrs":{"${name}":${MEDIA}}}]}]}]}`,
          ),
        ],
        [
          `${name} on a link`,
          JSON.parse(
            `{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x","marks":[{"type":"link","attrs":{"href":"/about","${name}":${MEDIA}}}]}]}]}`,
          ),
        ],
      ];
      for (const [label, d] of bodies) {
        expect(() => sectionDocProblem(d), label).not.toThrow();
        expect(sectionDocProblem(d), label).toBe(
          'This text carries settings the editor does not make.',
        );
        const content = { body: { en: d, ar: fine } };
        expect(() => sectionContentIssues('textBlock', content), label).not.toThrow();
        expect(SECTION_CONTENT_SCHEMAS.textBlock!.safeParse(content).success, label).toBe(false);
        const write = SectionWriteSchema.safeParse({
          pageId: '5eed0a00-0000-4000-8000-000000000007',
          type: 'textBlock',
          content,
        });
        expect(write.success, label).toBe(false);
        expect(() => renderSectionDocToHtml(d), label).not.toThrow();
      }
    }
  });

  it('refuses a malformed tree: a stray key, a node or mark that is not an object', () => {
    const malformed: [string, unknown][] = [
      ['a string', 'text'],
      ['an array', []],
      ['a doc with a stray key', { type: 'doc', content: [p(t('x'))], html: '<b>x</b>' }],
      ['content that is not a list', { type: 'doc', content: { 0: p(t('x')) } }],
      ['a node that is a string', doc(p(t('x')), 'x' as unknown as Node)],
      ['a node with a stray key', doc({ ...p(t('x')), style: 'color:red' } as Node)],
      [
        'attrs that are a list',
        doc({ type: 'heading', attrs: [2] as unknown as object, content: [t('x')] }),
      ],
      [
        'a mark with a stray key',
        doc(p({ type: 'text', text: 'x', marks: [{ type: 'bold', style: 'x' }] })),
      ],
      [
        'marks that are not a list',
        doc(p({ type: 'text', text: 'x', marks: { type: 'bold' } as unknown as object[] })),
      ],
      ['a mark that is not an object', doc(p(t('x', ['bold' as unknown as object])))],
      ['a type that is not a string', doc({ type: 7 as unknown as string, content: [t('x')] })],
      [
        'content of a paragraph that is not a list',
        doc({ type: 'paragraph', content: 'x' } as unknown as Node),
      ],
    ];
    for (const [name, d] of malformed) expect(ok(d), name).toBe(false);
  });

  // E10-C8: what an editor reads (P-12): plain words, never the editor's own names.
  it('says why in plain words, never an internal name or a dash', () => {
    const cases: unknown[] = [
      doc(p(t('x'), { type: 'hardBreak', content: [t('y')] })),
      doc(p(t('x')), { type: 'horizontalRule', content: [] }),
      doc(li(p(t('x')))),
      doc({ type: 'bulletList', content: [p(t('x'))] }),
      doc(p(p(t('x')))),
      doc({ type: 'codeBlock', content: [t('x', [{ type: 'bold' }])] }),
      doc({ type: 'codeBlock', attrs: { language: '<x>' }, content: [t('x')] }),
      doc({ type: 'blockquote' }),
      doc(p(t('x')), { type: 'bulletList', content: [li()] }),
      doc(p(t('x', [{ type: 'bold' }, { type: 'bold' }]))),
      doc({ type: 'paragraph', attrs: { a: 1 }, content: [t('x')] }),
      doc({ type: 'image' }),
      doc(...Array.from({ length: SECTION_DOC_MAX_NODES }, () => p(t('x')))),
      doc(p()),
      'x',
    ];
    const internal = new RegExp(
      `\\b(?:${[...SECTION_DOC_NODES, ...SECTION_DOC_MARKS]
        .filter((n) => /[A-Z]/.test(n))
        .join('|')})\\b`,
    );
    for (const d of cases) {
      const message = sectionDocProblem(d);
      expect(message, JSON.stringify(d).slice(0, 80)).not.toBeNull();
      expect(message).not.toMatch(internal);
      expect(message).not.toMatch(/[–—]/);
      expect(message).toMatch(/[.)]$/);
    }
  });

  it('whatever it takes, the renderer’s own schema takes unchanged (so its parse is shallow)', () => {
    const parsed = TiptapDocSchema.safeParse(EDITOR_OUTPUT);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual(EDITOR_OUTPUT);
    expect(SectionDocSchema.parse(EDITOR_OUTPUT)).toEqual(EDITOR_OUTPUT);
  });

  it('a stored body renders as the editor wrote it: the renderer drops nothing it takes', () => {
    // Every text the schema takes reaches the HTML (an alteration would lose words or links).
    const html = renderSectionDocToHtml(EDITOR_OUTPUT);
    for (const word of ['Two', 'Three', 'Four', 'bold', 'site', 'web', 'mail', 'phone', 'quoted']) {
      expect(html).toContain(word);
    }
    // The marked line break is still a line break between its two bold lines.
    expect(html).toContain('<strong>first line</strong><br /><strong>second line</strong>');
    expect(html.match(/<a /g)).toHaveLength(4);
    expect(html).not.toMatch(/\sstyle=|<h1/);
    // The empty heading and the empty list item render nothing (E10-C4).
    expect(html).not.toMatch(/<h2><\/h2>|<li><\/li>/);
    expect(html).toContain('<li><p>a</p><ul><li><p>nested</p></li></ul></li></ul>');
  });

  it('an article body renders as it always did (renderTiptapToHtml is unchanged)', () => {
    // The section render leaves out the empty heading and list item; the article renderer,
    // which blog, service and project bodies go through, still writes them.
    const article = renderTiptapToHtml(EDITOR_OUTPUT);
    expect(article).toContain('<h2></h2>');
    expect(article).toContain('<li></li>');
    expect(article.replace('<h2></h2>', '').replace('<li></li>', '')).toBe(
      renderSectionDocToHtml(EDITOR_OUTPUT),
    );
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

// E10-S3 / E10-C1: the Text block renders without zod's recursive parse, linear in the body.
describe('what a body costs to check and to render', () => {
  /** Every property read and key listing of `value` and everything under it. */
  function counted<T>(value: T, hits: { n: number }): T {
    if (typeof value !== 'object' || value === null) return value;
    return new Proxy(value as object, {
      get(target, key, receiver) {
        hits.n += 1;
        return counted(Reflect.get(target, key, receiver) as unknown, hits);
      },
      ownKeys(target) {
        hits.n += 1;
        return Reflect.ownKeys(target);
      },
    }) as T;
  }
  const readsOf = (fn: (d: unknown) => unknown, d: unknown): number => {
    const hits = { n: 0 };
    fn(counted(d, hits));
    return hits.n;
  };

  it('the walk and the render read each node a fixed number of times (linear)', () => {
    for (const fn of [sectionDocProblem, renderSectionDocToHtml]) {
      const small = readsOf(fn, bodyOf(40));
      const large = readsOf(fn, bodyOf(80));
      // Twice the nodes, twice the reads (and a constant): never more.
      expect(large / small, fn.name).toBeGreaterThan(1.9);
      expect(large / small, fn.name).toBeLessThan(2.1);
    }
  });

  it('a body at the 300-node cap renders well inside the CPU a request has', () => {
    const body = bodyOf(SECTION_DOC_MAX_NODES / 3);
    expect(sectionDocProblem(body)).toBeNull();
    for (let i = 0; i < 50; i += 1) renderSectionDocToHtml(body);
    const runs = Array.from({ length: 20 }, () => {
      const start = performance.now();
      renderSectionDocToHtml(body);
      return performance.now() - start;
    });
    // Measured 0.3 to 1.4 ms warm (Node 24, 2026-10-31 and 2026-11-01, the second under load);
    // zod's parse of the same body, which the Text block no longer runs, 6 to 26 ms. A generous
    // bound, read off the fastest run so a loaded machine does not fail it: 3 ms.
    expect(Math.min(...runs)).toBeLessThan(3);
    expect(renderSectionDocToHtml(body)).toBe(renderTiptapToHtml(body));
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
  it('the Video’s own control is named for what pressing it does next', () => {
    const labels = { pause: 'Pause the film', play: 'Play the film' };
    expect(toggleLabel(false, labels)).toBe('Pause the film');
    expect(toggleLabel(true, labels)).toBe('Play the film');
  });

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

  it('a body whose languages go together is an Arabic gap when only the English has words', () => {
    const words = doc(p(t('x')));
    const none = doc(p());
    expect(richTextArabicGap(true, { en: words, ar: none })).toBe(true);
    expect(richTextArabicGap(true, { en: words })).toBe(true);
    expect(richTextArabicGap(true, { en: words, ar: doc(p(t('س'))) })).toBe(false);
    expect(richTextArabicGap(true, { en: none, ar: none })).toBe(false);
    expect(richTextArabicGap(true, null)).toBe(false);
    // An article's or a service's body (no `bothLanguages`) may have its Arabic later.
    expect(richTextArabicGap(false, { en: words })).toBe(false);
  });

  it('a page’s section media ids: every block’s, in page order, each once', () => {
    const a = '5eed0a00-0000-4000-8000-00000000000a';
    const b = '5eed0a00-0000-4000-8000-00000000000b';
    const c = '5eed0a00-0000-4000-8000-00000000000c';
    expect(
      sectionMediaIds([
        { type: 'aboutWho', props: { mediaId: a } },
        { type: 'gallery', props: { items: [{ mediaId: b }, { mediaId: a }, { kind: 'x' }] } },
        { type: 'video', props: { mediaId: c } },
        { type: 'workIntro', props: { media: [{ mediaId: c }, 'junk'] } },
        { type: 'hero', props: { mediaId: 'not read: no media of a hero is the page’s' } },
        { type: 'gallery', props: { items: 'not a list' } },
        { type: 'video' },
      ]),
    ).toEqual([a, b, c]);
  });
});
