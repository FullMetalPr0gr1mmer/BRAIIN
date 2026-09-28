import type { Locale } from '@schemas/primitives';

// The inquiry forms' "What do you need?" select (Round 2), grouped by discipline:
//
//   <option value="">Not sure yet, let's talk</option>
//   <optgroup label="01 Branding">
//     <option value="discipline:branding">Branding, help me choose</option>
//     <option value="logo">Logo Design</option> …
//   </optgroup> …
//
// One value space, two lead keys: `discipline:<slug>` posts as `disciplineOfInterest`, a
// bare slug as `serviceOfInterest` (contactPayload.ts). Pure and dependency-free — the
// form's client script imports it — and unit-tested (tests/lib/contactForm.spec.ts).

/** The prefix of a "{Discipline}, help me choose" value. */
export const DISCIPLINE_PREFIX = 'discipline:';

/** What a form needs to know about a discipline — getPublishedDisciplines()'s rows satisfy it. */
export interface ServiceGroupInput {
  slug: string;
  name: { en: string; ar?: string | undefined };
  services: readonly { slug: string; title: { en: string; ar?: string | undefined } }[];
}

export interface ServiceOption {
  value: string;
  label: string;
}

export interface ServiceOptionGroup {
  /** "01 Branding" — the discipline's position, then its name. */
  label: string;
  options: ServiceOption[];
}

// The design's "help me choose", and the comma before it: Latin in English, the ARABIC
// comma "،" in Arabic (the mockup joins every language with ", ").
const HELP: Record<Locale, { sep: string; text: string }> = {
  en: { sep: ', ', text: 'help me choose' },
  ar: { sep: '، ', text: 'ساعدوني أختار' },
};

const pick = (t: { en: string; ar?: string | undefined }, locale: Locale): string =>
  (locale === 'ar' ? t.ar : t.en) || t.en;

export function serviceOptionGroups(
  groups: readonly ServiceGroupInput[],
  locale: Locale,
): ServiceOptionGroup[] {
  const help = HELP[locale];
  return groups.map((g, i) => {
    const name = pick(g.name, locale);
    return {
      label: `${String(i + 1).padStart(2, '0')} ${name}`,
      options: [
        { value: `${DISCIPLINE_PREFIX}${g.slug}`, label: `${name}${help.sep}${help.text}` },
        ...g.services.map((s) => ({ value: s.slug, label: pick(s.title, locale) })),
      ],
    };
  });
}

/** Every value the select offers (the empty "not sure" option aside). */
export function serviceOptionValues(groups: readonly ServiceOptionGroup[]): string[] {
  return groups.flatMap((g) => g.options.map((o) => o.value));
}

/**
 * The selected value to render: `selected` when the select offers it, else '' (the "not
 * sure yet" option) — a stale or unknown preselection never renders as a broken choice.
 */
export function initialServiceValue(
  groups: readonly ServiceOptionGroup[],
  selected: string | undefined,
): string {
  return selected && serviceOptionValues(groups).includes(selected) ? selected : '';
}

/** A select value → the lead key it posts under, or null for "not sure" / garbage. */
export function serviceChoice(
  value: string | null | undefined,
): { key: 'serviceOfInterest' | 'disciplineOfInterest'; slug: string } | null {
  const v = (value ?? '').trim();
  if (v === '') return null;
  if (v.startsWith(DISCIPLINE_PREFIX)) {
    const slug = v.slice(DISCIPLINE_PREFIX.length);
    return slug ? { key: 'disciplineOfInterest', slug } : null;
  }
  return { key: 'serviceOfInterest', slug: v };
}

/**
 * A `[data-preselect="discipline:<slug>"]` link was clicked ("Start your Branding
 * project"): the value to set, or null to leave the select alone. It only fills a select
 * that is still empty or holds another discipline — a visitor who already picked a
 * specific service keeps it — and only with a value the select offers.
 */
export function preselectValue(
  current: string,
  wanted: string,
  available: readonly string[],
): string | null {
  if (!available.includes(wanted) || current === wanted) return null;
  return current === '' || current.startsWith(DISCIPLINE_PREFIX) ? wanted : null;
}
