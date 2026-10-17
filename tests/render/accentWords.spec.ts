import { describe, expect, test } from 'vitest';
import { accentWords } from '@/lib/admin/accentWords';
import { renderSections } from './harness';

// The one accent tokeniser (Admin v2 F5b review L7). The hero and the slogan band colour
// "from word N" per word span; the admin's accent field picks N by counting the words of
// src/lib/text/accent.ts. These hold the page to the same count, on a text whose leading
// and doubled spaces made a raw split(/\s+/) count an empty first word. The byte snapshots
// in sections.spec.ts are the guard that no seeded or built-in section changed.

const t = (en: string, ar: string) => ({ en, ar });
const ODD = '  Ideas  that leave ';

/** The text of each word span, and whether it carries the accent class. */
function spans(html: string, word: RegExp): { text: string; accent: boolean }[] {
  return [...html.matchAll(word)].map((m) => ({
    text: (m[2] ?? '').replace(/<[^>]*>/g, '').trim(),
    accent: /\bac\b|accent/.test(m[1] ?? ''),
  }));
}

describe('the page counts the words the accent field counts', () => {
  test('slogan: no empty word for a leading space, and word 2 is the second word', async () => {
    const html = await renderSections(
      [{ type: 'slogan', props: { text: t(ODD, 'أفكار تغادر'), accentFromEn: 1 } }],
      'en',
    );
    const words = spans(html, /<span class="([^"]*\bsw\b[^"]*)"[^>]*>([\s\S]*?)<\/span>/g);
    expect(words.map((w) => w.text)).toEqual(accentWords(ODD));
    expect(words.filter((w) => w.accent).map((w) => w.text)).toEqual(['that', 'leave']);
  });

  test('hero: the headline words are the same words, in Arabic one span each', async () => {
    const odd = '  أفكار  تغادر العقل ';
    const html = await renderSections(
      [{ type: 'hero', props: { headline: t('Ideas', odd), accentFromAr: 1 } }],
      'ar',
    );
    const words = spans(
      html,
      /<span class="(word[^"]*)"[^>]*>\s*<span class="letter">([^<]*)<\/span>/g,
    );
    expect(words.map((w) => w.text)).toEqual(accentWords(odd));
    expect(words.filter((w) => w.accent).map((w) => w.text)).toEqual(['تغادر', 'العقل']);
  });
});
