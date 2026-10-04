import type { Locale } from '@schemas/primitives';
import { brandName, type Identity } from '@/lib/identity';

// Fills the legal copy's tokens (src/lib/legal/content.ts) from the public identity —
// `site_profile`, read once per request — so the notices name whoever the Site profile
// names and send privacy requests to the address it gives (design-port J-17).
//
// ONE pass over the template with a function replacer: a value is never read as a
// replacement pattern (`$&`, `$1` in a brand stay literal) and text already inserted is
// never scanned again, so a brand or legal name that happens to contain `%mailbox%` can
// neither become a link nor pull in another value.

export interface LegalParty {
  /** The brand, in the page's language. */
  brand: string;
  /** The data controller: the registered legal name in that language, else the brand. */
  controller: string;
  /** Where privacy requests go: the site's contact address. */
  mailbox: string;
}

export function legalParty(identity: Identity, locale: Locale): LegalParty {
  const brand = brandName(identity, locale);
  return {
    brand,
    controller: identity.legalName?.[locale]?.trim() || brand,
    mailbox: identity.contactEmail,
  };
}

/** The tokens the legal copy may use — every other `%word%` is a typo, and a test says so. */
export const LEGAL_TOKENS = [
  'brand',
  'controller',
  'mailbox',
] as const satisfies readonly (keyof LegalParty)[];
const TOKEN = new RegExp(`%(${LEGAL_TOKENS.join('|')})%`, 'g');

/** The text with every token filled — for plain-text slots (the intro, the meta description). */
export function legalText(text: string, party: LegalParty): string {
  return text.replace(TOKEN, (_token, key: keyof LegalParty) => party[key]);
}

export type LegalSegment = { kind: 'text'; text: string } | { kind: 'mailbox'; address: string };

/**
 * A paragraph as runs of text and mailbox slots, so the page can render the address as a
 * `mailto:` link (LegalPage.astro) without building markup from strings — no `set:html`.
 */
export function legalSegments(text: string, party: LegalParty): LegalSegment[] {
  const segments: LegalSegment[] = [];
  let run = '';
  let from = 0;
  for (const match of text.matchAll(TOKEN)) {
    run += text.slice(from, match.index);
    from = match.index + match[0].length;
    const key = match[1] as keyof LegalParty;
    if (key !== 'mailbox') {
      run += party[key];
      continue;
    }
    if (run) segments.push({ kind: 'text', text: run });
    run = '';
    segments.push({ kind: 'mailbox', address: party.mailbox });
  }
  run += text.slice(from);
  if (run) segments.push({ kind: 'text', text: run });
  return segments;
}
