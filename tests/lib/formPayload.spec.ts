import { describe, it, expect } from 'vitest';
import { SINGLETON_UI, RESOURCE_UI, type FieldDef } from '@/lib/admin/uiSchema';
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

// ── Composite kinds (UI v2 PR3) ──────────────────────────────────────────────────
const f = (field: Partial<FieldDef> & Pick<FieldDef, 'name' | 'kind'>): FieldDef => ({
  label: field.name,
  ...field,
});

describe('formToPayload — composite kinds', () => {
  it('a relation left empty is null, a chosen one is its id', () => {
    const rel = f({
      name: 'pageId',
      kind: 'relation',
      relation: { resource: 'pages', labelKey: 'title' },
    });
    expect(formToPayload({ pageId: '' }, [rel])).toEqual({ pageId: null });
    expect(formToPayload({ pageId: 'abc' }, [rel])).toEqual({ pageId: 'abc' });
  });

  it('a multi relation keeps the chosen ORDER and drops duplicates', () => {
    const multi = f({ name: 'ids', kind: 'multiRelation' });
    expect(formToPayload({ ids: ['b', 'a', 'b', ''] }, [multi])).toEqual({ ids: ['b', 'a'] });
  });

  it('a repeater drops untouched rows and omits blank overrides inside items', () => {
    const rep = f({
      name: 'columns',
      kind: 'repeater',
      itemFields: [f({ name: 'title', kind: 'bilingual' }), f({ name: 'body', kind: 'bilingual' })],
    });
    const out = formToPayload(
      {
        columns: [
          { title: { en: 'A', ar: 'أ' }, body: { en: '', ar: '' } },
          {},
          { title: { en: '', ar: '' } },
        ],
      },
      [rep],
    );
    expect(out).toEqual({ columns: [{ title: { en: 'A', ar: 'أ' } }] });
  });

  it('a clip is either/or, and its window is both-or-neither', () => {
    const clip = f({ name: 'clip', kind: 'clip' });
    const base = { streamUid: '', path: '', startS: '', endS: '' };
    expect(formToPayload({ clip: { ...base, source: '' } }, [clip])).toEqual({ clip: null });
    expect(
      formToPayload(
        { clip: { ...base, source: 'path', path: '/media/a.mp4', startS: '2', endS: '8' } },
        [clip],
      ),
    ).toEqual({ clip: { path: '/media/a.mp4', startS: 2, endS: 8 } });
    expect(() =>
      formToPayload({ clip: { ...base, source: 'stream', streamUid: 'uid', startS: '2' } }, [clip]),
    ).toThrow(/both a start and an end/);
    expect(() => formToPayload({ clip: { ...base, source: 'stream' } }, [clip])).toThrow(
      /Stream UID/,
    );
  });

  it('section content is shaped by the sibling type, or parsed in Advanced mode', () => {
    const fields = RESOURCE_UI['sections']!.fields;
    const typed = formToPayload(
      {
        type: 'cta',
        content: {
          values: { heading: { en: 'Hi', ar: 'أهلاً' }, text: { en: '', ar: '' } },
          json: null,
        },
      },
      fields,
    );
    expect(typed['content']).toEqual({ heading: { en: 'Hi', ar: 'أهلاً' } });

    const advanced = formToPayload(
      { type: 'hero', content: { values: {}, json: '{"intro": true}' } },
      fields,
    );
    expect(advanced['content']).toEqual({ intro: true });
    expect(() =>
      formToPayload({ type: 'hero', content: { values: {}, json: '{not json' } }, fields),
    ).toThrow(/not valid JSON/);
  });

  it('round-trips a stored section through the form unchanged', () => {
    const fields = RESOURCE_UI['sections']!.fields;
    const stored = {
      page_id: 'p1',
      type: 'aboutIntro',
      content: {
        heading: { en: 'H', ar: 'ع' },
        columns: [{ title: { en: 'T', ar: 'ت' }, body: { en: 'B', ar: 'ب' } }],
      },
      visible: true,
      is_placeholder: false,
      sort_order: 3,
    };
    const payload = formToPayload(rowToForm(stored, fields), fields);
    expect(payload['content']).toEqual(stored.content);
    expect(payload['pageId']).toBe('p1');
  });

  it('a table-backed section type saves empty content', () => {
    const fields = RESOURCE_UI['sections']!.fields;
    const form = rowToForm({ type: 'statistics', content: {} }, fields);
    // no editor for this type → JSON mode with {}
    expect(formToPayload(form, fields)['content']).toEqual({});
  });
});
