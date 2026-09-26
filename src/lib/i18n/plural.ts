import type { Locale } from '@schemas/primitives';

// Plural-aware count labels.
//
// Arabic has six plural categories, and the noun changes with each: 1 مشروع (one),
// مشروعان (two), 3 مشاريع (few, 3–10), 11 مشروعًا (many, 11–99), 100 مشروع (other).
// The mockup writes "مشاريع" for every count, which is wrong for most of them. Choosing
// the form with Intl.PluralRules, instead of hand-written ranges, keeps the edge cases
// (0, 2, 100+, 102) correct.
//
// `forms` must supply `other`; every other category falls back to it, so an English
// caller supplies `{ one, other }` and nothing more.

export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

const RULES: Record<Locale, Intl.PluralRules> = {
  en: new Intl.PluralRules('en'),
  ar: new Intl.PluralRules('ar'),
};

/** The plural category for `n` in `locale` — exposed for tests and callers that branch. */
export function pluralCategory(n: number, locale: Locale): Intl.LDMLPluralRule {
  return RULES[locale].select(n);
}

/**
 * The label for `n`, with `{n}` in the chosen form replaced by the number. Digits are
 * Latin in both locales, zero-padded to two places as the mockup counts them ("08
 * projects") — pass `pad: 0` for an unpadded count.
 */
export function countLabel(
  n: number,
  forms: PluralForms,
  locale: Locale,
  options: { pad?: number } = {},
): string {
  const { pad = 2 } = options;
  const form = forms[pluralCategory(n, locale)] ?? forms.other;
  const digits = String(Math.trunc(Math.abs(n))).padStart(pad, '0');
  return form.replace('{n}', () => (n < 0 ? `-${digits}` : digits));
}
