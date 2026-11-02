import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import BlogDetail from '@/components/BlogDetail.astro';
import { toPostDetail, type PostDetailRow } from '@/lib/data/blog';
import { LOCALES, renderComponent } from './harness';

// H15 (PRE-2): the served post page. Its body is what the allowlist renderer wrote from the
// post's Tiptap source, or, for a post with no source (the seed's), from its cache read back
// into a document; the stored cache itself never reaches the page.

const SEED_POSTS = (
  JSON.parse(
    readFileSync(join(process.cwd(), 'supabase', 'seed-data', '30-legacy-demo.json'), 'utf8'),
  ) as {
    blocks: { table: string; rows: { slug: string; body_html: { en: string; ar: string } }[] }[];
  }
).blocks.find((b) => b.table === 'blog_posts')!.rows;

const row = (over: Partial<PostDetailRow>): PostDetailRow => ({
  id: '99999999-9999-4999-8999-999999999999',
  slug: 'arabic-first-brand-systems',
  title: { en: 'Arabic-first brand systems', ar: 'أنظمة هوية تبدأ بالعربية' },
  excerpt: null,
  body_html: null,
  cover_image_url: null,
  published_at: '2026-06-10T09:00:00Z',
  updated_at: null,
  reading_minutes: 4,
  author: null,
  category: null,
  body: null,
  ...over,
});

const HOSTILE = {
  en: '<p>cached</p><script>alert(1)</script><img src=x onerror=alert(1)>',
  ar: '<a href="javascript:alert(1)" style="position:fixed">x</a>',
};

const article = (html: string): string => {
  const match = /<article>[\s\S]*<\/article>/.exec(html);
  if (!match) throw new Error('no article in the page');
  return match[0];
};

describe('the post page body (BlogDetail)', () => {
  for (const locale of LOCALES) {
    it(`${locale}: the seed's posts serve the bytes of their cache, read back and re-rendered`, async () => {
      for (const seed of SEED_POSTS) {
        const post = toPostDetail(row({ slug: seed.slug, body_html: seed.body_html }), locale);
        const html = article(await renderComponent(BlogDetail, { locale, post }));
        expect(html).toContain(`<div class="prose">${seed.body_html[locale]}</div>`);
      }
    });

    it(`${locale}: a post with a source serves it, and nothing of a hostile cache`, async () => {
      const post = toPostDetail(
        row({
          body_html: HOSTILE,
          body: {
            en: {
              type: 'doc',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'From the source' }] },
              ],
            },
          },
        }),
        locale,
      );
      const html = article(await renderComponent(BlogDetail, { locale, post }));
      // No Arabic source: the Arabic page falls back to the English body, as before.
      expect(html).toContain('<div class="prose"><p>From the source</p></div>');
      expect(html).not.toMatch(/cached|<script|onerror|javascript:|style=/);
    });

    it(`${locale}: a post with no source and a cache the renderer did not write serves no body`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const post = toPostDetail(row({ body_html: HOSTILE }), locale);
      const html = article(await renderComponent(BlogDetail, { locale, post }));
      expect(html).not.toContain('class="prose"');
      expect(html).not.toMatch(/cached|<script|onerror|javascript:|style=/);
      expect(html).toContain('<h1>');
      warn.mockRestore();
    });
  }
});
