import { describe, expect, test } from 'vitest';
import { SECTION_CONTENT_SCHEMAS } from '@schemas/sections';
import type { StatisticRow } from '@schemas/content';
import type { SectionData } from '@/lib/sections/types';
import { STATS } from './fixtures';
import { renderSections } from './harness';

// Arabic content digits reach the page as typed (P-12; Admin v2 F5a). Two sections an
// author writes figures into, rendered through SectionRenderer (the path a page takes) in
// Arabic: a statistics band (its heading, line and rating, and a counter's own label and
// free-text value) and the hero, whose headline is split per word and per letter. The
// layers before the page are tests/lib/arabicDigits.spec.ts.

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩'; // U+0660-0669
const EXTENDED = '۰۱۲۳۴۵۶۷۸۹'; // U+06F0-06F9
const t = (en: string, ar: string) => ({ en, ar });

/** The page's text: tags dropped, entities read, whitespace gone (the hero splits words). */
const visibleText = (html: string) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, '');

/** No digit of either Arabic set was turned into another character. */
function expectDigitsKept(html: string, ...expected: string[]) {
  for (const text of expected) expect(html, text).toContain(text);
  for (const digit of [...ARABIC_INDIC, ...EXTENDED]) expect(html).toContain(digit);
}

describe('Arabic digits render byte for byte', () => {
  test('a statistics band: heading, statement, rating, a counter’s label and value', async () => {
    const content = {
      variant: 'services' as const,
      placement: 'services' as const,
      heading: t('Numbers 0123456789', `أرقام ${ARABIC_INDIC}`),
      line: t('A line 0123456789.', `سطر ${EXTENDED}.`),
      rating: { value: '٤٫٩ / ٥', label: t('rating', `تقييم ${ARABIC_INDIC.slice(0, 3)}`) },
      staticNumbers: true,
      minItems: 1,
    };
    // What the author saved is what the schema keeps (the write side), then rendered.
    const props = SECTION_CONTENT_SCHEMAS.statistics!.parse(content) as Record<string, unknown>;
    const stat: StatisticRow = {
      ...STATS[2]!,
      value: `${EXTENDED}+`,
      value_numeric: null,
      label: t('Years', `سنوات ${ARABIC_INDIC}`),
    };
    const sections: SectionData[] = [{ type: 'statistics', props, data: { items: [stat] } }];
    const html = await renderSections(sections, 'ar');
    expectDigitsKept(html, `سطر ${EXTENDED}.`, '٤٫٩ / ٥', `${EXTENDED}+`, `سنوات ${ARABIC_INDIC}`);
  });

  test('the hero: a headline split per word and per letter keeps every digit, in order', async () => {
    const headline = t('Figures 0123456789', `الأرقام ${ARABIC_INDIC} ${EXTENDED}`);
    const props = SECTION_CONTENT_SCHEMAS.hero!.parse({
      headline,
      sub: t('Sub 0123456789', `نص ${ARABIC_INDIC}`),
      accentFromAr: 1,
    }) as Record<string, unknown>;
    const html = await renderSections([{ type: 'hero', props }], 'ar');
    expect(visibleText(html)).toContain(headline.ar.replace(/\s+/g, ''));
    expectDigitsKept(html, `نص ${ARABIC_INDIC}`);
  });
});
