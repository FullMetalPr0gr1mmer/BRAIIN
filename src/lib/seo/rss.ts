import type { Locale } from '@schemas/primitives';
import { getPublishedPosts } from '@/lib/data/blog';
import { localizedPath, pickLocale, pickLocaleStrict } from '@/lib/i18n';

// One RSS builder for BOTH language feeds (CLAUDE.md §8: "Both EN and AR built").
// The EN feed was previously written inline in the route with `p.title.en` hardcoded and
// `<language>en</language>` fixed, and the AR twin was a comment saying it "can be added
// later" — which is how a bilingual site ships a monolingual feed. Sharing the builder
// means the twins cannot drift.

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CHANNEL = {
  en: {
    title: 'Creative Knowledge — Braiin Station',
    description: 'Field notes on branding, motion, video, web, and SEO/GEO/AEO.',
  },
  ar: {
    title: 'المعرفة الإبداعية — بريين ستيشن',
    description: 'ملاحظات ميدانية في العلامات التجارية والموشن والفيديو والويب وتحسين الظهور.',
  },
} as const;

export async function buildRssFeed(locale: Locale, siteUrl: string): Promise<Response> {
  const base = siteUrl.replace(/\/$/, '');
  const posts = await getPublishedPosts();
  const channelPath = base + localizedPath('/creative-knowledge', locale);
  const selfPath = `${channelPath}/rss.xml`;

  const items = posts
    .map((p) => {
      // Titles are LocalizedTextSchema — Arabic is guaranteed, so pickLocale never falls
      // back here. Descriptions come from prose, where Arabic may lag, so they take the
      // STRICT read: an English blurb inside a <language>ar</language> feed is a language
      // mismatch, and the item is still perfectly usable without a description.
      const title = esc(pickLocale(p.title, locale, p.slug));
      const link = base + localizedPath(`/creative-knowledge/${p.slug}`, locale);
      const desc = esc(pickLocaleStrict(p.excerpt, locale));
      const pub = p.published_at ? new Date(p.published_at).toUTCString() : '';
      return (
        `    <item>\n` +
        `      <title>${title}</title>\n` +
        `      <link>${link}</link>\n` +
        `      <guid isPermaLink="true">${link}</guid>\n` +
        (pub ? `      <pubDate>${pub}</pubDate>\n` : '') +
        (desc ? `      <description>${desc}</description>\n` : '') +
        `    </item>`
      );
    })
    .join('\n');

  // lastBuildDate is the newest POST date, not now() — same truthfulness rule as the
  // sitemap's lastmod. Emitting now() would claim a rebuild on every fetch.
  const newest = posts
    .map((p) => p.published_at)
    .filter((d): d is string => !!d)
    .sort()
    .at(-1);

  const c = CHANNEL[locale];
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n' +
    '  <channel>\n' +
    `    <title>${esc(c.title)}</title>\n` +
    `    <link>${channelPath}</link>\n` +
    `    <atom:link href="${selfPath}" rel="self" type="application/rss+xml"/>\n` +
    `    <description>${esc(c.description)}</description>\n` +
    `    <language>${locale}</language>\n` +
    (newest ? `    <lastBuildDate>${new Date(newest).toUTCString()}</lastBuildDate>\n` : '') +
    (items ? items + '\n' : '') +
    '  </channel>\n' +
    '</rss>\n';

  return new Response(xml, {
    headers: {
      'content-type': 'application/rss+xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      'cache-tag': `route:rss,rss:${locale},blog:all`,
    },
  });
}
