import { describe, expect, it } from 'vitest';
import {
  HeroSectionContentSchema,
  PageSectionRowSchema,
  SECTION_CONTENT_SCHEMAS,
  SocialSectionContentSchema,
} from '@schemas/sections';

// The CMS section-content boundary (page_sections.content → section props). The public
// loader (src/lib/data/pageSections.ts) safeParses content per type and degrades to {}
// on failure — these tests pin the shapes that make that degradation safe.

describe('section content schemas', () => {
  it('accepts empty content — every field is an override', () => {
    for (const [type, schema] of Object.entries(SECTION_CONTENT_SCHEMAS)) {
      expect(schema.safeParse({}).success, `${type} must accept {}`).toBe(true);
    }
  });

  it('requires BOTH languages on copy overrides (AR is first-class, Pillar 3)', () => {
    expect(HeroSectionContentSchema.safeParse({ headline: { en: 'Only English' } }).success).toBe(
      false,
    );
    expect(
      HeroSectionContentSchema.safeParse({ headline: { en: 'Both', ar: 'كلاهما' } }).success,
    ).toBe(true);
  });

  // The hero entrance stagger is an enumerated CSS ladder (10 word rungs x 14 letter
  // rungs, public/styles/global.css). These bounds are what keep it complete: past the
  // last rung the stagger flattens into a simultaneous pop and --bs-hero-lead stops
  // being a real upper bound on when the headline has arrived.
  describe('hero headline bounds — the CSS ladder has a fixed number of rungs', () => {
    const headline = (en: string, ar = en) =>
      HeroSectionContentSchema.safeParse({
        headline: { en, ar },
      });

    it('accepts a headline at the ladder limits (10 words, 14 chars per word)', () => {
      expect(headline(Array.from({ length: 10 }, () => 'word').join(' ')).success).toBe(true);
      expect(headline('a'.repeat(14)).success).toBe(true);
    });

    it('rejects an 11th word — rung 11 would fall back to the last rung', () => {
      expect(headline(Array.from({ length: 11 }, () => 'word').join(' ')).success).toBe(false);
    });

    it('rejects a 15-character word — letter rung 15 does not exist', () => {
      expect(headline('a'.repeat(15)).success).toBe(false);
    });

    it('bounds each locale independently — AR splits per word, EN per letter', () => {
      expect(headline('short', Array.from({ length: 11 }, () => 'كلمة').join(' ')).success).toBe(
        false,
      );
      expect(headline(Array.from({ length: 11 }, () => 'word').join(' '), 'قصير').success).toBe(
        false,
      );
    });

    it('counts by code point, matching the [...word] split in Hero.astro', () => {
      // 14 astral code points = 28 UTF-16 units; a .length check would reject this.
      expect(headline('😀'.repeat(14)).success).toBe(true);
      expect(headline('😀'.repeat(15)).success).toBe(false);
    });

    it('rejects a blank headline rather than rendering an empty <h1>', () => {
      expect(headline('   ').success).toBe(false);
    });
  });

  it('carries the opt-in intro flag — the plate must never default on', () => {
    expect(HeroSectionContentSchema.safeParse({ intro: true }).success).toBe(true);
    expect(HeroSectionContentSchema.safeParse({ intro: 'yes' }).success).toBe(false);
    // Absent is the safe default: Hero.astro destructures `intro = false`.
    expect(HeroSectionContentSchema.parse({}).intro).toBeUndefined();
  });

  it('rejects non-https social links — CMS-authored hrefs render into <a href>', () => {
    const link = (href: string) => ({
      links: [{ label: 'X', user: '@x', href }],
    });
    expect(SocialSectionContentSchema.safeParse(link('https://x.com/braiin')).success).toBe(true);
    expect(SocialSectionContentSchema.safeParse(link('http://x.com/braiin')).success).toBe(false);
    // eslint-disable-next-line no-script-url
    expect(SocialSectionContentSchema.safeParse(link('javascript:alert(1)')).success).toBe(false);
    expect(SocialSectionContentSchema.safeParse(link('data:text/html,x')).success).toBe(false);
  });

  it('rejects unknown-shaped rows before content validation', () => {
    expect(
      PageSectionRowSchema.safeParse({
        type: 'hero',
        content: {},
        visible: true,
        sort_order: 0,
      }).success,
    ).toBe(true);
    // component-style identifier only — a path or expression is not a section type
    expect(
      PageSectionRowSchema.safeParse({
        type: '../evil',
        content: {},
        visible: true,
        sort_order: 0,
      }).success,
    ).toBe(false);
  });

  it('caps accent indices so a stray number cannot mark thousands of words', () => {
    expect(HeroSectionContentSchema.safeParse({ accentFromEn: 31 }).success).toBe(false);
    expect(HeroSectionContentSchema.safeParse({ accentFromEn: 3 }).success).toBe(true);
  });
});
