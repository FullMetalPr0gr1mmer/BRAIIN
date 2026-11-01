import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Locale } from '@schemas/primitives';
import { MEDIA_BLOCKS_PER_PAGE } from '@schemas/sectionTypes';
import type { SectionData } from '@/lib/sections/types';
import { POSTER, SECTION_MEDIA_FAIL, SECTION_MEDIA_READS } from './fixtures';
import { LOCALES, renderSections } from './harness';

// Admin v2 E10's blocks as a visitor's browser receives them, in both languages: what the
// standard asks of each, read off the served markup (the snapshots in sections.spec.ts hold
// the bytes; this holds the rules).
//
//   Text block  the body is the allowlist renderer's output and nothing else: no script, no
//               style attribute, no image, no unsafe link, even for a document that reached
//               the component without passing the write schema (the section walk refuses it
//               whole); an empty heading or list item renders nothing;
//   Gallery     a lazy, sized <img> per picture with the library's alt in the page's language;
//   Video       no <video> in the HTML (clips.ts creates it in view): the still is lazy and
//               sized, the frame an in-view clip surface of a /media file, never after-load;
//   one read    a page's section media are read once, whatever its blocks (SectionRenderer).

const text = (en: string, ar: string) => ({ en, ar });
const para = (t: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }],
});

const render = (sections: SectionData[], locale: Locale) => renderSections(sections, locale);

/**
 * The opening tags of every `<tag …>` in the markup, quoted attribute values read whole (an
 * image source holds the normalised `<root>` path, whose `>` would end a naive match).
 */
const tags = (html: string, name: string) =>
  html.match(new RegExp(`<${name}(?:\\s(?:[^>"]|"[^"]*")*)?>`, 'g')) ?? [];

describe('Text block', () => {
  for (const locale of LOCALES) {
    test(`renders the body of its language through the allowlist renderer (${locale})`, async () => {
      const html = await render(
        [
          {
            type: 'textBlock',
            props: {
              heading: text('Heading words', 'كلمات العنوان'),
              body: { en: para('English body ١٢٣'), ar: para('النص العربي ١٢٣') },
            },
          },
        ],
        locale,
      );
      expect(html).toContain(
        locale === 'en' ? '<p>English body ١٢٣</p>' : '<p>النص العربي ١٢٣</p>',
      );
      expect(html).not.toContain(locale === 'en' ? 'النص العربي' : 'English body');
      expect(html).toContain(locale === 'en' ? 'Heading words' : 'كلمات العنوان');
      expect(tags(html, 'h2')).toHaveLength(1);
      expect(html).not.toMatch(/\sstyle=/);
    });
  }

  test('a hostile document that skipped the write schema renders no body at all', async () => {
    const hostile = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '<script>alert(1)</script>' },
            {
              type: 'text',
              text: 'click',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
            {
              type: 'text',
              text: 'away',
              marks: [{ type: 'link', attrs: { href: '//evil.example/x' } }],
            },
          ],
        },
        { type: 'image', attrs: { src: 'data:image/png;base64,AAAA', alt: 'x' } },
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Big' }] },
        { type: 'iframe', attrs: { src: 'https://evil.example' } },
      ],
    };
    const html = await render(
      [
        {
          type: 'textBlock',
          props: { heading: text('Kept', 'باقٍ'), body: { en: hostile, ar: hostile } },
        },
      ],
      'en',
    );
    // The section walk refuses it on render as on write: the heading stays, the body is gone.
    expect(html).toContain('Kept');
    expect(html).not.toContain('blk-prose');
    expect(html).not.toMatch(/script|javascript:|evil\.example|data:image|click|away|Big/);
    expect(tags(html, 'img')).toHaveLength(0);
    expect(tags(html, 'iframe')).toHaveLength(0);
    expect(tags(html, 'h1')).toHaveLength(0);
    expect(html).not.toMatch(/\sstyle=/);
  });

  test('markup typed as words is escaped, never parsed', async () => {
    const html = await render(
      [
        {
          type: 'textBlock',
          props: {
            body: {
              en: para('<script>alert(1)</script><img src=x onerror=y>'),
              ar: para('<b>س</b>'),
            },
          },
        },
      ],
      'en',
    );
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=y&gt;');
    expect(tags(html, 'img')).toHaveLength(0);
  });

  test('an empty heading or list item renders nothing (no <h3></h3>, no <li></li>)', async () => {
    const words = (t: string) => [{ type: 'text', text: t }];
    const body = {
      type: 'doc',
      content: [
        // H3 pressed on an empty line, then left: what the editor stores.
        { type: 'heading', attrs: { level: 3 } },
        { type: 'heading', attrs: { level: 4 }, content: words('   ') },
        { type: 'paragraph', content: words('Words') },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph' }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: words('One') }] },
          ],
        },
        // A list whose every item is empty leaves no empty list behind.
        { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }] },
        { type: 'blockquote', content: [{ type: 'paragraph' }] },
        { type: 'codeBlock', attrs: { language: null } },
      ],
    };
    const html = await render(
      [{ type: 'textBlock', props: { body: { en: body, ar: body } } }],
      'en',
    );
    expect(html).toContain('<p>Words</p><ul><li><p>One</p></li></ul>');
    expect(html).not.toMatch(/<h[2-6]>\s*<\/h[2-6]>|<h3>|<h4>/);
    expect(html).not.toMatch(/<li>\s*<\/li>|<ol>|<blockquote>|<pre>/);
  });

  test('with nothing written it renders nothing', async () => {
    expect(await render([{ type: 'textBlock' }], 'en')).not.toContain('blk-text');
  });
});

describe('Gallery', () => {
  for (const locale of LOCALES) {
    test(`a lazy, sized picture each, with the library's alt in ${locale}`, async () => {
      const html = await render(
        [{ type: 'gallery', props: { items: [{ mediaId: POSTER.id }, { mediaId: POSTER.id }] } }],
        locale,
      );
      const imgs = tags(html, 'img');
      expect(imgs).toHaveLength(2);
      for (const img of imgs) {
        expect(img).toMatch(/\swidth="\d+"/);
        expect(img).toMatch(/\sheight="\d+"/);
        expect(img).toContain('loading="lazy"');
        expect(img).toContain(`alt="${POSTER.alt![locale]}"`);
      }
      expect(html).toContain('blk-gal__grid--2');
      expect(html).not.toMatch(/\sstyle=/);
    });
  }
});

describe('Video', () => {
  for (const locale of LOCALES) {
    test(`ships the still only, an in-view clip surface (${locale})`, async () => {
      const html = await render(
        [
          // Not the first section: the first is the top of the page (CR10 below).
          { type: 'textBlock', props: { heading: text('Above', 'فوق') } },
          {
            type: 'video',
            props: {
              heading: text('A film', 'فيلم'),
              mediaId: POSTER.id,
              clip: { path: '/media/showreel.mp4', startS: 14, endS: 15.4 },
            },
          },
        ],
        locale,
      );
      // Zero video bytes before intersection starts here: no <video>, no <source>, no preload.
      expect(tags(html, 'video')).toHaveLength(0);
      expect(tags(html, 'source').filter((s) => s.includes('.mp4'))).toHaveLength(0);
      const frame = tags(html, 'div').find((d) => d.includes('data-clip-src'));
      expect(frame).toBeDefined();
      expect(frame).toContain('data-clip-src="/media/showreel.mp4"');
      expect(frame).toContain('data-clip-mode="inview"');
      expect(frame).toContain('data-clip-start="14"');
      expect(frame).toContain('data-clip-end="15.4"');
      // Never waits for `load` as an LCP poster would, and is never eager.
      expect(frame).not.toContain('data-clip-after-load');
      const imgs = tags(html, 'img');
      expect(imgs).toHaveLength(1);
      expect(imgs[0]).toContain('loading="lazy"');
      expect(imgs[0]).not.toContain('fetchpriority="high"');
      expect(imgs[0]).toMatch(/\swidth="\d+"/);
      expect(imgs[0]).toMatch(/\sheight="\d+"/);
      expect(imgs[0]).toContain(`alt="${POSTER.alt![locale]}"`);
      expect(html).not.toMatch(/\sstyle=/);
      // Its own pause control (WCAG 2.2.2), named in the page's language, hidden until
      // clips.ts wires the frame where the film can play.
      const toggles = tags(html, 'button').filter((b) => b.includes('data-clip-toggle'));
      expect(toggles).toHaveLength(1);
      const pause = locale === 'en' ? 'Pause the film' : 'إيقاف الفيلم مؤقتًا';
      const playLabel = locale === 'en' ? 'Play the film' : 'تشغيل الفيلم';
      expect(toggles[0]).toContain(`aria-label="${pause}"`);
      expect(toggles[0]).toContain(`data-label-pause="${pause}"`);
      expect(toggles[0]).toContain(`data-label-play="${playLabel}"`);
      expect(toggles[0]).toContain('type="button"');
      expect(toggles[0]).toMatch(/\shidden(?:[\s>=])/);
      expect(html).toContain('data-clip-box');
    });
  }

  test('a Stream clip, which cannot play yet, leaves the still alone (EXC-009)', async () => {
    const html = await render(
      [
        {
          type: 'video',
          props: { mediaId: POSTER.id, clip: { streamUid: '0123456789abcdef0123456789abcdef' } },
        },
      ],
      'en',
    );
    expect(html).not.toContain('data-clip-src');
    expect(tags(html, 'img')).toHaveLength(1);
    // Nothing can play, so there is nothing to pause.
    expect(html).not.toContain('data-clip-toggle');
  });

  test('with no still it renders nothing, clip or not', async () => {
    const html = await render(
      [{ type: 'video', props: { clip: { path: '/media/showreel.mp4' } } }],
      'en',
    );
    expect(html).not.toContain('blk-video');
  });
});

describe('a page reads its section media once', () => {
  beforeEach(() => {
    SECTION_MEDIA_READS.length = 0;
  });

  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  test('the most media blocks a page takes, a poster and two frames: one read', async () => {
    const galleries = Array.from({ length: MEDIA_BLOCKS_PER_PAGE - 1 }, (_, g) => ({
      type: 'gallery',
      props: { items: Array.from({ length: 12 }, (_, i) => ({ mediaId: id(g * 12 + i) })) },
    }));
    const sections: SectionData[] = [
      { type: 'aboutWho', props: { mediaId: POSTER.id } },
      ...galleries,
      { type: 'video', props: { mediaId: POSTER.id, clip: { path: '/media/showreel.mp4' } } },
      { type: 'workIntro', props: { media: [{ mediaId: id(500) }, { mediaId: POSTER.id }] } },
      // A hidden section is not rendered, so its pictures are not asked for.
      { type: 'gallery', visible: false, props: { items: [{ mediaId: id(900) }] } },
      { type: 'textBlock', props: { heading: text('Words', 'كلمات') } },
    ];
    const html = await render(sections, 'en');
    expect(SECTION_MEDIA_READS).toHaveLength(1);
    const asked = SECTION_MEDIA_READS[0]!;
    // Every id once, in page order: the poster, the galleries' 84, the still (the poster
    // again, asked once), then the intro's new frame.
    expect(asked).toHaveLength(1 + 84 + 1);
    expect(asked[0]).toBe(POSTER.id);
    expect(asked.at(-1)).toBe(id(500));
    expect(asked).not.toContain(id(900));
    // Each section found its own pictures in the one answer.
    expect(html).toContain('about-who__media');
    expect(html).toContain('blk-video__frame');
    expect(html).toContain('work-intro__');
  });

  test('a page whose sections name no media asks for no id', async () => {
    await render(
      [{ type: 'textBlock', props: { heading: text('Words', 'كلمات') } }, { type: 'gallery' }],
      'en',
    );
    expect(SECTION_MEDIA_READS).toEqual([[]]);
  });

  test('a picture is never the content to supply: `images` is route data', async () => {
    const forged = new Map([[id(7), POSTER]]);
    const html = await render(
      [{ type: 'gallery', props: { items: [{ mediaId: id(7) }], data: { images: forged } } }],
      'en',
    );
    expect(tags(html, 'img')).toHaveLength(0);
  });
});

// E10 code review (docs/admin-v2/as-built/E10.md "Code review").
describe('CR3: the section media read is isolated per section', () => {
  afterEach(() => {
    SECTION_MEDIA_FAIL.on = false;
  });

  for (const locale of LOCALES) {
    test(`a failing read leaves the sections without media rendered (${locale})`, async () => {
      SECTION_MEDIA_FAIL.on = true;
      // renderSections fails on any section-error placeholder, so this also holds that the
      // media sections render empty rather than broken.
      const html = await render(
        [
          { type: 'textBlock', props: { heading: text('Still here', 'ما زال هنا') } },
          { type: 'gallery', props: { items: [{ mediaId: POSTER.id }] } },
          { type: 'video', props: { mediaId: POSTER.id, clip: { path: '/media/showreel.mp4' } } },
          { type: 'aboutWho', props: { mediaId: POSTER.id } },
        ],
        locale,
      );
      expect(html).toContain(locale === 'en' ? 'Still here' : 'ما زال هنا');
      expect(html).not.toContain('blk-gal');
      expect(html).not.toContain('blk-video');
      // About's "who we are" keeps its words, without the poster.
      expect(html).toContain('about-who--text');
      expect(tags(html, 'img')).toHaveLength(0);
    });
  }
});

describe('CR10: a Video at the top of the page is its LCP still', () => {
  const video = {
    type: 'video',
    props: { mediaId: POSTER.id, clip: { path: '/media/showreel.mp4', startS: 1, endS: 2 } },
  };

  for (const locale of LOCALES) {
    test(`the first section's still is eager and high priority, its film after load (${locale})`, async () => {
      // A hidden section above it is not on the page, so the Video is still the first.
      const html = await render(
        [{ type: 'textBlock', visible: false, props: { heading: text('x', 'س') } }, video],
        locale,
      );
      const [img] = tags(html, 'img');
      expect(img).toContain('loading="eager"');
      expect(img).toContain('fetchpriority="high"');
      const frame = tags(html, 'div').find((d) => d.includes('data-clip-src'));
      expect(frame).toContain('data-clip-after-load');
      // Still never a <video> in the HTML.
      expect(tags(html, 'video')).toHaveLength(0);
    });
  }

  test('below another section it stays lazy', async () => {
    const html = await render(
      [{ type: 'textBlock', props: { heading: text('Above', 'فوق') } }, video],
      'en',
    );
    const [img] = tags(html, 'img');
    expect(img).toContain('loading="lazy"');
    expect(img).not.toContain('fetchpriority="high"');
  });
});

describe('CR9: one picture fills the width with a wide source', () => {
  test('a one-picture Gallery asks up to 1600w; in columns it stops at 1200w', async () => {
    const html = await render(
      [
        { type: 'gallery', props: { items: [{ mediaId: POSTER.id }] } },
        { type: 'gallery', props: { items: [{ mediaId: POSTER.id }, { mediaId: POSTER.id }] } },
      ],
      'en',
    );
    const [solo, pair] = html.split('<section class="blk-gal">').slice(1);
    expect(solo).toContain(' 1600w');
    expect(pair).toContain(' 1200w');
    expect(pair).not.toContain(' 1600w');
  });
});
