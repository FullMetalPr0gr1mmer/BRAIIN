import { describe, it, expect } from 'vitest';
import { GET as enRss } from '@/pages/creative-knowledge/rss.xml';
import { GET as arRss } from '@/pages/ar/creative-knowledge/rss.xml';

// The AR feed did not exist — the route comment said it "can be added later", which is
// how a bilingual site ships a monolingual feed. Both twins now share one builder, and
// these tests assert they stay in step.

const call = (h: unknown) => (h as unknown as () => Promise<Response>)();
const text = async (h: unknown) => await (await call(h)).text();

describe('RSS feeds — both language twins exist', () => {
  it('serves an EN feed declaring language=en', async () => {
    const xml = await text(enRss);
    expect(xml).toContain('<language>en</language>');
    expect(xml).toContain('<rss version="2.0"');
  });

  it('serves an AR feed declaring language=ar', async () => {
    const xml = await text(arRss);
    expect(xml).toContain('<language>ar</language>');
  });

  it('points each feed at its OWN language channel, not the EN one', async () => {
    expect(await text(enRss)).toContain(
      '<link>https://www.braiinstation.com/creative-knowledge</link>',
    );
    expect(await text(arRss)).toContain(
      '<link>https://www.braiinstation.com/ar/creative-knowledge</link>',
    );
  });

  it('carries a self-referential atom:link per feed', async () => {
    expect(await text(enRss)).toContain(
      '<atom:link href="https://www.braiinstation.com/creative-knowledge/rss.xml" rel="self"',
    );
    expect(await text(arRss)).toContain(
      '<atom:link href="https://www.braiinstation.com/ar/creative-knowledge/rss.xml" rel="self"',
    );
  });

  it('gives the AR feed a genuinely Arabic channel title, not a transliterated EN one', async () => {
    const xml = await text(arRss);
    const title = /<title>([^<]+)<\/title>/.exec(xml)?.[1] ?? '';
    expect(/[؀-ۿ]/.test(title)).toBe(true);
  });

  it('omits lastBuildDate when there are no posts rather than claiming now()', async () => {
    // Same truthfulness rule as the sitemap's lastmod: a build date that moves on every
    // fetch is a lie that costs crawl budget. No posts under test → no date.
    expect(await text(enRss)).not.toContain('<lastBuildDate>');
  });

  it('is served as RSS with a purgeable Cache-Tag', async () => {
    for (const h of [enRss, arRss]) {
      const res = await call(h);
      expect(res.headers.get('content-type')).toContain('application/rss+xml');
      expect(res.headers.get('cache-tag')).toContain('blog:all');
    }
  });
});
