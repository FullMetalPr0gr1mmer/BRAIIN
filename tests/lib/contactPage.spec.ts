import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTACT_SECTIONS,
  HERO_PRESETS,
  ensureContactInquiry,
  withHeroPreset,
  type SectionData,
} from '@/lib/sections/types';
import { CONTACT_CACHE_ENTITIES, faqShown, withContactData } from '@/lib/sections/contact';
import { whatsappChannel } from '@/lib/identity/channels';
import { CONTACT_FAQ } from '@/lib/content/contactFaq';
import { tierATags } from '@/lib/http/cacheTags';
import {
  ContactChannelsSectionContentSchema,
  ContactInquirySectionContentSchema,
  FaqSectionContentSchema,
  HeroSectionContentSchema,
  SECTION_CONTENT_SCHEMAS,
  type SectionType,
} from '@schemas/sections';
import { loadBlocks } from '../../scripts/gen-seeds.mjs';

// The contact page (UI v2 PR9). Before it, /contact rendered the HOME hero copy ("Creative
// work that performs*", "See our work"), had no <main>, and ignored its CMS composition.

const contactPreset = HERO_PRESETS.contact;

describe('withHeroPreset: the contact hero is the contact banner', () => {
  it('gives an empty hero the design’s contact copy and the banner layout', () => {
    const [hero] = withHeroPreset([{ type: 'hero' }], 'contact');
    expect(hero!.props).toEqual(contactPreset.content);
    expect(hero!.data).toEqual({
      banner: true,
      ctaHref: '#inquiry',
      clip: { start: 6.2, end: 7.9 },
    });
    expect(hero!.props!['headline']).toEqual({ en: "Let's make it happen", ar: 'خلّنا نحقّقها' });
    expect(hero!.props!['ctaLabel']).toEqual({ en: 'Start your project', ar: 'ابدأ مشروعك' });
  });

  it('the preset copy is valid hero content (headline shape, accent indices)', () => {
    const parsed = HeroSectionContentSchema.safeParse(contactPreset.content);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    // The accent lands on "happen" / "نحقّقها" — the design's <em>.
    expect(contactPreset.content.headline.en.split(' ')[contactPreset.content.accentFromEn]).toBe(
      'happen',
    );
    expect(contactPreset.content.headline.ar.split(' ')[contactPreset.content.accentFromAr]).toBe(
      'نحقّقها',
    );
  });

  it('lets authored CMS copy win, field by field', () => {
    const sub = { en: 'Authored sub', ar: 'سطر مكتوب' };
    const [hero] = withHeroPreset([{ type: 'hero', props: { sub } }], 'contact');
    expect(hero!.props!['sub']).toEqual(sub);
    expect(hero!.props!['headline']).toEqual(contactPreset.content.headline);
  });

  it('never applies the preset accent to an authored headline', () => {
    const headline = { en: 'Say hello to the studio today', ar: 'قل مرحبا للاستوديو اليوم' };
    const [hero] = withHeroPreset([{ type: 'hero', props: { headline } }], 'contact');
    expect(hero!.props!['headline']).toEqual(headline);
    expect(hero!.props).not.toHaveProperty('accentFromEn');
    expect(hero!.props).not.toHaveProperty('accentFromAr');
    // ...but an accent authored WITH the headline is kept.
    const [withAccent] = withHeroPreset(
      [{ type: 'hero', props: { headline, accentFromEn: 4 } }],
      'contact',
    );
    expect(withAccent!.props!['accentFromEn']).toBe(4);
  });

  it('puts the layout in route data, which authored content cannot replace', () => {
    // SectionRenderer passes `data` after the content spread; a CMS row cannot switch the
    // banner off or repoint the button (and HeroSectionContentSchema strips such keys).
    const [hero] = withHeroPreset(
      [{ type: 'hero', props: { ctaHref: '/elsewhere', banner: false } }],
      'contact',
    );
    expect(hero!.data).toMatchObject({ banner: true, ctaHref: '#inquiry' });
  });

  it('touches only the first hero and nothing else', () => {
    const out = withHeroPreset(
      [{ type: 'contactInquiry' }, { type: 'hero' }, { type: 'hero' }],
      'contact',
    );
    expect(out[0]).toEqual({ type: 'contactInquiry' });
    expect(out[1]!.data).toBeDefined();
    expect(out[2]).toEqual({ type: 'hero' });
    expect(withHeroPreset([{ type: 'faq' }], 'contact')).toEqual([{ type: 'faq' }]);
  });

  it('does not mutate the shared defaults', () => {
    const before = JSON.stringify(DEFAULT_CONTACT_SECTIONS);
    withHeroPreset(DEFAULT_CONTACT_SECTIONS, 'contact');
    expect(JSON.stringify(DEFAULT_CONTACT_SECTIONS)).toBe(before);
  });
});

describe('the contact composition', () => {
  const ORDER = ['hero', 'contactInquiry', 'contactChannels', 'faq'];

  it('is the design order: banner hero, inquiry, channels, FAQ', () => {
    expect(DEFAULT_CONTACT_SECTIONS.map((s) => s.type)).toEqual(ORDER);
  });

  it('the seeded contact composition is the default one (dev/CI/staging render what code would)', () => {
    type Row = { type: string; content: Record<string, unknown>; sort_order: number };
    const rows = (loadBlocks() as unknown as { table: string; rows: Row[] }[])
      .filter((b) => b.table === 'page_sections')
      .flatMap((b) => b.rows)
      .filter((r) => JSON.stringify(r).includes('"slug":"contact"'))
      .sort((a, b) => a.sort_order - b.sort_order);
    expect(rows.map((r) => r.type)).toEqual(ORDER);
    for (const [i, row] of rows.entries()) {
      expect(row.content, row.type).toEqual(DEFAULT_CONTACT_SECTIONS[i]!.props ?? {});
      const schema = SECTION_CONTENT_SCHEMAS[row.type as SectionType];
      expect(schema?.safeParse(row.content).success ?? true, row.type).toBe(true);
    }
  });

  it('keeps the form whatever the CMS says, with the hero preset applied', () => {
    const authored: SectionData[] = [
      { type: 'hero' },
      { type: 'contactInquiry', visible: false },
      { type: 'faq' },
    ];
    const out = ensureContactInquiry(withHeroPreset(authored, 'contact'));
    expect(out.find((s) => s.type === 'contactInquiry')!.visible).toBe(true);
    expect(out[0]!.data).toMatchObject({ banner: true });
  });

  it('hands the services to the inquiry band as route data, never as content', () => {
    const services = [{ slug: 'branding' }];
    const out = withContactData(
      [{ type: 'hero' }, { type: 'contactInquiry', props: { services: ['forged'] } }],
      { services },
    );
    expect(out[0]).toEqual({ type: 'hero' });
    expect(out[1]!.data).toEqual({ services });
    expect(out[1]!.props).toEqual({ services: ['forged'] });
  });

  it('emits the FAQ JSON-LD only while the FAQ band renders', () => {
    expect(faqShown(DEFAULT_CONTACT_SECTIONS)).toBe(true);
    expect(faqShown([{ type: 'faq', visible: false }])).toBe(false);
    expect(faqShown([{ type: 'hero' }, { type: 'contactInquiry' }])).toBe(false);
  });

  it('its cache tags cover the composition and the services, within the purge limit', () => {
    const tags = tierATags({ route: 'contact', locale: 'ar', entities: CONTACT_CACHE_ENTITIES });
    expect(tags).toEqual(
      expect.arrayContaining(['route:contact', 'page:contact', 'services:all', 'site:identity']),
    );
    expect(tags.length).toBeLessThanOrEqual(30);
  });
});

describe('contact section content (CMS overrides)', () => {
  const pair = { en: 'Two words', ar: 'كلمتان هنا' };

  it('accepts every copy override', () => {
    expect(
      ContactInquirySectionContentSchema.safeParse({
        tag: pair,
        heading: pair,
        accent: { en: { from: 1 }, ar: { from: 1 } },
        lead: pair,
        note: pair,
        successMessage: pair,
        submitLabel: pair,
      }).success,
    ).toBe(true);
    expect(
      ContactChannelsSectionContentSchema.safeParse({
        tag: pair,
        heading: pair,
        lead: pair,
        emailLabel: pair,
        emailNote: pair,
        whatsappLabel: pair,
        whatsappNote: pair,
      }).success,
    ).toBe(true);
    expect(FaqSectionContentSchema.safeParse({ tag: pair, heading: pair }).success).toBe(true);
  });

  it('refuses keys that belong to code or the identity (strict)', () => {
    // The FAQ items are also the JSON-LD; the address and number are the identity; the
    // services are route data.
    expect(FaqSectionContentSchema.safeParse({ items: [] }).success).toBe(false);
    expect(ContactChannelsSectionContentSchema.safeParse({ email: 'x@y.z' }).success).toBe(false);
    expect(ContactInquirySectionContentSchema.safeParse({ services: [] }).success).toBe(false);
  });

  it('requires both languages (indexable copy)', () => {
    expect(FaqSectionContentSchema.safeParse({ heading: { en: 'Only English' } }).success).toBe(
      false,
    );
  });
});

describe('whatsappChannel: the card exists only for a real number', () => {
  it('hides for no number, the design’s placeholder, or a malformed value', () => {
    expect(whatsappChannel({ whatsappE164: null, whatsappDisplay: null })).toBeNull();
    expect(whatsappChannel({ whatsappE164: '+9665XXXXXXXX', whatsappDisplay: null })).toBeNull();
    expect(whatsappChannel({ whatsappE164: '966500000000', whatsappDisplay: null })).toBeNull();
    expect(whatsappChannel({ whatsappE164: '', whatsappDisplay: '+966 5X XXX XXXX' })).toBeNull();
  });

  it('links wa.me with the digits and shows the authored display form', () => {
    expect(
      whatsappChannel({ whatsappE164: '+966501234567', whatsappDisplay: '+966 50 123 4567' }),
    ).toEqual({ href: 'https://wa.me/966501234567', display: '+966 50 123 4567' });
    expect(whatsappChannel({ whatsappE164: '+966501234567', whatsappDisplay: '  ' })).toEqual({
      href: 'https://wa.me/966501234567',
      display: '+966501234567',
    });
  });
});

describe('the contact FAQ (one source for the list and its JSON-LD)', () => {
  it('has the design’s ten questions in each language', () => {
    expect(CONTACT_FAQ.en).toHaveLength(10);
    expect(CONTACT_FAQ.ar).toHaveLength(10);
    for (const item of [...CONTACT_FAQ.en, ...CONTACT_FAQ.ar]) {
      expect(item.q.trim()).not.toBe('');
      expect(item.a.trim()).not.toBe('');
    }
  });

  it('the Arabic is the design’s Saudi-voice copy, verbatim', () => {
    expect(CONTACT_FAQ.ar[0]!.q).toBe('وش تشمل الهوية البصرية الكاملة؟');
    expect(CONTACT_FAQ.ar[9]!.a).toBe(
      'أرسل النموذج فوق أو راسلنا مباشرة. يوصلك رد خلال يوم عمل واحد فيه أسئلتنا، ونطاق سعري مبدئي، وموعد للمكالمة.',
    );
  });
});

describe('contact styles: the standard’s invariants', () => {
  const css = readFileSync(join(process.cwd(), 'public/styles/global.css'), 'utf8');
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    return at === -1 ? '' : css.slice(at, css.indexOf('}', at));
  };

  it('the FAQ is the design’s dark band (its sky accents failed on white)', () => {
    expect(block('.faq-section')).toContain('background: var(--bs-black)');
  });

  it('the FAQ reveal animates no layout property', () => {
    expect(css).not.toMatch(/faq-item__a[^{]*\{[^}]*grid-template-rows/);
    expect(css).not.toMatch(/faq-item__a[^{]*\{[^}]*transition:[^;]*height/);
  });

  it('the FAQ answer entrance is in the reduced-motion invariant', () => {
    const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.faq-item[open] .faq-item__a p');
  });
});
