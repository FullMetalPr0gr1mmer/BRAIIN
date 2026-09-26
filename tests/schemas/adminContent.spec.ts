import { describe, it, expect } from 'vitest';
import {
  ClientWriteSchema,
  MediaWriteSchema,
  PortfolioMediaItemSchema,
  PortfolioUpdateSchema,
  PortfolioWriteSchema,
  StatisticUpdateSchema,
  StatisticWriteSchema,
  TeamMemberWriteSchema,
  TestimonialUpdateSchema,
  TestimonialWriteSchema,
} from '@schemas/admin';

// The UI v2 admin write schemas mirror the 0020–0023 CHECK constraints, so an editor is
// told what is wrong on the field instead of receiving a raw 23514 from the database.

const t = (en: string) => ({ en, ar: `ع-${en}` });
const UUID = '11111111-1111-4111-8111-111111111111';

describe('portfolio', () => {
  const base = { slug: 'the-rider', title: t('The Rider') };

  it('reserves the slug "all" (the All projects route)', () => {
    expect(PortfolioWriteSchema.safeParse({ ...base, slug: 'all' }).success).toBe(false);
    expect(PortfolioWriteSchema.safeParse(base).success).toBe(true);
  });

  it('bounds keywords, scope and result cards like the database', () => {
    const many = (k: number) => Array.from({ length: k }, () => t('x'));
    expect(PortfolioWriteSchema.safeParse({ ...base, keywords: many(7) }).success).toBe(false);
    expect(PortfolioWriteSchema.safeParse({ ...base, scope: many(11) }).success).toBe(false);
    const cards = Array.from({ length: 5 }, () => ({ value: '1', label: t('x') }));
    expect(PortfolioWriteSchema.safeParse({ ...base, results: cards }).success).toBe(false);
  });

  it('validates the preview clip (one source, window ≤ 30 s)', () => {
    const ok = { path: '/media/showreel.mp4', startS: 1, endS: 3.7 };
    expect(PortfolioWriteSchema.safeParse({ ...base, preview: ok }).success).toBe(true);
    expect(PortfolioWriteSchema.safeParse({ ...base, preview: { ...ok, endS: 40 } }).success).toBe(
      false,
    );
    expect(
      PortfolioWriteSchema.safeParse({ ...base, preview: { path: 'https://x/y.mp4' } }).success,
    ).toBe(false);
  });

  it('allows at most one hero and one final film', () => {
    const hero = { role: 'hero', kind: 'video', clip: { path: '/media/showreel.mp4' } };
    expect(PortfolioWriteSchema.safeParse({ ...base, media: [hero, hero] }).success).toBe(false);
    expect(PortfolioUpdateSchema.safeParse({ version: 1, media: [hero, hero] }).success).toBe(
      false,
    );
    expect(PortfolioWriteSchema.safeParse({ ...base, media: [hero] }).success).toBe(true);
  });

  it('a media item has the shape its role and kind need', () => {
    const ok = PortfolioMediaItemSchema.safeParse({
      role: 'breakdown',
      kind: 'image',
      mediaId: UUID,
      breakdownKind: 'sketch',
      layout: 'half',
    });
    expect(ok.success).toBe(true);
    // breakdown without a kind; gallery with one; image without media; video without clip
    for (const bad of [
      { role: 'breakdown', kind: 'image', mediaId: UUID },
      { role: 'gallery', kind: 'image', mediaId: UUID, breakdownKind: 'bts' },
      { role: 'gallery', kind: 'image' },
      { role: 'final', kind: 'video', mediaId: UUID },
      { role: 'final', kind: 'video', clip: { path: '/media/a.mp4' }, durationLabel: '1:75' },
    ]) {
      expect(PortfolioMediaItemSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('statistics', () => {
  const base = { slug: 'brands', label: t('Brands') };

  it('needs a display value or a number to count up to', () => {
    expect(StatisticWriteSchema.safeParse(base).success).toBe(false);
    expect(StatisticWriteSchema.safeParse({ ...base, value: '80+' }).success).toBe(true);
    expect(
      StatisticWriteSchema.safeParse({ ...base, valueNumeric: 80, valueSuffix: '+' }).success,
    ).toBe(true);
  });

  it('takes each page once, and bilingual per-page labels for known pages only', () => {
    expect(
      StatisticWriteSchema.safeParse({ ...base, value: '1', placements: ['home', 'home'] }).success,
    ).toBe(false);
    expect(
      StatisticUpdateSchema.safeParse({ version: 1, placementLabels: { blog: t('x') } }).success,
    ).toBe(false);
    expect(
      StatisticUpdateSchema.safeParse({ version: 1, placementLabels: { about: { en: 'x' } } })
        .success,
    ).toBe(false);
  });
});

describe('team, clients, testimonials, media', () => {
  it('a LinkedIn URL is a linkedin.com /in/ or /company/ page over https', () => {
    const base = { slug: 'leader-1', name: t('Name') };
    expect(
      TeamMemberWriteSchema.safeParse({ ...base, linkedinUrl: 'https://www.linkedin.com/in/abc' })
        .success,
    ).toBe(true);
    for (const url of [
      'http://linkedin.com/in/abc',
      'https://evil.example/in/abc',
      'javascript:x',
    ]) {
      expect(TeamMemberWriteSchema.safeParse({ ...base, linkedinUrl: url }).success, url).toBe(
        false,
      );
    }
  });

  it('a new client is hidden until someone confirms it may be named', () => {
    const parsed = ClientWriteSchema.parse({ slug: 'neom', name: t('NEOM') });
    expect(parsed.visible).toBe(false);
  });

  it('a quote cannot be published or scheduled without its consent date', () => {
    const base = { slug: 'q', quote: t('Great'), authorName: t('Name') };
    expect(TestimonialWriteSchema.safeParse({ ...base, status: 'published' }).success).toBe(false);
    expect(TestimonialWriteSchema.safeParse({ ...base, status: 'scheduled' }).success).toBe(false);
    expect(
      TestimonialWriteSchema.safeParse({
        ...base,
        status: 'published',
        consentObtainedAt: '2026-09-01T00:00:00Z',
      }).success,
    ).toBe(true);
    expect(TestimonialWriteSchema.safeParse(base).success).toBe(true); // a draft may wait
    // update: an explicit null clears consent → refused; an omitted key keeps the stored one
    expect(
      TestimonialUpdateSchema.safeParse({
        version: 1,
        status: 'published',
        consentObtainedAt: null,
      }).success,
    ).toBe(false);
    expect(TestimonialUpdateSchema.safeParse({ version: 1, status: 'published' }).success).toBe(
      true,
    );
  });

  it('a static media row names a stills/ key; Cloudflare Images rows are not typed in', () => {
    const base = { kind: 'image', provider: 'static' };
    expect(MediaWriteSchema.safeParse({ ...base, storagePath: 'stills/work/p0.jpg' }).success).toBe(
      true,
    );
    for (const path of ['../etc/passwd', 'stills/../x.jpg', '/stills/a.jpg', 'https://x/a.jpg']) {
      expect(MediaWriteSchema.safeParse({ ...base, storagePath: path }).success, path).toBe(false);
    }
    expect(
      MediaWriteSchema.safeParse({ kind: 'image', provider: 'cf_images', storagePath: 'x' })
        .success,
    ).toBe(false);
  });
});
