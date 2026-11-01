import { describe, expect, it } from 'vitest';
import {
  ARTICLE_ATTR_MAX_DEPTH,
  ARTICLE_DOC_MAX_DEPTH,
  ARTICLE_DOC_MAX_FORMATTING,
  ARTICLE_DOC_MAX_MARKS,
  ARTICLE_DOC_MAX_NODES,
  LocalizedDocSchema,
  TiptapDocSchema,
  articleDocProblem,
  readArticleDoc,
} from '@schemas/tiptap';
import {
  PortfolioUpdateSchema,
  PortfolioWriteSchema,
  PostUpdateSchema,
  PostWriteSchema,
  ServiceUpdateSchema,
  ServiceWriteSchema,
} from '@schemas/admin';
import { readingMinutes, renderTiptapToHtml, tiptapToPlainText } from '@/lib/content/tiptap';
import { renderBody } from '@/lib/data/portfolio';
import { SEED_SERVICES } from '../fixtures/serviceSeeds';
import {
  ARTICLE_CASES,
  INVALID_CASES,
  LONG_ARTICLE,
  randomCorpus,
} from '../fixtures/articleCorpus';

// H15 (PRE-1): an article body (a blog post's, a service's, a project's) is read by one
// iterative, bounded walk, `readArticleDoc`, never by zod's recursive node schema, on write and
// on render. These specs hold the walk to TiptapDocSchema (the same bodies accepted, the same
// output, the same render), prove every crash class is an issue or '' and never a throw, set the
// bounds, and measure the CPU of a long real article.

const doc = (content: unknown[]) => ({ type: 'doc', content });
const text = (value: string, marks?: unknown[]) =>
  marks ? { type: 'text', text: value, marks } : { type: 'text', text: value };
const para = (content: unknown[]) => ({ type: 'paragraph', content });

/** A body nested `levels` deep: quotes in quotes, as the E10 review's probe built it. */
function nested(levels: number, inner: unknown = text('x')) {
  let node: unknown = inner;
  for (let i = 0; i < levels; i += 1) node = { type: 'blockquote', content: [node] };
  return doc([node]);
}

/** An array `levels` deep around `leaf`. */
function deepArray(levels: number, leaf: unknown = 'x'): unknown {
  let value: unknown = leaf;
  for (let i = 0; i < levels; i += 1) value = [value];
  return value;
}

const everyBody = (): [string, unknown][] => [
  ...Object.entries(ARTICLE_CASES),
  ...Object.entries(INVALID_CASES),
  ['long article', LONG_ARTICLE],
  ...SEED_SERVICES.flatMap((s): [string, unknown][] => [
    [`${s.slug}.en`, s.body?.en],
    [`${s.slug}.ar`, s.body?.ar],
  ]),
  ...randomCorpus(600, 0xa27c1e).map((body, i): [string, unknown] => [`random ${i}`, body]),
];

describe('the article walk is TiptapDocSchema, bounded (H15, PRE-1)', () => {
  it('accepts exactly the bodies TiptapDocSchema accepts', () => {
    for (const [name, body] of everyBody()) {
      expect(articleDocProblem(body) === null, name).toBe(TiptapDocSchema.safeParse(body).success);
    }
  });

  it("answers zod's own output, so a save stores what it stored before", () => {
    for (const [name, body] of everyBody()) {
      const parsed = TiptapDocSchema.safeParse(body);
      if (!parsed.success) continue;
      const read = readArticleDoc(body);
      expect('doc' in read && read.doc, name).toStrictEqual(parsed.data);
      expect(LocalizedDocSchema.parse({ en: body, ar: body }), name).toStrictEqual({
        en: parsed.data,
        ar: parsed.data,
      });
    }
  });

  it('renders the JSON as stored to the bytes it rendered from the parse', () => {
    for (const [name, body] of everyBody()) {
      const parsed = TiptapDocSchema.safeParse(body);
      const expected = parsed.success ? renderTiptapToHtml(parsed.data) : '';
      expect(renderTiptapToHtml(body), name).toBe(expected);
    }
  });

  it('drops a `__proto__` attribute as zod did, and never sets a prototype with it', () => {
    const body = JSON.parse(
      '{"type":"doc","content":[{"type":"heading","attrs":{"__proto__":{"level":4}},"content":[{"type":"text","text":"T"}]}]}',
    ) as unknown;
    const read = readArticleDoc(body);
    expect('doc' in read && read.doc).toStrictEqual(TiptapDocSchema.parse(body));
    const heading = ('doc' in read && read.doc.content?.[0]) as { attrs: object };
    expect(Object.getPrototypeOf(heading.attrs)).toBe(Object.prototype);
    expect(renderTiptapToHtml(body)).toBe('<h2>T</h2>');
  });
});

describe('every crash class is an issue or nothing rendered, never a throw', () => {
  const WRITE_SCHEMAS = {
    ServiceWriteSchema: (body: unknown) =>
      ServiceWriteSchema.safeParse({ slug: 'logo', title: { en: 'L', ar: 'ش' }, body }),
    ServiceUpdateSchema: (body: unknown) => ServiceUpdateSchema.safeParse({ version: 1, body }),
    PostWriteSchema: (body: unknown) =>
      PostWriteSchema.safeParse({ slug: 'post', title: { en: 'P', ar: 'م' }, body }),
    PostUpdateSchema: (body: unknown) => PostUpdateSchema.safeParse({ version: 1, body }),
    PortfolioWriteSchema: (body: unknown) =>
      PortfolioWriteSchema.safeParse({ slug: 'work', title: { en: 'W', ar: 'ع' }, body }),
    PortfolioUpdateSchema: (body: unknown) => PortfolioUpdateSchema.safeParse({ version: 1, body }),
  };

  // Each was a RangeError before H15 (the E10 review's probe 6: 1,250 levels, about 42 KB, threw
  // in renderTiptapToHtml and 1,247 in ServiceWriteSchema), or an unbounded cost.
  const BOMBS: Record<string, unknown> = {
    'quotes nested 1,250 deep': nested(1_250),
    'quotes nested 20,000 deep': nested(20_000),
    'a node type nested 5,000 deep': doc([{ type: deepArray(5_000) }]),
    'a mark type nested 5,000 deep': doc([para([text('x', [{ type: deepArray(5_000) }])])]),
    'an attribute nested 5,000 deep': doc([{ type: 'paragraph', attrs: { x: deepArray(5_000) } }]),
    'a mark attribute nested 5,000 deep': doc([
      para([text('x', [{ type: 'link', attrs: { href: deepArray(5_000) } }])]),
    ]),
    'text nested 5,000 deep': doc([para([{ type: 'text', text: deepArray(5_000) }])]),
    '100,000 marks on one word': doc([para([text('x', Array(100_000).fill({ type: 'bold' }))])]),
    '100,000 paragraphs': doc(Array(100_000).fill(para([text('x')]))),
  };

  for (const [name, body] of Object.entries(BOMBS)) {
    it(`${name}: rendered as nothing`, () => {
      expect(() => renderTiptapToHtml(body)).not.toThrow();
      expect(renderTiptapToHtml(body)).toBe('');
      expect(tiptapToPlainText(body)).toBe('');
      expect(readingMinutes(body)).toBe(1);
      expect(renderBody({ en: body, ar: body })).toBeNull();
    });

    it(`${name}: refused on every write schema with a plain issue on the body`, () => {
      for (const [schema, check] of Object.entries(WRITE_SCHEMAS)) {
        for (const lang of ['en', 'ar'] as const) {
          const value = lang === 'en' ? { en: body } : { en: doc([para([text('ok')])]), ar: body };
          let result: ReturnType<typeof check> | undefined;
          expect(() => (result = check(value)), `${schema} ${lang}`).not.toThrow();
          expect(result?.success, `${schema} ${lang}`).toBe(false);
          const issue = result?.error?.issues.find((i) => i.path[0] === 'body');
          expect(issue?.path, `${schema} ${lang}`).toEqual(['body', lang]);
          expect(issue?.message, `${schema} ${lang}`).toMatch(/^This text /);
        }
      }
    });
  }
});

describe('the bounds', () => {
  const paragraphs = (n: number) => doc(Array.from({ length: n }, () => ({ type: 'paragraph' })));

  it(`takes ${ARTICLE_DOC_MAX_NODES} nodes and refuses one more, before any of them is read`, () => {
    expect(articleDocProblem(paragraphs(ARTICLE_DOC_MAX_NODES))).toBeNull();
    expect(articleDocProblem(paragraphs(ARTICLE_DOC_MAX_NODES + 1))).toMatch(/too long/);
    // A quote holding them all is the same budget (the quote is one more node).
    expect(
      articleDocProblem(
        doc([{ type: 'blockquote', content: paragraphs(ARTICLE_DOC_MAX_NODES).content }]),
      ),
    ).toMatch(/too long/);
    let read = 0;
    const counted = new Proxy(paragraphs(ARTICLE_DOC_MAX_NODES + 1).content, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) read += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expect(articleDocProblem({ type: 'doc', content: counted })).toMatch(/too long/);
    expect(read).toBe(0);
  });

  it('refuses a node whose children pass the node budget before any child is read (H15 review, COR-3)', () => {
    // The same budget inside the document: a quote holding the cap's worth of paragraphs is one
    // node too many, and the walk says so before it reads, copies or stacks a single one.
    for (const copy of [false, true]) {
      let read = 0;
      const counted = new Proxy(paragraphs(ARTICLE_DOC_MAX_NODES).content, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) read += 1;
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      const body = doc([para([text('x')]), { type: 'blockquote', content: counted }]);
      const result = readArticleDoc(body, copy);
      expect('problem' in result && result.problem, `copy ${copy}`).toMatch(/too long/);
      expect(read, `copy ${copy}`).toBe(0);
    }
  });

  it(`takes ${ARTICLE_DOC_MAX_DEPTH} levels and refuses one more`, () => {
    // nested(n) puts the text n + 1 levels down.
    expect(articleDocProblem(nested(ARTICLE_DOC_MAX_DEPTH - 1))).toBeNull();
    expect(articleDocProblem(nested(ARTICLE_DOC_MAX_DEPTH))).toMatch(/too many levels/);
  });

  it(`takes ${ARTICLE_DOC_MAX_MARKS} marks on one word and refuses one more`, () => {
    const marks = (n: number) => doc([para([text('x', Array(n).fill({ type: 'bold' }))])]);
    expect(articleDocProblem(marks(ARTICLE_DOC_MAX_MARKS))).toBeNull();
    expect(articleDocProblem(marks(ARTICLE_DOC_MAX_MARKS + 1))).toMatch(/too much formatting/);
  });

  it(`takes ${ARTICLE_DOC_MAX_FORMATTING} marks and attribute values together, and refuses one more`, () => {
    // A link mark and its seven values are eight, on each of 2,500 words (2,501 nodes).
    const runs = ARTICLE_DOC_MAX_FORMATTING / 8;
    const seven = { href: '/a', target: null, rel: null, class: null, title: null, a: 1, b: 2 };
    const linked = (attrs: Record<string, unknown>) =>
      doc([para(Array.from({ length: runs }, () => text('x', [{ type: 'link', attrs }])))]);
    expect(articleDocProblem(linked(seven))).toBeNull();
    expect(articleDocProblem(linked({ ...seven, c: 3 }))).toMatch(/too much formatting/);
  });

  it(`takes an attribute value ${ARTICLE_ATTR_MAX_DEPTH} levels deep and refuses one more`, () => {
    const attr = (levels: number) =>
      doc([{ type: 'paragraph', attrs: { x: deepArray(levels - 1) } }]);
    expect(articleDocProblem(attr(ARTICLE_ATTR_MAX_DEPTH))).toBeNull();
    expect(articleDocProblem(attr(ARTICLE_ATTR_MAX_DEPTH + 1))).toMatch(/settings/);
  });

  it('a long real article is well inside every bound', () => {
    expect(articleDocProblem(LONG_ARTICLE)).toBeNull();
  });

  it('says why in plain words: no internal name, no dash (P-12)', () => {
    const problems = [
      articleDocProblem(null),
      articleDocProblem(paragraphs(ARTICLE_DOC_MAX_NODES + 1)),
      articleDocProblem(nested(ARTICLE_DOC_MAX_DEPTH)),
      articleDocProblem(doc([para([text('x', Array(17).fill({ type: 'bold' }))])])),
      articleDocProblem(doc([{ type: 'paragraph', attrs: { x: deepArray(20) } }])),
    ];
    for (const problem of problems) {
      expect(problem).toMatch(/^This text /);
      expect(problem).not.toMatch(/[–—]|doc|node|attrs|mark/);
    }
    const missing = LocalizedDocSchema.safeParse({});
    expect(missing.error?.issues[0]?.message).toBe('Write the English text.');
  });
});

describe('the CPU of a long real article (the Workers Free plan allows 10 ms a request)', () => {
  /** Fastest of `runs`, in ms, after a warm-up: what the code costs, not the machine's load. */
  function fastest(fn: () => void, runs = 20): number {
    for (let i = 0; i < 5; i += 1) fn();
    let best = Infinity;
    for (let i = 0; i < runs; i += 1) {
      const start = performance.now();
      fn();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  }

  /** The long article's blocks, end to end, up to the node cap. */
  function atTheCap(): unknown {
    const blocks = (LONG_ARTICLE as { content: unknown[] }).content;
    const out: unknown[] = [];
    let nodes = 0;
    const size = (block: unknown): number => {
      let n = 0;
      const stack = [block];
      while (stack.length > 0) {
        const node = stack.pop() as { content?: unknown[] };
        n += 1;
        stack.push(...(node.content ?? []));
      }
      return n;
    };
    for (let i = 0; ; i += 1) {
      const block = blocks[i % blocks.length];
      const n = size(block);
      if (nodes + n > ARTICLE_DOC_MAX_NODES) break;
      out.push(block);
      nodes += n;
    }
    return doc(out);
  }

  it('the long real article renders in well under 10 ms (about 8 ms before H15)', () => {
    // Measured on 2026-11-01, Node 24: 0.15 ms warm (437 nodes), against 7.7 to 8.4 ms with
    // zod's recursive parse in front of the renderer.
    expect(fastest(() => renderTiptapToHtml(LONG_ARTICLE))).toBeLessThan(3);
  });

  it('a body at the node cap renders and saves inside the budget', () => {
    const body = atTheCap();
    expect(articleDocProblem(body)).toBeNull();
    // Measured: about 2 ms to render, 1.4 ms to read for a save (5,000 nodes, 22,600 words).
    expect(fastest(() => renderTiptapToHtml(body), 10)).toBeLessThan(8);
    expect(fastest(() => LocalizedDocSchema.parse({ en: body }), 10)).toBeLessThan(8);
  });
});
