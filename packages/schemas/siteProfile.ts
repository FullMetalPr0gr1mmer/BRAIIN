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
    version: z.number().int().min(0),
  })
  .refine((v) => !(v.whatsappDisplay && v.whatsappE164 === null), {
    path: ['whatsappDisplay'],
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
});
export type SiteProfileRow = z.infer<typeof SiteProfileRowSchema>;
