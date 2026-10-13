import type { Locale } from '@schemas/primitives';
import type { Accent } from '@schemas/media';
import { SERVICE_PAGE_COPY } from '@/lib/services/pageCopy';

// "Say hello" (Round 2) — the inquiry block closing /services and every service page. Its
// built-in copy is src/lib/sections/copy/hello.ts; this is the heading a service page passes
// in instead (its words are the service page's own, SERVICE_PAGE_COPY). Pure, so the accent
// word ranges are unit-tested.

/** A heading handed to Hello in place of its own — already in the page's language. */
export interface HelloHeading {
  text: string;
  /** Which words carry the accent (a word range per locale), e.g. the service's name. */
  accent?: Accent | undefined;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/**
 * The service page's heading: "Let's talk *Logo Design*" (S4 passes it as headingOverride).
 * v.helloH: "Let's talk <em>{s}</em>" / "خلّنا نتكلم عن <em>{s}</em>" — the accent runs from
 * the first word of the service's name to the end.
 */
export function serviceHelloHeading(service: string, locale: Locale): HelloHeading {
  const lead = SERVICE_PAGE_COPY[locale].helloLeadIn;
  const range = { from: words(lead) };
  return {
    text: `${lead} ${service.trim()}`,
    accent: locale === 'ar' ? { ar: range } : { en: range },
  };
}
