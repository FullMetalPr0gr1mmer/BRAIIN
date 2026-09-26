import { describe, it, expect } from 'vitest';
import {
  AccentSchema,
  SafeHrefSchema,
  StaticMediaKeySchema,
  VideoClipSchema,
  MAX_CLIP_SECONDS,
} from '@schemas/media';

describe('SafeHrefSchema — CMS-authored button/CTA links', () => {
  it.each([
    '#inquiry',
    '#selected-work',
    '/',
    '/contact',
    '/contact#inquiry',
    '/portfolio/all',
    '/ar/join',
  ])('accepts %s', (href) => expect(SafeHrefSchema.safeParse(href).success).toBe(true));
  it.each([
    '//evil.example', // scheme-relative: an off-site link that looks relative
    'https://evil.example',
    'javascript:alert(1)',
    '/x?y=1', // no query strings from the CMS
    '#Inquiry', // anchors are lowercase ids
    'contact',
    '/../etc',
  ])('rejects %s', (href) => expect(SafeHrefSchema.safeParse(href).success).toBe(false));
});

describe('VideoClipSchema', () => {
  const uid = 'a'.repeat(32);
  it('accepts a Stream uid, or a /media mp4, with an optional window', () => {
    expect(VideoClipSchema.safeParse({ streamUid: uid }).success).toBe(true);
    expect(
      VideoClipSchema.safeParse({ path: '/media/showreel.mp4', startS: 6.2, endS: 7.9 }).success,
    ).toBe(true);
  });
  it('requires exactly one source', () => {
    expect(VideoClipSchema.safeParse({}).success).toBe(false);
    expect(VideoClipSchema.safeParse({ streamUid: uid, path: '/media/a.mp4' }).success).toBe(false);
  });
  it('fences the self-hosted path to /media/*.mp4 (the EXC-009 boundary)', () => {
    for (const path of [
      '/media/../secret.mp4',
      '/other/a.mp4',
      'https://x/a.mp4',
      '/media/a.webm',
      '/media/A.mp4',
    ]) {
      expect(VideoClipSchema.safeParse({ path }).success, path).toBe(false);
    }
  });
  it('windows: both or neither, end after start, bounded length', () => {
    const p = '/media/showreel.mp4';
    expect(VideoClipSchema.safeParse({ path: p, startS: 1 }).success).toBe(false);
    expect(VideoClipSchema.safeParse({ path: p, startS: 5, endS: 5 }).success).toBe(false);
    expect(VideoClipSchema.safeParse({ path: p, startS: 0, endS: MAX_CLIP_SECONDS }).success).toBe(
      true,
    );
    expect(
      VideoClipSchema.safeParse({ path: p, startS: 0, endS: MAX_CLIP_SECONDS + 0.1 }).success,
    ).toBe(false);
  });
});

describe('StaticMediaKeySchema — build-time stills registry keys', () => {
  it('accepts stills/ keys', () => {
    expect(StaticMediaKeySchema.safeParse('stills/work/p0.jpg').success).toBe(true);
    expect(StaticMediaKeySchema.safeParse('stills/project/g01.webp').success).toBe(true);
  });
  it.each([
    'stills/../x.jpg',
    '/stills/a.jpg',
    'stills/A.jpg',
    'other/a.jpg',
    'stills/a.svg',
    'stills/a.jpg.exe',
  ])('rejects %s', (key) => expect(StaticMediaKeySchema.safeParse(key).success).toBe(false));
});

describe('AccentSchema — word ranges, so an accent can sit mid-line', () => {
  it('accepts a mid-line range and an open-ended one', () => {
    expect(AccentSchema.safeParse({ en: { from: 2, to: 5 }, ar: { from: 1 } }).success).toBe(true);
  });
  it('rejects an empty or inverted range', () => {
    expect(AccentSchema.safeParse({ en: { from: 3, to: 3 } }).success).toBe(false);
    expect(AccentSchema.safeParse({ en: { from: 4, to: 2 } }).success).toBe(false);
  });
});
