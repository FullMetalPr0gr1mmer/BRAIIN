import type { SocialLink } from '@schemas/siteProfile';

// THE one copy of the public identity that lives in code.
//
// The identity is data (`public.site_profile`, migration 0019): the brand is "Braiin
// Statiion" since UI v2 (owner decision 1), and the next rename must be an edit in the
// CMS, not a deploy. This constant exists only so a page still says who it belongs to when
// the database is unreachable or unconfigured (CI dummies, a Supabase outage) — the header,
// footer and JSON-LD must never render blank.
//
// Real identity values, never placeholders: no demo WhatsApp number (the card simply does
// not render), applications closed (the go-live gate — see UI v2 decision 3/4).

export interface Identity {
  brandName: { en: string; ar: string };
  /** Registered legal entity for legal copy; null until the owner supplies it. */
  legalName: { en: string; ar: string } | null;
  contactEmail: string;
  whatsappE164: string | null;
  whatsappDisplay: string | null;
  location: { en: string; ar: string };
  addressLocality: { en: string; ar: string } | null;
  addressCountry: string;
  foundedYear: number | null;
  socials: SocialLink[];
  acceptingApplications: boolean;
}

export const IDENTITY_FALLBACK: Identity = {
  brandName: { en: 'Braiin Statiion', ar: 'بريّن ستيشن' },
  legalName: null,
  contactEmail: 'hello@braiinstatiion.com',
  whatsappE164: null,
  whatsappDisplay: null,
  location: { en: 'Jeddah, Saudi Arabia', ar: 'جدة، المملكة العربية السعودية' },
  addressLocality: { en: 'Jeddah', ar: 'جدة' },
  addressCountry: 'SA',
  foundedYear: 2019,
  socials: [
    {
      network: 'instagram',
      handle: '@braiinstatiion',
      url: 'https://instagram.com/braiinstatiion',
    },
    {
      network: 'linkedin',
      handle: '@braiin-statiion',
      url: 'https://linkedin.com/company/braiin-statiion',
    },
    { network: 'behance', handle: '@braiinstatiion', url: 'https://behance.net/braiinstatiion' },
    { network: 'youtube', handle: '@braiinstatiion', url: 'https://youtube.com/@braiinstatiion' },
  ],
  acceptingApplications: false,
};
