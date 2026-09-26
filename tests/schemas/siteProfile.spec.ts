import { describe, it, expect } from 'vitest';
import { SiteProfileRowSchema, SiteProfileSchema, SocialLinkSchema } from '@schemas/siteProfile';
import { IDENTITY_FALLBACK } from '@/lib/identity/fallback';

describe('SocialLinkSchema — each network may only link to itself', () => {
  it('accepts the brand handles', () => {
    for (const link of IDENTITY_FALLBACK.socials) {
      expect(SocialLinkSchema.safeParse(link).success, link.url).toBe(true);
    }
  });
  it('rejects an off-network, non-https or credentialed link', () => {
    const bad = [
      { network: 'instagram', handle: '@x', url: 'https://evil.example/x' },
      { network: 'instagram', handle: '@x', url: 'http://instagram.com/x' },
      { network: 'instagram', handle: '@x', url: 'https://user:pw@instagram.com/x' },
      { network: 'linkedin', handle: '@x', url: 'https://linkedin.com.evil.example/x' },
      { network: 'instagram', handle: 'no spaces allowed', url: 'https://instagram.com/x' },
    ];
    for (const link of bad) expect(SocialLinkSchema.safeParse(link).success, link.url).toBe(false);
  });
});

describe('SiteProfileSchema (admin PATCH)', () => {
  it('accepts a partial update with a version', () => {
    expect(
      SiteProfileSchema.safeParse({ contactEmail: 'Hello@Example.com', version: 3 }).success,
    ).toBe(true);
  });
  it('lower-cases the contact email', () => {
    const r = SiteProfileSchema.parse({ contactEmail: 'Hello@Example.com', version: 1 });
    expect(r.contactEmail).toBe('hello@example.com');
  });
  it('requires E.164 for WhatsApp and refuses a display number without one', () => {
    expect(SiteProfileSchema.safeParse({ whatsappE164: '0500000000', version: 1 }).success).toBe(
      false,
    );
    expect(SiteProfileSchema.safeParse({ whatsappE164: '+966500000000', version: 1 }).success).toBe(
      true,
    );
    expect(
      SiteProfileSchema.safeParse({ whatsappE164: null, whatsappDisplay: '+966 50', version: 1 })
        .success,
    ).toBe(false);
  });
  it('requires a version (optimistic locking)', () => {
    expect(SiteProfileSchema.safeParse({ contactEmail: 'a@b.co' }).success).toBe(false);
  });
});

describe('SiteProfileRowSchema (public read)', () => {
  const row = {
    brand_name: IDENTITY_FALLBACK.brandName,
    legal_name: null,
    contact_email: IDENTITY_FALLBACK.contactEmail,
    whatsapp_e164: null,
    whatsapp_display: null,
    location: IDENTITY_FALLBACK.location,
    address_locality: null,
    address_country: 'SA',
    founded_year: 2019,
    socials: [
      ...IDENTITY_FALLBACK.socials,
      // written straight to the DB, bypassing the admin schema:
      { network: 'instagram', handle: '@x', url: 'https://evil.example/x' },
    ],
    accepting_applications: false,
    updated_at: null,
  };
  it('re-validates socials on READ and drops an off-network link', () => {
    const parsed = SiteProfileRowSchema.parse(row);
    expect(parsed.socials).toHaveLength(IDENTITY_FALLBACK.socials.length);
    expect(parsed.socials.every((s) => !s.url.includes('evil'))).toBe(true);
  });
});
