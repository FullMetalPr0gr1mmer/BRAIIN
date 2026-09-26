import { describe, expect, it } from 'vitest';
import {
  HeroSectionContentSchema,
  PageSectionRowSchema,
  SECTION_CONTENT_SCHEMAS,
  SocialSectionContentSchema,
  sectionContentIssues,
} from '@schemas/sections';
import { SectionUpdateSchema, SectionWriteSchema } from '@schemas/admin';

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

describe('write-time section validation (UI v2 PR1)', () => {
  const pageId = '00000000-0000-4000-8000-000000000001';

  it('rejects a type the renderer does not know — it used to save and silently not render', () => {
    expect(SectionWriteSchema.safeParse({ pageId, type: 'carousel' }).success).toBe(false);
    expect(SectionWriteSchema.safeParse({ pageId, type: 'hero' }).success).toBe(true);
  });

  it('validates content against its type, with content-rooted issue paths', () => {
    const bad = SectionWriteSchema.safeParse({
      pageId,
      type: 'hero',
      content: { headline: { en: 'Only English' } },
    });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0]?.path[0]).toBe('content');
  });

  it('table-backed types take NO content — a stray key would overwrite their data', () => {
    for (const type of ['team', 'certifications'] as const) {
      expect(sectionContentIssues(type, {})).toEqual([]);
      expect(sectionContentIssues(type, { members: [] }).length, type).toBe(1);
    }
  });

  it('statistics takes layout and copy, never data: a stray key is refused', () => {
    expect(sectionContentIssues('statistics', {})).toEqual([]);
    expect(
      sectionContentIssues('statistics', { variant: 'band', placement: 'home', minItems: 3 }),
    ).toEqual([]);
    expect(sectionContentIssues('statistics', { items: [] }).length).toBeGreaterThan(0);
    expect(sectionContentIssues('statistics', { variant: 'grid' }).length).toBeGreaterThan(0);
  });

  it('selectedWork takes copy and picks, never projects: a stray key is refused (UI v2 PR7)', () => {
    expect(sectionContentIssues('selectedWork', {})).toEqual([]);
    expect(
      sectionContentIssues('selectedWork', {
        featuredSlug: 'the-rider',
        cardSlugs: ['kitchen-hours', 'notebook'],
        lines: [{ text: { en: 'One', ar: 'واحد' } }],
        button: { label: { en: 'All', ar: 'الكل' }, href: '/portfolio' },
        accent: { en: { from: 2, to: 5 }, ar: { from: 1, to: 4 } },
      }),
    ).toEqual([]);
    expect(sectionContentIssues('selectedWork', { cards: [] }).length).toBeGreaterThan(0);
    // Three cards do not fit the design's two-up grid; four lines do not fit its list.
    expect(
      sectionContentIssues('selectedWork', { cardSlugs: ['a', 'b', 'c'] }).length,
    ).toBeGreaterThan(0);
    const line = { text: { en: 'x', ar: 'س' } };
    expect(
      sectionContentIssues('selectedWork', { lines: [line, line, line, line] }).length,
    ).toBeGreaterThan(0);
    // The button is an authored href: an anchor or a site path, never another origin.
    for (const href of ['https://evil.example', '//evil.example', 'javascript:alert(1)']) {
      expect(sectionContentIssues('selectedWork', { button: { href } }).length, href).toBe(1);
    }
  });

  it('testimonials takes layout and copy, bounded; quotes come from their table', () => {
    expect(sectionContentIssues('testimonials', {})).toEqual([]);
    expect(
      sectionContentIssues('testimonials', {
        variant: 'klein',
        placement: 'home',
        intervalMs: 7000,
        limit: 3,
      }),
    ).toEqual([]);
    expect(sectionContentIssues('testimonials', { items: [] }).length).toBeGreaterThan(0);
    expect(sectionContentIssues('testimonials', { intervalMs: 1000 }).length).toBe(1);
    expect(sectionContentIssues('testimonials', { limit: 9 }).length).toBe(1);
    expect(sectionContentIssues('testimonials', { placement: 'about' }).length).toBe(1);
  });

  it('an update restating the type is validated; one without it is left to the kernel', () => {
    expect(
      SectionUpdateSchema.safeParse({ version: 2, type: 'hero', content: { sub: { en: 'x' } } })
        .success,
    ).toBe(false);
    expect(SectionUpdateSchema.safeParse({ version: 2, content: { anything: true } }).success).toBe(
      true,
    );
  });

  it('no longer accepts `style` (never read, and unusable under the nonce CSP)', () => {
    const parsed = SectionWriteSchema.parse({ pageId, type: 'hero', style: { color: 'red' } });
    expect('style' in parsed).toBe(false);
  });
});
