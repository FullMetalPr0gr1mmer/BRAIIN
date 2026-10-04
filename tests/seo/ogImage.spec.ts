import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OG_IMAGE,
  absoluteHttpUrl,
  ogImageCandidates,
  resolveOgImage,
} from '@/lib/seo/ogImage';

// The share image every public page names (src/lib/seo/ogImage.ts). Precedence: the SEO
// role's per-page override → the page's own image → the tenant default → the logo card.
// The defect behind the order: the tenant default used to rank above the page's own image,
// so one authored default would have replaced every poster and banner in link previews.

const BASE = 'https://www.example.test';
const en = { base: BASE, locale: 'en' as const, brand: 'Braiin Statiion' };
const ar = { base: BASE, locale: 'ar' as const, brand: 'بريّن ستيشن' };

const seo = (entityOgImage?: string, defaultOgImage?: string) => ({
  entityOgImage,
  defaultOgImage,
});

describe('precedence', () => {
  it('override → own image → tenant default → the logo card', () => {
    const all = seo('https://cdn.test/override.jpg', 'https://cdn.test/default.jpg');
    expect(resolveOgImage(ogImageCandidates(all, 'https://cdn.test/own.jpg'), en).url).toBe(
      'https://cdn.test/override.jpg',
    );
    const noOverride = seo(undefined, 'https://cdn.test/default.jpg');
    expect(resolveOgImage(ogImageCandidates(noOverride, 'https://cdn.test/own.jpg'), en).url).toBe(
      'https://cdn.test/own.jpg',
    );
    expect(resolveOgImage(ogImageCandidates(noOverride), en).url).toBe(
      'https://cdn.test/default.jpg',
    );
    expect(resolveOgImage(ogImageCandidates(seo()), en).url).toBe(`${BASE}/og/default.jpg`);
  });

  it('the tenant default never outranks a page’s own image', () => {
    const candidates = ogImageCandidates(seo(undefined, '/og/campaign.jpg'), `${BASE}/_image?x`);
    expect(candidates).toEqual([undefined, `${BASE}/_image?x`, '/og/campaign.jpg']);
    expect(resolveOgImage(candidates, en).url).toBe(`${BASE}/_image?x`);
  });

  it('skips blank, whitespace and null candidates', () => {
    expect(resolveOgImage(['', '   ', null, undefined, '/og/x.jpg'], en).url).toBe(
      `${BASE}/og/x.jpg`,
    );
    expect(resolveOgImage(ogImageCandidates(seo(' ', ''), null), en).url).toBe(
      `${BASE}/og/default.jpg`,
    );
  });

  it('a usable candidate carries no made-up size, type or alt', () => {
    expect(resolveOgImage(['https://cdn.test/own.jpg'], en)).toEqual({
      url: 'https://cdn.test/own.jpg',
    });
  });
});

describe('absoluteHttpUrl', () => {
  it('makes a site path absolute, and a protocol-relative URL https', () => {
    expect(absoluteHttpUrl('/og/x.jpg', BASE)).toBe(`${BASE}/og/x.jpg`);
    expect(absoluteHttpUrl(' /og/x.jpg ', BASE)).toBe(`${BASE}/og/x.jpg`);
    expect(absoluteHttpUrl('og/x.jpg', BASE)).toBe(`${BASE}/og/x.jpg`);
    expect(absoluteHttpUrl('//cdn.test/x.jpg', BASE)).toBe('https://cdn.test/x.jpg');
    expect(absoluteHttpUrl('https://cdn.test/a b.jpg', BASE)).toBe('https://cdn.test/a%20b.jpg');
  });

  it('works with or without a trailing slash on the base', () => {
    for (const base of [BASE, `${BASE}/`, `${BASE}//`]) {
      expect(absoluteHttpUrl('/og/x.jpg', base)).toBe(`${BASE}/og/x.jpg`);
      expect(resolveOgImage([], { ...en, base }).url).toBe(`${BASE}/og/default.jpg`);
    }
  });

  it.each([
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'ftp://cdn.test/x.jpg',
    'mailto:a@b.test',
    'https://user:pass@cdn.test/x.jpg',
    'https://user@cdn.test/x.jpg',
    'https://',
    'http://[::1',
  ])('refuses %s — it falls through to the next candidate', (value) => {
    expect(absoluteHttpUrl(value, BASE)).toBeUndefined();
    expect(resolveOgImage([value, 'https://cdn.test/next.jpg'], en).url).toBe(
      'https://cdn.test/next.jpg',
    );
  });

  it('accepts plain http (a legacy value), and blank as unset', () => {
    expect(absoluteHttpUrl('http://cdn.test/x.jpg', BASE)).toBe('http://cdn.test/x.jpg');
    expect(absoluteHttpUrl('', BASE)).toBeUndefined();
    expect(absoluteHttpUrl(null, BASE)).toBeUndefined();
    expect(absoluteHttpUrl(undefined, BASE)).toBeUndefined();
  });
});

describe('the code default — the logo card', () => {
  it('is public/og/default.jpg, 1200×630 JPEG, with a localised alt naming the brand', () => {
    expect(DEFAULT_OG_IMAGE).toEqual({
      path: '/og/default.jpg',
      width: 1200,
      height: 630,
      type: 'image/jpeg',
    });
    expect(resolveOgImage([], en)).toEqual({
      url: `${BASE}/og/default.jpg`,
      width: 1200,
      height: 630,
      type: 'image/jpeg',
      alt: 'Braiin Statiion logo',
    });
    expect(resolveOgImage([], ar).alt).toBe('شعار بريّن ستيشن');
  });
});
