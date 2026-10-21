import { z } from 'zod';

// Integrations (Admin v2 U11, docs/admin-v2/ui.md AV-20): the tools the site links to, kept in
// `site_integrations` as PUBLIC identifiers only (CLAUDE.md §7, the deviations register: no
// secret in a row staff can read). Each is a typed, CHECKed column (migration 0105, numbered
// at merge), and these patterns are the CHECKs' own: tests/lib/integrationsSql.spec.ts holds
// the two equal, so a shape can never pass one layer and fail the other.
//
//   ga4_measurement_id    a GA4 measurement id, G- and 4 to 15 capitals or digits. Stored
//                         only: loading GA4 needs a CSP change and the consent hook (U15).
//   search_console_token  the content of Google's verification meta tag, which SeoHead emits
//                         on the home pages. A pasted whole tag is read for its content.
//   calendly_url          a booking link on calendly.com itself, https, at most three path
//                         segments, no query, no fragment, at most 200 characters.
//
// No captcha field: the provider is not chosen (owner item O-19), so the screen says Not set
// up and E8 adds what the chosen provider needs (a site key here; its secret never here).

export const GA4_ID = /^G-[A-Z0-9]{4,15}$/;
export const GSC_TOKEN = /^[A-Za-z0-9_-]{10,100}$/;
export const CALENDLY_URL = /^https:\/\/calendly\.com\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+){0,2}\/?$/;
export const CALENDLY_URL_MAX = 200;

/** What a refused value is told (P-12: plain, no dashes). */
export const INTEGRATION_MESSAGES = {
  ga4: 'Use the measurement ID that starts with G-, like G-ABC123XYZ.',
  searchConsole: 'Paste the HTML tag from Search Console, or just the code inside content.',
  calendly: 'Use your Calendly link, like https://calendly.com/your-name.',
} as const;

/** A paste longer than this is no verification tag (one is about 90 characters). */
const PASTE_MAX = 2000;

const META = /^<meta\s[^<>]*>$/i;
/** One attribute of a tag, double or single quoted. */
const attribute = (tag: string, name: string): string | null => {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return match ? (match[1] ?? match[2] ?? null) : null;
};

/**
 * What a person pasted → the verification code. Search Console hands out a whole tag,
 * `<meta name="google-site-verification" content="CODE" />`: the code is its content, in
 * either attribute order and either quote. Anything else is returned trimmed, for the pattern
 * to judge (a tag of another name keeps its `<`, so it is refused).
 */
export function searchConsoleCode(paste: string): string {
  const trimmed = paste.trim();
  if (!META.test(trimmed)) return trimmed;
  if (attribute(trimmed, 'name')?.toLowerCase() !== 'google-site-verification') return trimmed;
  return attribute(trimmed, 'content')?.trim() ?? trimmed;
}

/** True for a link the Calendly CHECK accepts (and a URL parser agrees is calendly.com). */
export function isCalendlyUrl(value: string): boolean {
  if (value.length > CALENDLY_URL_MAX || !CALENDLY_URL.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'calendly.com' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

/** A blank box clears its setting: '' (or spaces) is null, as the form sends it. */
const blankIsNull = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? null : value;

export const Ga4IdSchema = z
  .string()
  .max(PASTE_MAX)
  .trim()
  .toUpperCase()
  .regex(GA4_ID, INTEGRATION_MESSAGES.ga4);

export const SearchConsoleTokenSchema = z
  .string()
  .max(PASTE_MAX, INTEGRATION_MESSAGES.searchConsole)
  .transform(searchConsoleCode)
  .pipe(z.string().regex(GSC_TOKEN, INTEGRATION_MESSAGES.searchConsole));

export const CalendlyUrlSchema = z
  .string()
  .max(PASTE_MAX)
  .trim()
  .refine(isCalendlyUrl, INTEGRATION_MESSAGES.calendly);

/**
 * PATCH /api/admin/integrations: any of the three (null clears one) and the version the
 * editor loaded (0 before the first save, H7). Strict: the legacy jsonb keys (`ga4`,
 * `searchConsole`, `calendly`, `recaptcha`) and anything else are a 422, so no free-form
 * value, and no secret, reaches the row through the admin.
 */
export const IntegrationsSchema = z
  .object({
    ga4MeasurementId: z.preprocess(blankIsNull, Ga4IdSchema.nullable()).optional(),
    searchConsoleToken: z.preprocess(blankIsNull, SearchConsoleTokenSchema.nullable()).optional(),
    calendlyUrl: z.preprocess(blankIsNull, CalendlyUrlSchema.nullable()).optional(),
    version: z.number().int().min(0),
  })
  .strict();
export type IntegrationsInput = z.infer<typeof IntegrationsSchema>;

/** The row as the admin reads it (GET /api/admin/integrations, the screen's server read). */
export interface IntegrationsRow {
  ga4_measurement_id: string | null;
  search_console_token: string | null;
  calendly_url: string | null;
  version: number;
}
