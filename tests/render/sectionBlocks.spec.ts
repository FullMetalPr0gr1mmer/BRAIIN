import { describe, expect, test } from 'vitest';
import type { Locale } from '@schemas/primitives';
import type { SectionData } from '@/lib/sections/types';
import { POSTER } from './fixtures';
import { LOCALES, renderSections } from './harness';

// Admin v2 E10's blocks as a visitor's browser receives them, in both languages: what the
// standard asks of each, read off the served markup (the snapshots in sections.spec.ts hold
// the bytes; this holds the rules).
//
//   Text block  the body is the allowlist renderer's output and nothing else: no script, no
//               style attribute, no image, no unsafe link, even for a document that reached
//               the component without passing the write schema;
//   Gallery     a lazy, sized <img> per picture with the library's alt in the page's language;
//   Video       no <video> in the HTML (clips.ts creates it in view): the still is lazy and
//               sized, the frame an in-view clip surface of a /media file, never after-load.

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

  test('a hostile document that skipped the write schema still renders safe markup', async () => {
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
      [{ type: 'textBlock', props: { body: { en: hostile, ar: hostile } } }],
      'en',
    );
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toMatch(/javascript:|evil\.example|data:image/);
    expect(tags(html, 'img')).toHaveLength(0);
    expect(tags(html, 'iframe')).toHaveLength(0);
    expect(tags(html, 'h1')).toHaveLength(0);
    expect(html).not.toMatch(/\sstyle=/);
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
