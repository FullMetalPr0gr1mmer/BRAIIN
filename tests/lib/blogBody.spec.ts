import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderTiptapToHtml } from '@/lib/content/tiptap';
import { RENDERED_HTML_MAX_LENGTH, docFromRenderedHtml } from '@/lib/content/renderedHtml';
import { ARTICLE_DOC_MAX_NODES } from '@schemas/tiptap';
import { SEED_SERVICES } from '../fixtures/serviceSeeds';
import { ARTICLE_CASES, LONG_ARTICLE, randomCorpus } from '../fixtures/articleCorpus';

// H15 (PRE-2): the blog page rendered the stored `body_html` cache with set:html and sanitised
// it on render with nothing, and a staff token can write that column straight through
// PostgREST (0011). The page now renders the body from its Tiptap source with the allowlist
// renderer; a post with no source (the seed's) has its cache READ BACK into a document by a
// strict reader of the renderer's own markup, then rendered, so the HTML a visitor receives is
// always the renderer's.

// A minimal PostgREST stand-in for the post page's one read and the list's.
let postRow: Record<string, unknown> | null = null;
const selects: string[] = [];
vi.mock('@/lib/supabase/client', () => ({
  supabaseConfigured: () => true,
  anonClient: () => ({
    from: () => {
      const q = {
        select: (columns: string) => {
          selects.push(columns);
          return q;
        },
        eq: () => q,
        order: () => q,
        maybeSingle: async () => ({ data: postRow, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: postRow ? [postRow] : [], error: null }),
      };
      return q;
    },
  }),
}));

// Every article render the post page asks for, recorded (H15 code review, CR2: one language).
const renders = vi.hoisted(() => ({ docs: [] as unknown[] }));
vi.mock('@/lib/content/tiptap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/content/tiptap')>();
  return {
    ...actual,
    renderArticle: (doc: unknown) => {
      renders.docs.push(doc);
      return actual.renderArticle(doc);
    },
  };
});

const { getPostBySlug, getPublishedPosts, postBodyHtml, POST_DETAIL_COLUMNS } =
  await import('@/lib/data/blog');

const doc = (content: unknown[]) => ({ type: 'doc', content });
const para = (words: string) => ({ type: 'paragraph', content: [{ type: 'text', text: words }] });

/** The seed's two posts, which hold only the cache (supabase/seed-data/30-legacy-demo.json). */
const SEED_POSTS = (
  JSON.parse(
    readFileSync(join(process.cwd(), 'supabase', 'seed-data', '30-legacy-demo.json'), 'utf8'),
  ) as {
    blocks: { table: string; rows: { slug: string; body_html: { en: string; ar: string } }[] }[];
  }
).blocks.find((b) => b.table === 'blog_posts')!.rows;

const POST = {
  id: '99999999-9999-4999-8999-999999999999',
  slug: 'arabic-first-brand-systems',
  title: { en: 'Arabic-first brand systems', ar: 'أنظمة هوية تبدأ بالعربية' },
  excerpt: null,
  body_html: { en: '<p>cached</p>' },
  cover_image_url: null,
  published_at: '2026-06-10T09:00:00Z',
  updated_at: null,
  reading_minutes: 4,
  author: null,
  category: null,
  body: null,
};

/** What a direct PostgREST write can put in the cache. */
const HOSTILE_CACHES = [
  '<script>alert(1)</script>',
  '<p>x</p><script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<img src="/a.png" alt="" onerror="alert(1)" loading="lazy" decoding="async" />',
  '<a href="javascript:alert(1)" rel="noopener noreferrer ugc">x</a>',
  '<a href="//evil.example" rel="noopener noreferrer ugc">x</a>',
  '<a href="https://evil.example">x</a>',
  '<a href="https://evil.example" rel="noopener noreferrer ugc">x',
  '<p style="position:fixed;inset:0">x</p>',
  '<p class="admin-nav">x</p>',
  '<meta http-equiv="refresh" content="0;url=https://evil.example">',
  '<iframe src="https://evil.example"></iframe>',
  '<P>x</P>',
  '<p>x</div><div>',
  '</p><p>x</p>',
  '<p>a "quote"</p>',
  "<p>it's</p>",
  '<p>&#60;script&#62;</p>',
  '<p>&nbsp;</p>',
  '<br>',
  '<strong><p>x</p></strong>',
  '<strong>a<em>b</em></strong>',
  '<pre><code class="language-x" onclick="y">a</code></pre>',
  '<pre>a</pre>',
  '<svg><script>alert(1)</script></svg>',
  '<h1>Two h1s</h1>',
  '<!-- a comment -->',
  '<p>x</p ><p>y</p>',
];

describe('the reader takes back exactly the renderer’s markup', () => {
  const bodies: [string, unknown][] = [
    ...Object.entries(ARTICLE_CASES),
    ['long article', LONG_ARTICLE],
    ...SEED_SERVICES.flatMap((s): [string, unknown][] => [
      [`${s.slug}.en`, s.body?.en],
      [`${s.slug}.ar`, s.body?.ar],
    ]),
    ...randomCorpus(600, 0xb10b).map((body, i): [string, unknown] => [`random ${i}`, body]),
  ];

  it('every render reads back into a document that renders to the same bytes', () => {
    for (const [name, body] of bodies) {
      const html = renderTiptapToHtml(body);
      const back = docFromRenderedHtml(html);
      expect(back, name).not.toBeNull();
      expect(renderTiptapToHtml(back), name).toBe(html);
    }
  });

  it("the seed's posts render to their cache, byte for byte", () => {
    expect(SEED_POSTS).toHaveLength(2);
    for (const post of SEED_POSTS) {
      for (const lang of ['en', 'ar'] as const) {
        expect(renderTiptapToHtml(docFromRenderedHtml(post.body_html[lang]))).toBe(
          post.body_html[lang],
        );
      }
    }
  });

  it('refuses anything else whole: no tag, attribute or entity the renderer does not write', () => {
    for (const cache of HOSTILE_CACHES) {
      expect(docFromRenderedHtml(cache), cache).toBeNull();
    }
    expect(docFromRenderedHtml(null)).toBeNull();
    expect(docFromRenderedHtml({ en: '<p>x</p>' })).toBeNull();
  });

  it('a nesting bomb or a flood of tags is refused, never a throw, and costs little', () => {
    const deep = '<blockquote>'.repeat(100_000) + 'x' + '</blockquote>'.repeat(100_000);
    const marks = '<strong>'.repeat(100_000) + 'x' + '</strong>'.repeat(100_000);
    const start = performance.now();
    expect(docFromRenderedHtml(deep)).toBeNull();
    expect(docFromRenderedHtml(marks)).toBeNull();
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('the reader is bounded like the walk it feeds (H15 review, SEC-1)', () => {
  /** Fastest of `runs`, in ms, after a warm-up: what the code costs, not the machine's load. */
  function fastest(fn: () => void, runs = 10): number {
    for (let i = 0; i < 3; i += 1) fn();
    let best = Infinity;
    for (let i = 0; i < runs; i += 1) {
      const start = performance.now();
      fn();
      best = Math.min(best, performance.now() - start);
    }
    return best;
  }

  it(`takes ${ARTICLE_DOC_MAX_NODES} nodes and refuses one more, as the renderer would`, () => {
    // A paragraph and its words are two nodes.
    const atTheCap = '<p>x</p>'.repeat(ARTICLE_DOC_MAX_NODES / 2);
    const back = docFromRenderedHtml(atTheCap);
    expect(back).not.toBeNull();
    expect(renderTiptapToHtml(back)).toBe(atTheCap);
    for (const more of ['<hr />', '<p>x</p>', '<ul><li></li></ul>', '<p><strong></strong></p>']) {
      expect(docFromRenderedHtml(atTheCap + more), more).toBeNull();
    }
  });

  it('a flood of paragraphs (100 KB, 25,000 nodes) is refused at the cap, for what the cap costs', () => {
    // Before the bound every node of the flood was built (11 to 16 ms alone, five times the
    // cap's own read), then the renderer refused it. Now the reading stops one node past the cap:
    // measured alone, about 2 ms. The two are timed in turn, so the machine's load counts the
    // same on both.
    const flood = '<p>x</p>'.repeat(12_500);
    const atTheCap = '<p>x</p>'.repeat(ARTICLE_DOC_MAX_NODES / 2);
    expect(flood.length).toBe(100_000);
    expect(docFromRenderedHtml(flood)).toBeNull();
    let floodBest = Infinity;
    let capBest = Infinity;
    for (let i = 0; i < 15; i += 1) {
      let start = performance.now();
      docFromRenderedHtml(flood);
      floodBest = Math.min(floodBest, performance.now() - start);
      start = performance.now();
      docFromRenderedHtml(atTheCap);
      capBest = Math.min(capBest, performance.now() - start);
    }
    expect(floodBest).toBeLessThan(capBest * 2);
  });

  it(`reads a cache of ${RENDERED_HTML_MAX_LENGTH} characters and refuses one more, before reading it`, () => {
    const words = (n: number) => `<p>${'a'.repeat(n - '<p></p>'.length)}</p>`;
    const atTheCap = words(RENDERED_HTML_MAX_LENGTH);
    expect(atTheCap.length).toBe(RENDERED_HTML_MAX_LENGTH);
    expect(renderTiptapToHtml(docFromRenderedHtml(atTheCap))).toBe(atTheCap);
    expect(docFromRenderedHtml(words(RENDERED_HTML_MAX_LENGTH + 1))).toBeNull();
    // 20 million characters of words overflowed the text check's stack (a RangeError).
    const huge = words(20_000_000);
    expect(() => docFromRenderedHtml(huge)).not.toThrow();
    expect(docFromRenderedHtml(huge)).toBeNull();
    expect(fastest(() => docFromRenderedHtml(huge))).toBeLessThan(1);
  });

  it('a long real article fits the length cap with room, and reads back', () => {
    // docs/fonts.md four times over: 1,748 nodes, about 10,700 words, near the longest real
    // article measured (docs/security-exceptions.md, 86 KB rendered).
    const four = doc(
      Array.from({ length: 4 }, () => (LONG_ARTICLE as { content: unknown[] }).content).flat(),
    );
    const html = renderTiptapToHtml(four);
    expect(html.length).toBeGreaterThan(75_000);
    expect(html.length).toBeLessThan(RENDERED_HTML_MAX_LENGTH * 0.7);
    // Read back to the same bytes (measured alone, about 2 ms; not asserted, as a wall-clock
    // bound on this reader swings with the machine's load).
    expect(renderTiptapToHtml(docFromRenderedHtml(html))).toBe(html);
  });
});

describe('the post page renders its body from the source (postBodyHtml, getPostBySlug)', () => {
  const ID = POST.id;
  it('selects the source and the cache for the page, and no body for the list (CR4)', async () => {
    postRow = { ...POST, body: { en: doc([para('From the source')]) } };
    selects.length = 0;
    await getPostBySlug('arabic-first-brand-systems', 'en');
    expect(selects).toEqual([POST_DETAIL_COLUMNS]);
    expect(POST_DETAIL_COLUMNS).toMatch(/,body_html,body$/);
    selects.length = 0;
    expect((await getPublishedPosts()).map((p) => p.slug)).toEqual(['arabic-first-brand-systems']);
    expect(selects).toHaveLength(1);
    expect(selects[0]).not.toMatch(/body/);
  });

  it('a post with a source: rendered from it, the cache never read, even when hostile', async () => {
    postRow = {
      ...POST,
      body_html: { en: '<p>cached</p><script>alert(1)</script>' },
      body: { en: doc([para('<b>From</b> the source')]), ar: doc([para('من المصدر')]) },
    };
    const post = await getPostBySlug('arabic-first-brand-systems', 'en');
    expect(post?.bodyHtml).toBe('<p>&lt;b&gt;From&lt;/b&gt; the source</p>');
    expect((await getPostBySlug('arabic-first-brand-systems', 'ar'))?.bodyHtml).toBe(
      '<p>من المصدر</p>',
    );
    // The page receives neither the source nor the cache: only what was rendered.
    expect(JSON.stringify(post)).not.toContain('cached');
    expect(post).not.toHaveProperty('body');
    expect(post).not.toHaveProperty('body_html');
  });

  it('a post with no source (the seed’s): its cache, read back, renders to the same bytes', async () => {
    for (const seed of SEED_POSTS) {
      postRow = { ...POST, slug: seed.slug, body_html: seed.body_html, body: null };
      for (const lang of ['en', 'ar'] as const) {
        expect((await getPostBySlug(seed.slug, lang))?.bodyHtml).toBe(seed.body_html[lang]);
      }
    }
  });

  it('a post with no source and a cache the renderer did not write: no body, the post still renders', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const cache of HOSTILE_CACHES) {
      postRow = { ...POST, body_html: { en: cache }, body: null };
      const post = await getPostBySlug('arabic-first-brand-systems', 'en');
      expect(post?.slug, cache).toBe('arabic-first-brand-systems');
      expect(post?.bodyHtml, cache).toBeNull();
    }
    warn.mockRestore();
  });

  it('a source nested 20,000 deep, or one that is not a document: no body, the post still renders', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let node: unknown = { type: 'text', text: 'x' };
    for (let i = 0; i < 20_000; i += 1) node = { type: 'blockquote', content: [node] };
    for (const body of [{ en: doc([node]) }, 'not a doc', [1], { en: 5 }]) {
      postRow = { ...POST, body, body_html: null };
      const post = await getPostBySlug('arabic-first-brand-systems', 'en');
      expect(post?.slug).toBe('arabic-first-brand-systems');
      expect(post?.bodyHtml).toBeNull();
    }
    warn.mockRestore();
  });

  it('a cache too long to read is no body, never a throw, and the post still renders (COR-5)', async () => {
    // It used to throw outside renderBody's try (the text check's RangeError), so the post was
    // a 404 while the blog list, the sitemap and llms.txt still listed it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const huge = `<p>${'a'.repeat(20_000_000)}</p>`;
    const row = { id: ID, body: null, body_html: { en: huge } };
    expect(() => postBodyHtml(row, 'en')).not.toThrow();
    expect(postBodyHtml(row, 'en')).toBeNull();
    postRow = { ...POST, body_html: { en: huge, ar: '<p>ع</p>' }, body: null };
    const post = await getPostBySlug('arabic-first-brand-systems', 'en');
    expect(post?.slug).toBe('arabic-first-brand-systems');
    expect(post?.bodyHtml).toBeNull();
    expect((await getPostBySlug('arabic-first-brand-systems', 'ar'))?.bodyHtml).toBe('<p>ع</p>');
    warn.mockRestore();
  });

  it('anything that throws while the body is read is no body, never a failed page', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const throwing = {
      get en(): string {
        throw new Error('unreadable');
      },
    };
    expect(postBodyHtml({ id: ID, body: null, body_html: throwing }, 'en')).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      `[content] blog_post body not rendered (id=${ID}, lang=en): Error`,
    );
    warn.mockRestore();
  });

  it('a cache that is not a pair of languages is no cache: the post renders from its source (CR4)', async () => {
    // The list no longer reads the cache, so the page must not answer 404 for a post the list
    // names because of it (before, both refused such a row, and agreed).
    for (const body_html of [{ en: '' }, 'text', [1], { en: 5 }]) {
      postRow = { ...POST, body_html, body: { en: doc([para('x')]) } };
      expect((await getPostBySlug('arabic-first-brand-systems', 'en'))?.bodyHtml).toBe('<p>x</p>');
      expect((await getPublishedPosts()).map((p) => p.slug)).toEqual([
        'arabic-first-brand-systems',
      ]);
    }
    postRow = { ...POST, body_html: { en: 5 }, body: null };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await getPostBySlug('arabic-first-brand-systems', 'en'))?.bodyHtml).toBeNull();
    warn.mockRestore();
  });

  it('postBodyHtml: an Arabic page with no Arabic body falls back to the English one, as pickLocale did', () => {
    expect(postBodyHtml({ id: ID, body: null, body_html: { en: '<p>en</p>' } }, 'ar')).toBe(
      '<p>en</p>',
    );
    expect(postBodyHtml({ id: ID, body: null, body_html: null }, 'en')).toBeNull();
    const arOnly = { id: ID, body: { ar: doc([para('ع')]) }, body_html: null };
    expect(postBodyHtml(arOnly, 'en')).toBeNull();
    expect(postBodyHtml(arOnly, 'ar')).toBe('<p>ع</p>');
  });

  it('renders only the language served (CR2)', async () => {
    const en = doc([para('English')]);
    const ar = doc([para('عربي')]);
    postRow = { ...POST, body: { en, ar }, body_html: null };
    renders.docs.length = 0;
    expect((await getPostBySlug('arabic-first-brand-systems', 'en'))?.bodyHtml).toBe(
      '<p>English</p>',
    );
    expect(renders.docs).toEqual([en]);
    renders.docs.length = 0;
    expect((await getPostBySlug('arabic-first-brand-systems', 'ar'))?.bodyHtml).toBe('<p>عربي</p>');
    expect(renders.docs).toEqual([ar]);
  });

  it('a source the renderer refuses falls back to the cache, and the refusal is logged (CR5, CR1)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let node: unknown = { type: 'text', text: 'secret words' };
    for (let i = 0; i < 40; i += 1) node = { type: 'blockquote', content: [node] };
    postRow = {
      ...POST,
      body: { en: doc([node]) },
      body_html: { en: '<p>The words it was saved with</p>' },
    };
    expect((await getPostBySlug('arabic-first-brand-systems', 'en'))?.bodyHtml).toBe(
      '<p>The words it was saved with</p>',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line.startsWith(`[content] blog_post body not rendered (id=${ID}, lang=en): `)).toBe(
      true,
    );
    expect(line).not.toContain('secret');
    warn.mockRestore();
  });

  it('a stored body is logged once when refused, and never when it renders (CR1)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Valid: a source, a cache read back, an Arabic page falling back to English, no body.
    const valid: [Record<string, unknown>, 'en' | 'ar'][] = [
      [{ ...POST, body: { en: doc([para('ok')]) }, body_html: null }, 'en'],
      [{ ...POST, body: null, body_html: SEED_POSTS[0]!.body_html }, 'ar'],
      [{ ...POST, body: { en: doc([para('ok')]) }, body_html: null }, 'ar'],
      [{ ...POST, body: null, body_html: null }, 'en'],
    ];
    for (const [row, lang] of valid) {
      postRow = row;
      expect((await getPostBySlug('arabic-first-brand-systems', lang))?.slug).toBe(
        'arabic-first-brand-systems',
      );
    }
    expect(warn).not.toHaveBeenCalled();
    // A cache the reader refuses: one line, its id, no content.
    postRow = { ...POST, body: null, body_html: { en: '<p>secret</p><script>x</script>' } };
    await getPostBySlug('arabic-first-brand-systems', 'en');
    expect(warn.mock.calls).toEqual([
      [
        `[content] blog_post body not rendered (id=${ID}, lang=en): its stored HTML is not the renderer’s markup`,
      ],
    ]);
    warn.mockRestore();
  });
});

describe('the read-back gives each heading its own attrs (CR10)', () => {
  type Headings = { content: { attrs: { level: number } }[] };
  it('changing one read-back heading changes no other', () => {
    const a = docFromRenderedHtml('<h3>a</h3>') as unknown as Headings;
    a.content[0]!.attrs.level = 5;
    const b = docFromRenderedHtml('<h3>b</h3><h3>c</h3>') as unknown as Headings;
    expect(b.content.map((h) => h.attrs.level)).toEqual([3, 3]);
    expect(b.content[0]!.attrs).not.toBe(b.content[1]!.attrs);
    expect(renderTiptapToHtml(b)).toBe('<h3>b</h3><h3>c</h3>');
  });
});
