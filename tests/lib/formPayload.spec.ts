import { describe, it, expect } from 'vitest';
import { SINGLETON_UI } from '@/lib/admin/uiSchema';
import { rowToForm, formToPayload } from '@/lib/admin/formPayload';
import { SeoDefaultsSchema } from '@schemas/admin';
import { SiteProfileSchema } from '@schemas/siteProfile';

// The admin forms round-trip a stored row through the form and back to a PATCH body. A
// regression here does not fail loudly — it makes a form impossible to save, which is how
// "blank optional bilingual → null" broke the Global SEO defaults form (NOT NULL columns).

describe('formToPayload', () => {
  it('an SEO defaults form with blank bilingual fields still saves', () => {
    const ui = SINGLETON_UI['seo']!;
    const stored = {
      // What an unauthored row holds: the columns are NOT NULL DEFAULT '{}'.
      title_template: {},
      default_title: {},
      default_description: {},
      default_og_image: null,
      organization: {},
      robots_directives: 'index,follow',
      version: 3,
    };
    const payload = formToPayload(rowToForm(stored, ui.fields), ui.fields);
    expect(payload['titleTemplate']).toEqual({});
    expect(payload['defaultTitle']).toEqual({});
    const parsed = SeoDefaultsSchema.safeParse({ ...payload, version: 3 });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('a NULLABLE bilingual field left blank is sent as null ("none")', () => {
    const ui = SINGLETON_UI['profile']!;
    const stored = {
      brand_name: { en: 'Braiin Statiion', ar: 'بريّن ستيشن' },
      legal_name: null,
      contact_email: 'hello@braiinstatiion.com',
      whatsapp_e164: null,
      whatsapp_display: null,
      location: { en: 'Jeddah, Saudi Arabia', ar: 'جدة، المملكة العربية السعودية' },
      address_locality: { en: '', ar: '' },
      address_country: 'SA',
      founded_year: 2019,
      socials: [],
      accepting_applications: false,
      version: 1,
    };
    const payload = formToPayload(rowToForm(stored, ui.fields), ui.fields);
    expect(payload['legalName']).toBeNull();
    expect(payload['addressLocality']).toBeNull();
    const parsed = SiteProfileSchema.safeParse({ ...payload, version: 1 });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('marks the identity fields the schema cannot do without as required', () => {
    const required = SINGLETON_UI['profile']!.fields.filter((f) => f.required).map((f) => f.name);
    expect(required).toEqual(expect.arrayContaining(['brandName', 'contactEmail', 'location']));
  });
});
