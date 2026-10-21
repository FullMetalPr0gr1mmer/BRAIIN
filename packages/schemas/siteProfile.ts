import { z } from 'zod';
import { LocalizedTextSchema } from './content';

// The public identity singleton (`public.site_profile`, migration 0019): brand, contact
// channels, location and social handles — everything that renders on every public page.
// Admin + Developer write (§5 "General settings"), everyone reads. `acceptingApplications`
// is narrower: Admin only, enforced by a DB trigger (0019) and surfaced as 403.

export const SOCIAL_NETWORKS = [
  'instagram',
  'linkedin',
  'behance',
  'youtube',
  'x',
  'tiktok',
  'snapchat',
  'facebook',
] as const;
export const SocialNetworkSchema = z.enum(SOCIAL_NETWORKS);
export type SocialNetwork = z.infer<typeof SocialNetworkSchema>;

/**
 * Host allow-list per network. A social link is CMS-authored and rendered into an <a>
 * on every page, so "any https URL" would let an editor (or a stolen editor session)
 * point the brand's Instagram icon anywhere. Each network may only link to itself.
 */
const SOCIAL_HOSTS: Record<SocialNetwork, RegExp> = {
  instagram: /^(www\.)?instagram\.com$/,
  linkedin: /^(www\.)?linkedin\.com$/,
  behance: /^(www\.)?behance\.net$/,
  youtube: /^(www\.)?youtube\.com$/,
  x: /^(www\.)?(x|twitter)\.com$/,
  tiktok: /^(www\.)?tiktok\.com$/,
  snapchat: /^(www\.)?snapchat\.com$/,
  facebook: /^(www\.)?facebook\.com$/,
};

export const SocialLinkSchema = z
  .object({
    network: SocialNetworkSchema,
    /** Display handle, e.g. "@braiinstatiion". */
    handle: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^@?[A-Za-z0-9._-]+$/, 'letters, digits, . _ - only'),
    url: z.string().trim().url().max(300),
    /**
     * "Show on the site" (Admin v2 U9): false keeps the account in the admin and out of every
     * public place, the Social section and the Organization JSON-LD's sameAs alike. A link
     * stored before U9 has no flag and reads as shown.
     */
    visible: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    let u: URL;
    try {
      u = new URL(v.url);
    } catch {
      return; // .url() above already reported it
    }
    if (u.protocol !== 'https:' || u.username || u.password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'https, no credentials',
      });
    } else if (!SOCIAL_HOSTS[v.network].test(u.hostname)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: `a ${v.network} link must point at ${v.network}`,
      });
    }
  });
export type SocialLink = z.infer<typeof SocialLinkSchema>;

const E164 = z.string().regex(/^\+[1-9][0-9]{7,14}$/, 'E.164, e.g. +9665XXXXXXXX');

/** Plain text on one line: no control characters (a tab, a newline, a NUL). */
// eslint-disable-next-line no-control-regex
const NO_CONTROL = /^[^\u0000-\u001f\u007f]*$/;
const line = (max: number) =>
  z.string().trim().min(1).max(max).regex(NO_CONTROL, 'one line of plain text');

/** The tagline (Admin v2 U9, 0099): both languages, up to 120 characters each. */
export const TAGLINE_MAX = 120;
const TaglineSchema = z.object({ en: line(TAGLINE_MAX), ar: line(TAGLINE_MAX) });

/**
 * The footer's copyright line (E6 renders it; U9 stores it): both languages, up to 160
 * characters, and no brace but the three placeholders {year}, {brand} and {place} (the
 * 0099 CHECK says the same).
 */
export const FOOTER_COPYRIGHT_MAX = 160;
export const COPYRIGHT_PLACEHOLDERS = ['{year}', '{brand}', '{place}'] as const;
const copyrightLine = line(FOOTER_COPYRIGHT_MAX).refine(
  (v) => !/[{}]/.test(v.replace(/\{(year|brand|place)\}/g, '')),
  'only {year}, {brand} and {place} may be in braces',
);
const FooterCopyrightSchema = z.object({ en: copyrightLine, ar: copyrightLine });

export const FOOTER_STYLES = ['light', 'dark'] as const;

/**
 * Where a map link may point (Admin v2 U9, decision D6): Google Maps and Apple Maps, https,
 * no credentials. Like the socials' hosts: the link renders in the Organization JSON-LD on
 * every page, so "any https URL" would let a stolen editor session point the brand's map
 * anywhere. `path` narrows a host that serves more than maps.
 */
const MAP_HOSTS: readonly { host: RegExp; path?: RegExp }[] = [
  { host: /^maps\.app\.goo\.gl$/ },
  { host: /^goo\.gl$/, path: /^\/maps(\/|$)/ },
  { host: /^(www\.)?google\.com$/, path: /^\/maps(\/|$)/ },
  { host: /^maps\.google\.com$/ },
  { host: /^maps\.apple\.com$/ },
];

/** True when `value` is an https Google Maps or Apple Maps link with no credentials. */
export function isMapLink(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  if (value.length > 500 || /\s/.test(value)) return false;
  return MAP_HOSTS.some(
    (rule) => rule.host.test(u.hostname) && (rule.path === undefined || rule.path.test(u.pathname)),
  );
}
const MapUrlSchema = z
  .string()
  .trim()
  .max(500)
  .refine(isMapLink, 'a Google Maps or Apple Maps link (https)');

/** Admin write (PATCH). Every field optional — a singleton PATCH saves what it names. */
export const SiteProfileSchema = z
  .object({
    brandName: LocalizedTextSchema.optional(),
    legalName: LocalizedTextSchema.nullish(),
    contactEmail: z.string().trim().toLowerCase().email().max(254).optional(),
    whatsappE164: E164.nullish(),
    whatsappDisplay: z.string().trim().min(1).max(32).nullish(),
    location: LocalizedTextSchema.optional(),
    addressLocality: LocalizedTextSchema.nullish(),
    addressCountry: z
      .string()
      .regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2')
      .optional(),
    foundedYear: z.number().int().min(1900).max(2100).nullish(),
    socials: z.array(SocialLinkSchema).max(8).optional(),
    acceptingApplications: z.boolean().optional(),
    // Admin v2 U9 (0099)
    tagline: TaglineSchema.nullish(),
    phoneE164: E164.nullish(),
    phoneDisplay: line(32).nullish(),
    mapUrl: MapUrlSchema.nullish(),
    faviconMediaId: z.string().uuid().nullish(),
    appIconMediaId: z.string().uuid().nullish(),
    footerCopyright: FooterCopyrightSchema.nullish(),
    footerStyle: z.enum(FOOTER_STYLES).optional(),
    footerShowEmail: z.boolean().optional(),
    footerShowSocial: z.boolean().optional(),
    version: z.number().int().min(0),
  })
  .refine((v) => !(v.whatsappDisplay && v.whatsappE164 === null), {
    path: ['whatsappDisplay'],
    message: 'a display number needs the E.164 number it displays',
  })
  .refine((v) => !(v.phoneDisplay && v.phoneE164 === null), {
    path: ['phoneDisplay'],
    message: 'a display number needs the E.164 number it displays',
  });
export type SiteProfileInput = z.infer<typeof SiteProfileSchema>;

/** Public row (anon read). snake_case: this is the table shape the loader receives. */
export const SiteProfileRowSchema = z.object({
  brand_name: LocalizedTextSchema,
  legal_name: LocalizedTextSchema.nullable(),
  contact_email: z.string().email(),
  whatsapp_e164: z.string().nullable(),
  whatsapp_display: z.string().nullable(),
  location: LocalizedTextSchema,
  address_locality: LocalizedTextSchema.nullable(),
  address_country: z.string(),
  founded_year: z.number().nullable(),
  // Re-validated on READ as well: a row written straight through the database (or before
  // the allow-list tightened) must not be able to put an off-network link on every page.
  socials: z.array(z.unknown()).transform((items) =>
    items.flatMap((item) => {
      const parsed = SocialLinkSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  ),
  accepting_applications: z.boolean(),
  updated_at: z.string().nullable(),
  // Admin v2 U9 (0099). Each new field reads leniently, on its own: the identity falls back to
  // the code copy on ANY parse error (src/lib/data/siteProfile.ts), so a malformed tagline or
  // a map link off the allow-list must cost that field, never the brand on every page. Absent
  // (a row read before 0099) reads as unset or today's footer.
  tagline: TaglineSchema.nullable().optional().catch(null),
  phone_e164: E164.nullable().optional().catch(null),
  phone_display: z.string().max(32).nullable().optional().catch(null),
  map_url: z
    .string()
    .nullable()
    .optional()
    .transform((v) => (typeof v === 'string' && isMapLink(v) ? v : null))
    .catch(null),
  favicon_media_id: z.string().uuid().nullable().optional().catch(null),
  app_icon_media_id: z.string().uuid().nullable().optional().catch(null),
  footer_copyright: FooterCopyrightSchema.nullable().optional().catch(null),
  footer_style: z.enum(FOOTER_STYLES).optional().catch('light'),
  footer_show_email: z.boolean().optional().catch(true),
  footer_show_social: z.boolean().optional().catch(false),
});
export type SiteProfileRow = z.infer<typeof SiteProfileRowSchema>;
