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
