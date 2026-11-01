import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Article bodies for H15's byte-for-byte and differential specs (tests/lib/articleRender.spec.ts,
// tests/lib/articleDoc.spec.ts): every kind of node and mark the article renderer takes, the
// bodies it refuses, a long real article and a seeded random corpus.

const doc = (content: unknown[]) => ({ type: 'doc', content });
const text = (value: string, marks?: unknown[]) =>
  marks ? { type: 'text', text: value, marks } : { type: 'text', text: value };
const para = (content: unknown[]) => ({ type: 'paragraph', content });

/** The long real article: docs/fonts.md as the admin's editor stores it (437 nodes, 6 deep). */
export const LONG_ARTICLE = JSON.parse(
  readFileSync(join(process.cwd(), 'tests', 'fixtures', 'articles', 'fonts.json'), 'utf8'),
) as unknown;

/** Every kind of node and mark the article renderer takes, as the editor and older rows hold them. */
export const ARTICLE_CASES: Record<string, unknown> = {
  paragraph: doc([para([text('Plain words.')])]),
  emptyParagraph: doc([{ type: 'paragraph' }, { type: 'paragraph', content: [] }]),
  escapes: doc([para([text(`<script>alert(1)</script> " ' & < >`)])]),
  arabic: doc([para([text('الأرقام ٠١٢٣٤٥٦٧٨٩ و۰۱۲۳۴۵۶۷۸۹ تبقى كما هي.')])]),
  headings: doc(
    [1, 2, 3, 4, 5, 6, 7, '3', null, 2.6].map((level) => ({
      type: 'heading',
      attrs: { level },
      content: [text(`Level ${String(level)}`)],
    })),
  ),
  headingNoAttrs: doc([{ type: 'heading', content: [text('No level')] }, { type: 'heading' }]),
  marks: doc([
    para([
      text('b', [{ type: 'bold' }]),
      text('s', [{ type: 'strong' }]),
      text('i', [{ type: 'italic' }]),
      text('e', [{ type: 'em' }]),
      text('x', [{ type: 'strike' }]),
      text('u', [{ type: 'underline' }]),
      text('c', [{ type: 'code' }]),
      text('sup', [{ type: 'superscript' }]),
      text('sub', [{ type: 'subscript' }]),
      text('all', [{ type: 'bold' }, { type: 'italic' }, { type: 'underline' }, { type: 'code' }]),
      text('unknown', [{ type: 'highlight', attrs: { color: 'red' } }]),
      text('empty marks', []),
    ]),
  ]),
  links: doc([
    para([
      text('https', [{ type: 'link', attrs: { href: 'https://example.test/a?b=1&c="2"' } }]),
      text('mail', [{ type: 'link', attrs: { href: 'mailto:hello@example.test' } }]),
      text('tel', [{ type: 'link', attrs: { href: 'tel:+966500000000' } }]),
      text('site', [{ type: 'link', attrs: { href: '/services#top' } }]),
      text('hash', [{ type: 'link', attrs: { href: '#faq' } }]),
      text('js', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]),
      text('scheme-relative', [{ type: 'link', attrs: { href: '//evil.example' } }]),
      text('no href', [{ type: 'link' }]),
      text('editor link', [
        {
          type: 'link',
          attrs: {
            href: 'https://example.test',
            target: '_blank',
            rel: 'noopener noreferrer nofollow',
            class: null,
          },
        },
      ]),
      text('bold link', [{ type: 'bold' }, { type: 'link', attrs: { href: '/a' } }]),
    ]),
  ]),
  lists: doc([
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [para([text('one')])] },
        {
          type: 'listItem',
          content: [
            para([text('two')]),
            {
              type: 'orderedList',
              attrs: { start: 3, type: null },
              content: [{ type: 'listItem', content: [para([text('nested')])] }],
            },
          ],
        },
      ],
    },
    { type: 'orderedList', content: [] },
    { type: 'bulletList' },
    { type: 'listItem' },
  ]),
  quote: doc([{ type: 'blockquote', content: [para([text('Quoted.')])] }, { type: 'blockquote' }]),
  code: doc([
    { type: 'codeBlock', attrs: { language: 'TypeScript' }, content: [text('const a = 1 < 2;')] },
    { type: 'codeBlock', attrs: { language: 'js" onmouseover="x' }, content: [text('a')] },
    { type: 'codeBlock', attrs: { language: null }, content: [text('plain')] },
    { type: 'codeBlock' },
  ]),
  breaksAndRules: doc([
    para([text('line one'), { type: 'hardBreak' }, text('line two')]),
    { type: 'horizontalRule' },
    { type: 'hardBreak', marks: [{ type: 'bold' }] },
  ]),
  images: doc([
    { type: 'image', attrs: { src: '/a.png', alt: 'A "quoted" alt', width: 800, height: 600 } },
    { type: 'image', attrs: { src: 'https://example.test/b.jpg' } },
    { type: 'image', attrs: { src: 'data:image/svg+xml,<svg onload=alert(1)>' } },
    { type: 'image', attrs: { src: '/c.png', alt: 5, width: 10.6, height: '20' } },
    { type: 'image' },
  ]),
  unknownNodes: doc([
    { type: 'iframeEmbed', attrs: { src: 'https://evil.test' }, content: [text('kept words')] },
    { type: 'table', content: [{ type: 'tableRow', content: [para([text('cell')])] }] },
    { type: 'mystery' },
  ]),
  textAtTop: doc([text('bare text at the top'), para([text('then a paragraph')])]),
  textWithChildren: doc([
    para([{ type: 'text', text: 'parent', content: [text(' child')] }]),
    { type: 'paragraph', text: 'ignored text key', content: [text('kept')] },
  ]),
  extraKeys: doc([
    { type: 'paragraph', id: 'x', style: 'color:red', content: [text('extra keys')] },
  ]),
  styledAttrs: doc([
    { type: 'paragraph', attrs: { style: 'position:fixed', class: 'admin-nav' }, content: [] },
    { type: 'paragraph', attrs: { textAlign: 'center' }, content: [text('aligned')] },
  ]),
  emptyDoc: { type: 'doc', content: [] },
  docOnly: { type: 'doc' },
  docExtraKey: { type: 'doc', content: [para([text('x')])], attrs: { lang: 'en' } },
};

/** Bodies the renderer has always refused ('' for each). */
export const INVALID_CASES: Record<string, unknown> = {
  null: null,
  string: 'not a doc',
  array: [para([text('x')])],
  notDoc: { type: 'paragraph' },
  contentNotArray: { type: 'doc', content: { type: 'paragraph' } },
  nodeNotObject: doc(['text']),
  typeMissing: doc([{ content: [text('x')] }]),
  typeNotString: doc([{ type: 5 }]),
  typeTooLong: doc([{ type: 'p'.repeat(41) }]),
  textNotString: doc([para([{ type: 'text', text: 5 }])]),
  attrsArray: doc([{ type: 'paragraph', attrs: ['x'] }]),
  attrsNull: doc([{ type: 'paragraph', attrs: null }]),
  marksNotArray: doc([para([{ type: 'text', text: 'x', marks: { type: 'bold' } }])]),
  markNotObject: doc([para([{ type: 'text', text: 'x', marks: ['bold'] }])]),
  markTypeTooLong: doc([para([text('x', [{ type: 'b'.repeat(41) }])])]),
  markAttrsArray: doc([para([text('x', [{ type: 'link', attrs: ['/a'] }])])]),
  childContentNull: doc([{ type: 'paragraph', content: null }]),
};

// ── A seeded random corpus: shapes no one wrote by hand ─────────────────────────────

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TYPES = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'hardBreak',
  'image',
  'text',
  'text',
  'text',
  'mystery',
  'doc',
];
const MARKS = [
  'bold',
  'strong',
  'italic',
  'em',
  'strike',
  'underline',
  'code',
  'superscript',
  'subscript',
  'link',
  'link',
  'highlight',
];
const HREFS = ['https://a.test/x', '/p', '#h', 'javascript:x', '//evil', 'mailto:a@b.test', 5];
const WORDS = ['a', '<b>', '&amp;', '"q"', "'s'", 'كلمة', '٣', ' ', ''];

/** One random node, `depth` levels down (an invalid one about one time in sixty). */
function randomNode(next: () => number, depth: number, budget: { left: number }): unknown {
  budget.left -= 1;
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const r = next();
  if (r < 0.015) return pick([null, 'x', 5, [], { type: 7 }, { type: 'text', text: 3 }]);
  const type = pick(TYPES);
  const node: Record<string, unknown> = { type };
  if (type === 'text' || next() < 0.05) node['text'] = pick(WORDS) + pick(WORDS);
  if (next() < 0.35) {
    const attrs: Record<string, unknown> = {};
    if (type === 'heading') attrs['level'] = pick([1, 2, 3, 4, 5, 6, 9, '2', 2.5]);
    if (type === 'codeBlock') attrs['language'] = pick(['ts', 'C++', 'x y', null, 'a'.repeat(21)]);
    if (type === 'image') {
      attrs['src'] = pick(HREFS);
      if (next() < 0.5) attrs['alt'] = pick(WORDS);
      if (next() < 0.5) Object.assign(attrs, { width: 640, height: 480 });
    }
    if (next() < 0.2) attrs['style'] = 'color:red';
    node['attrs'] = attrs;
  }
  if (next() < 0.4) {
    node['marks'] = Array.from({ length: Math.floor(next() * 3) + 1 }, () => {
      const markType = pick(MARKS);
      return markType === 'link'
        ? { type: 'link', attrs: { href: pick(HREFS) } }
        : next() < 0.2
          ? { type: markType, attrs: {} }
          : { type: markType };
    });
  }
  if (depth < 6 && budget.left > 0 && type !== 'text' && next() < 0.7) {
    node['content'] = Array.from({ length: Math.floor(next() * 4) }, () =>
      randomNode(next, depth + 1, budget),
    );
  }
  return node;
}

/** `count` random documents, the same ones every run. */
export function randomCorpus(count: number, seed = 0x15c0de): unknown[] {
  const next = prng(seed);
  return Array.from({ length: count }, () => {
    const budget = { left: 60 };
    return doc(
      Array.from({ length: Math.floor(next() * 5) + 1 }, () => randomNode(next, 1, budget)),
    );
  });
}
