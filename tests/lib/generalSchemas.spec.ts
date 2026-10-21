import { describe, expect, it } from 'vitest';
import {
  SiteProfileRowSchema,
  SiteProfileSchema,
  SocialLinkSchema,
  isMapLink,
} from '@schemas/siteProfile';
import { SiteSettingsSchema } from '@schemas/settings';
import { MaintenanceInputSchema } from '@schemas/maintenance';
import { SiteSettingsSchema as LegacySiteSettings, MaintenanceSchema } from '@schemas/admin';

// General settings v2 and maintenance v2's write schemas (Admin v2 U9): what the admin may
// send, refused before the database's CHECKs (0102) would refuse it, and the public row read
// leniently field by field, so a bad value costs that field and never the brand.

const ok = (input: Record<string, unknown>) =>
  SiteProfileSchema.safeParse({ version: 1, ...input }).success;

describe('site_profile v2 (SiteProfileSchema)', () => {
  it('takes the new fields in their shapes', () => {
    expect(
      ok({
        tagline: { en: 'From the brain to the real world', ar: 'من الفكرة إلى الواقع' },
        phoneE164: '+966500000001',
        phoneDisplay: '050 000 0001',
        mapUrl: 'https://maps.app.goo.gl/abc123',
        faviconMediaId: '11111111-1111-4111-8111-111111111111',
        appIconMediaId: null,
        footerCopyright: { en: '© {year} {brand}. {place}', ar: '© {year} {brand}.' },
        footerStyle: 'dark',
        footerShowEmail: false,
        footerShowSocial: true,
      }),
    ).toBe(true);
    expect(ok({ tagline: null, mapUrl: null, footerCopyright: null })).toBe(true);
  });

  it('a tagline or a copyright needs both languages, on one line, within its length', () => {
    expect(ok({ tagline: { en: 'Only English' } })).toBe(false);
    expect(ok({ tagline: { en: 'a'.repeat(121), ar: 'ب' } })).toBe(false);
    expect(ok({ tagline: { en: 'Two\nlines', ar: 'ب' } })).toBe(false);
    expect(ok({ footerCopyright: { en: '© {year}' } })).toBe(false);
    expect(ok({ footerCopyright: { en: 'a'.repeat(161), ar: 'ب' } })).toBe(false);
  });

  it('a copyright braces only {year}, {brand} and {place}', () => {
    expect(ok({ footerCopyright: { en: '© {evil}', ar: '©' } })).toBe(false);
    expect(ok({ footerCopyright: { en: '© {year}}', ar: '©' } })).toBe(false);
    expect(ok({ footerCopyright: { en: '© {Year}', ar: '©' } })).toBe(false);
    expect(ok({ footerCopyright: { en: '© 2026 {brand}', ar: '© {year} {place}' } })).toBe(true);
  });

  it('a phone is E.164 with Latin digits, never normalised from Arabic-Indic ones', () => {
    expect(ok({ phoneE164: '+012345678' })).toBe(false);
    expect(ok({ phoneE164: '0500000001' })).toBe(false);
    expect(ok({ phoneE164: '+٩٦٦٥٠٠٠٠٠٠٠١' })).toBe(false);
    const parsed = SiteProfileSchema.safeParse({ version: 1, phoneDisplay: '٠٥٠ ٠٠٠ ٠٠٠١' });
    // The display form is shown as typed: its digits are kept exactly.
    expect(parsed.success && parsed.data.phoneDisplay).toBe('٠٥٠ ٠٠٠ ٠٠٠١');
  });

  it('a displayed phone needs the number it displays, as WhatsApp’s does', () => {
    expect(ok({ phoneE164: null, phoneDisplay: '050' })).toBe(false);
    expect(ok({ phoneE164: '+966500000001', phoneDisplay: '050' })).toBe(true);
  });

  it('the footer style is light or dark', () => {
    expect(ok({ footerStyle: 'blue' })).toBe(false);
  });
});

describe('the map link: Google Maps or Apple Maps, https, no credentials (D6)', () => {
  it.each([
    'https://maps.app.goo.gl/abc123',
    'https://goo.gl/maps/abc123',
    'https://www.google.com/maps/place/Jeddah',
    'https://google.com/maps?q=Jeddah',
    'https://maps.google.com/?q=Jeddah',
    'https://maps.apple.com/?q=Jeddah',
  ])('takes %s', (url) => {
    expect(isMapLink(url)).toBe(true);
    expect(ok({ mapUrl: url })).toBe(true);
  });

  it.each([
    'http://maps.app.goo.gl/abc',
    'javascript:alert(1)',
    'https://evil.example/maps',
    'https://goo.gl/abc',
    'https://www.google.com/search?q=maps',
    'https://user:pass@maps.app.goo.gl/abc',
    'https://maps.app.goo.gl:8443/abc',
    'https://maps.google.com.evil.example/',
    'https://maps.app.goo.gl/a b',
  ])('refuses %s', (url) => {
    expect(isMapLink(url)).toBe(false);
    expect(ok({ mapUrl: url })).toBe(false);
  });
});

describe('a social account’s "Show on the site" (visible)', () => {
  const link = { network: 'instagram', handle: '@x', url: 'https://instagram.com/x' };

  it('defaults to shown, and keeps an explicit off', () => {
    expect(SocialLinkSchema.parse(link).visible).toBe(true);
    expect(SocialLinkSchema.parse({ ...link, visible: false }).visible).toBe(false);
  });

  it('still holds each link to its own network, and at most 8', () => {
    expect(SocialLinkSchema.safeParse({ ...link, url: 'https://evil.example/x' }).success).toBe(
      false,
    );
    expect(ok({ socials: Array.from({ length: 9 }, () => link) })).toBe(false);
  });
});

describe('the public row (SiteProfileRowSchema) reads each new field on its own', () => {
  const ROW = {
    brand_name: { en: 'B', ar: 'ب' },
    legal_name: null,
    contact_email: 'a@example.test',
    whatsapp_e164: null,
    whatsapp_display: null,
    location: { en: 'J', ar: 'ج' },
    address_locality: null,
    address_country: 'SA',
    founded_year: null,
    socials: [{ network: 'instagram', handle: '@x', url: 'https://instagram.com/x' }],
    accepting_applications: false,
    updated_at: null,
  };

  it('a row from before 0102 reads with no tagline, phone, map or icons and today’s footer', () => {
    const row = SiteProfileRowSchema.parse(ROW);
    expect(row.tagline ?? null).toBeNull();
    expect(row.map_url).toBeNull();
    expect(row.footer_style ?? 'light').toBe('light');
    expect(row.socials[0]?.visible).toBe(true);
  });

  it('a bad value costs its field, never the row (the brand stays)', () => {
    const parsed = SiteProfileRowSchema.safeParse({
      ...ROW,
      tagline: { en: 'only' },
      phone_e164: 'nope',
      map_url: 'https://evil.example/maps',
      favicon_media_id: 'not-a-uuid',
      footer_copyright: { en: '{evil}', ar: 'x' },
      footer_style: 'blue',
      footer_show_email: 'yes',
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.brand_name.en).toBe('B');
    expect(parsed.data).toMatchObject({
      tagline: null,
      phone_e164: null,
      map_url: null,
      favicon_media_id: null,
      footer_copyright: null,
      footer_style: 'light',
      footer_show_email: true,
    });
  });
});

describe('the settings row (SiteSettingsSchema, Admin v2 U9)', () => {
  it('takes a listed zone and the retention caps; refuses another zone', () => {
    expect(SiteSettingsSchema.safeParse({ timezone: 'Asia/Dubai', version: 0 }).success).toBe(true);
    expect(SiteSettingsSchema.safeParse({ timezone: 'Europe/Paris', version: 1 }).success).toBe(
      false,
    );
    for (const [retention, okay] of [
      [{ raw_telemetry_days: 90 }, true],
      [{ raw_telemetry_days: 91 }, false],
      [{ leads_months: 24 }, true],
      [{ leads_months: 25 }, false],
      [{ spam_days: 0 }, false],
      [{ spam_days: 1.5 }, false],
    ] as const) {
      expect(
        SiteSettingsSchema.safeParse({ retention, version: 1 }).success,
        JSON.stringify(retention),
      ).toBe(okay);
    }
  });

  it('refuses the technical identity JSON that left the form (no reader since 0048)', () => {
    expect(SiteSettingsSchema.safeParse({ identity: {}, version: 1 }).success).toBe(false);
  });

  it('is the one admin.ts re-exports', () => {
    expect(LegacySiteSettings).toBe(SiteSettingsSchema);
    expect(MaintenanceSchema).toBe(MaintenanceInputSchema);
  });
});

describe('maintenance v2 (MaintenanceInputSchema)', () => {
  const parse = (input: Record<string, unknown>) =>
    MaintenanceInputSchema.safeParse({ version: 1, ...input });

  it('takes a save naming only what it changes', () => {
    expect(parse({ active: true }).success).toBe(true);
    expect(parse({}).success).toBe(true);
  });

  it('canonicalises and dedupes the allowlist; refuses a hostname or a range', () => {
    const r = parse({ allowlist: ['203.0.113.9', '2001:DB8::1', '2001:db8:0:0:0:0:0:1'] });
    expect(r.success && r.data.allowlist).toEqual(['203.0.113.9', '2001:db8::1']);
    expect(parse({ allowlist: ['example.com'] }).success).toBe(false);
    expect(parse({ allowlist: ['203.0.113.0/24'] }).success).toBe(false);
    expect(parse({ allowlist: Array.from({ length: 51 }, (_, i) => `10.0.0.${i}`) }).success).toBe(
      false,
    );
  });

  it('a "Back on" is a real calendar day', () => {
    expect(parse({ until: '2026-11-03' }).success).toBe(true);
    expect(parse({ until: null }).success).toBe(true);
    expect(parse({ until: '2026-02-30' }).success).toBe(false);
    expect(parse({ until: '3 Nov' }).success).toBe(false);
  });

  it('the copy is plain text in both languages, within its length; a line break is a space', () => {
    const r = parse({ message: { en: 'Back\nsoon', ar: 'نعود\nقريبًا' } });
    expect(r.success && r.data.message).toEqual({ en: 'Back soon', ar: 'نعود قريبًا' });
    expect(parse({ title: { en: 'Only English' } }).success).toBe(false);
    expect(parse({ title: { en: 'a'.repeat(81), ar: 'ب' } }).success).toBe(false);
    expect(parse({ message: { en: 'a'.repeat(281), ar: 'ب' } }).success).toBe(false);
    expect(parse({ title: { en: 'tab\u0000here', ar: 'ب' } }).success).toBe(false);
  });

  it('refuses an unknown key and a background outside the two', () => {
    expect(parse({ ribbon: true }).success).toBe(false);
    expect(parse({ background: 'video' }).success).toBe(false);
  });
});
