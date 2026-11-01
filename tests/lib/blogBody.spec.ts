import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { renderTiptapToHtml } from '@/lib/content/tiptap';
import { docFromRenderedHtml } from '@/lib/content/renderedHtml';
import { SEED_SERVICES } from '../fixtures/serviceSeeds';
import { ARTICLE_CASES, LONG_ARTICLE, randomCorpus } from '../fixtures/articleCorpus';

// H15 (PRE-2): the blog page rendered the stored `body_html` cache with set:html and sanitised
// it on render with nothing, and a staff token can write that column straight through
// PostgREST (0011). The page now renders the body from its Tiptap source with the allowlist
// renderer; a post with no source (the seed's) has its cache READ BACK into a document by a
// strict reader of the renderer's own markup, then rendered, so the HTML a visitor receives is
// always the renderer's.

// A minimal PostgREST stand-in for the post page's one read.
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
        maybeSingle: async () => ({ data: postRow, error: null }),
      };
      return q;
    },
  }),
}));

const { getPostBySlug, postBodyHtml, POST_DETAIL_COLUMNS } = await import('@/lib/data/blog');

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
    // Many paragraphs are fine to READ: the renderer's own bound then renders a body past it as
    // nothing (5,000 nodes).
    const wide = '<p>x</p>'.repeat(10_000);
    expect(renderTiptapToHtml(docFromRenderedHtml(wide))).toBe('');
  });
});

describe('the post page renders its body from the source (postBodyHtml, getPostBySlug)', () => {
  it('selects the source for the page', async () => {
    postRow = { ...POST, body: { en: doc([para('From the source')]) } };
    selects.length = 0;
    await getPostBySlug('arabic-first-brand-systems');
    expect(selects).toEqual([POST_DETAIL_COLUMNS]);
    expect(POST_DETAIL_COLUMNS).toMatch(/,body$/);
  });

  it('a post with a source: rendered from it, the cache never read, even when hostile', async () => {
    postRow = {
      ...POST,
      body_html: { en: '<p>cached</p><script>alert(1)</script>' },
      body: { en: doc([para('<b>From</b> the source')]), ar: doc([para('من المصدر')]) },
    };
    const post = await getPostBySlug('arabic-first-brand-systems');
    expect(post?.bodyHtml).toEqual({
      en: '<p>&lt;b&gt;From&lt;/b&gt; the source</p>',
      ar: '<p>من المصدر</p>',
    });
    // The page receives neither the source nor the cache: only what was rendered.
    expect(JSON.stringify(post)).not.toContain('cached');
    expect(post).not.toHaveProperty('body');
    expect(post).not.toHaveProperty('body_html');
  });

  it('a post with no source (the seed’s): its cache, read back, renders to the same bytes', async () => {
    for (const seed of SEED_POSTS) {
      postRow = { ...POST, slug: seed.slug, body_html: seed.body_html, body: null };
      expect((await getPostBySlug(seed.slug))?.bodyHtml).toEqual(seed.body_html);
    }
  });

  it('a post with no source and a cache the renderer did not write: no body, the post still renders', async () => {
    for (const cache of HOSTILE_CACHES) {
      postRow = { ...POST, body_html: { en: cache }, body: null };
      const post = await getPostBySlug('arabic-first-brand-systems');
      expect(post?.slug, cache).toBe('arabic-first-brand-systems');
      expect(post?.bodyHtml, cache).toBeNull();
    }
  });

  it('a source nested 20,000 deep, or one that is not a document: no body, the post still renders', async () => {
    let node: unknown = { type: 'text', text: 'x' };
    for (let i = 0; i < 20_000; i += 1) node = { type: 'blockquote', content: [node] };
    for (const body of [{ en: doc([node]) }, 'not a doc', [1], { en: 5 }]) {
      postRow = { ...POST, body };
      const post = await getPostBySlug('arabic-first-brand-systems');
      expect(post?.slug).toBe('arabic-first-brand-systems');
      expect(post?.bodyHtml).toBeNull();
    }
  });

  it('a row whose cache the post schema refuses is still a 404, as before H15', async () => {
    postRow = { ...POST, body_html: { en: '' }, body: { en: doc([para('x')]) } };
    expect(await getPostBySlug('arabic-first-brand-systems')).toBeNull();
  });

  it('postBodyHtml: an Arabic cache with no Arabic source keeps the English fallback', () => {
    expect(postBodyHtml({ body: null, body_html: { en: '<p>en</p>' } })).toEqual({
      en: '<p>en</p>',
    });
    expect(postBodyHtml({ body: null, body_html: null })).toBeNull();
    expect(postBodyHtml({ body: { ar: doc([para('ع')]) }, body_html: null })).toEqual({
      en: '',
      ar: '<p>ع</p>',
    });
  });
});
