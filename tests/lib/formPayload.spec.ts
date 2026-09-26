import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SINGLETON_UI, RESOURCE_UI, type FieldDef } from '@/lib/admin/uiSchema';
import {
  rowToForm,
  formToPayload,
  enterAdvanced,
  leaveAdvanced,
  type SectionContentState,
} from '@/lib/admin/formPayload';
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
    const form = rowToForm({ type: 'team', content: {} }, fields);
    // no editor for this type → JSON mode with {}
    expect(formToPayload(form, fields)['content']).toEqual({});
  });
});

describe('section content keeps what the typed editor does not edit', () => {
  const fields = RESOURCE_UI['sections']!.fields;

  it('a typed save of a hero keeps its JSON-only `intro`', () => {
    // Data-loss guard: hero.intro has no typed field, and dropping it on an unrelated edit
    // would silently switch the home logo plate off (or on).
    const stored = { type: 'hero', content: { intro: false, sub: { en: 'S', ar: 'س' } } };
    const form = rowToForm(stored, fields);
    const payload = formToPayload(form, fields);
    expect(payload['content']).toEqual({ intro: false, sub: { en: 'S', ar: 'س' } });
  });

  it('does not carry a key of the OLD type after the section type changes', () => {
    const form = rowToForm({ type: 'hero', content: { intro: true } }, fields);
    const payload = formToPayload({ ...form, type: 'cta' }, fields);
    expect(payload['content']).toEqual({});
  });
});

describe('the Advanced (JSON) toggle never loses work', () => {
  const fields = RESOURCE_UI['sections']!.fields;
  const HERO = { type: 'hero', content: { headline: { en: 'Old', ar: 'قديم' }, intro: true } };

  it('entering shows the stored keys the fields do not cover; leaving carries JSON edits back', () => {
    const form = rowToForm(HERO, fields);
    const entered = enterAdvanced(form['content'] as SectionContentState, 'hero');
    expect(JSON.parse(entered.json!)).toEqual(HERO.content);

    const edited = {
      ...entered,
      json: JSON.stringify({ headline: { en: 'New', ar: 'جديد' }, intro: false }),
    };
    const left = leaveAdvanced(edited, 'hero');
    expect(left.json).toBeNull();
    expect(left.values['headline']).toEqual({ en: 'New', ar: 'جديد' });
    expect(left.extra).toEqual({ intro: false });

    const payload = formToPayload({ ...form, content: left }, fields);
    expect(payload['content']).toEqual({ headline: { en: 'New', ar: 'جديد' }, intro: false });
  });

  it('leaving with JSON that is not an object refuses (the caller stays in Advanced)', () => {
    const state: SectionContentState = { values: {}, json: '{"headline": ' };
    expect(() => leaveAdvanced(state, 'hero')).toThrow(/Fix the JSON/);
    expect(() => leaveAdvanced({ values: {}, json: '[1]' }, 'hero')).toThrow(/Fix the JSON/);
  });
});

describe('section content with no type chosen', () => {
  const fields = RESOURCE_UI['sections']!.fields;

  it('is left out of the payload — typed mode', () => {
    const form = rowToForm({ type: 'cta', content: { heading: { en: 'H', ar: 'ع' } } }, fields);
    expect(formToPayload({ ...form, type: '' }, fields)).not.toHaveProperty('content');
  });

  it('is left out of the payload — Advanced mode', () => {
    const form = rowToForm({ type: 'cta', content: {} }, fields);
    const advanced = { ...form, type: '', content: { values: {}, json: '{"x":1}' } };
    expect(formToPayload(advanced, fields)).not.toHaveProperty('content');
  });
});

describe('a table-backed section', () => {
  const fields = RESOURCE_UI['sections']!.fields;

  it('loads as the "nothing to override" note, and saves {}', () => {
    const form = rowToForm({ type: 'team', content: {} }, fields);
    expect((form['content'] as SectionContentState).json).toBeNull();
    expect(formToPayload(form, fields)['content']).toEqual({});
  });

  it('keeps leftover content visible as JSON so it can be cleared', () => {
    const form = rowToForm({ type: 'team', content: { stale: 1 } }, fields);
    expect(JSON.parse((form['content'] as SectionContentState).json!)).toEqual({ stale: 1 });
  });
});

describe('datetime fields round-trip in a non-UTC browser', () => {
  // datetime-local is LOCAL wall-clock time. Slicing the stored UTC string moved a scheduled
  // time earlier by the offset on every save — invisible to a test running in UTC.
  const previous = process.env['TZ'];
  beforeAll(() => {
    process.env['TZ'] = 'Asia/Riyadh';
  });
  afterAll(() => {
    if (previous === undefined) delete process.env['TZ'];
    else process.env['TZ'] = previous;
  });

  it('a stored instant saves back unchanged', () => {
    const field: FieldDef = { name: 'scheduledFor', label: 'Scheduled for', kind: 'datetime' };
    expect(new Date('2026-09-26T10:00:00Z').getTimezoneOffset()).toBe(-180); // the zone took
    const form = rowToForm({ scheduled_for: '2026-09-26T10:00:00+00:00' }, [field]);
    expect(form['scheduledFor']).toBe('2026-09-26T13:00');
    expect(formToPayload(form, [field])['scheduledFor']).toBe('2026-09-26T10:00:00.000Z');
  });
});
