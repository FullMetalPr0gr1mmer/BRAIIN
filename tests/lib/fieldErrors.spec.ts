import { describe, expect, it } from 'vitest';
import { AdminApiError } from '@/lib/admin/client';
import { badInputErrors, errorsFromApi, issueToFieldId, mapIssues } from '@/lib/admin/fieldErrors';
import { RESOURCE_UI, type FieldDef } from '@/lib/admin/uiSchema';

// The API's `issues[].path` → the form's element ids and the ErrorSummary's words (Admin v2
// F5a). The ids are the ones FormField renders (pinned in adminFields.spec.ts), so a path
// that maps here reaches a real input.

const FIELDS: FieldDef[] = [
  { name: 'slug', label: 'Slug', kind: 'slug', required: true },
  { name: 'title', label: 'Service name', kind: 'bilingual', required: true },
  { name: 'blurb', label: 'Tagline', kind: 'prose' },
  { name: 'body', label: 'Body', kind: 'richtext' },
  {
    name: 'valuePoints',
    label: 'Value we add',
    kind: 'repeater',
    itemFields: [
      { name: 'title', label: 'Title', kind: 'bilingual', required: true },
      { name: 'text', label: 'Text', kind: 'bilingual', required: true },
    ],
  },
  {
    name: 'rating',
    label: 'Rating line',
    kind: 'object',
    itemFields: [{ name: 'value', label: 'Rating as shown', kind: 'text' }],
  },
  { name: 'type', label: 'Type', kind: 'select' },
  { name: 'content', label: 'Content', kind: 'sectionContent' },
  { name: 'tags', label: 'Tags', kind: 'tags' },
];

describe('issueToFieldId', () => {
  it('turns a dotted path into the element id the form renders', () => {
    expect(issueToFieldId('title.ar')).toBe('f-title-ar');
    expect(issueToFieldId('items.2.title.en')).toBe('f-items-2-title-en');
    expect(issueToFieldId('content.heading.ar')).toBe('f-content-heading-ar');
    expect(issueToFieldId('slug')).toBe('f-slug');
    expect(issueToFieldId('slug', 'kit')).toBe('kit-slug');
  });
});

describe('mapIssues', () => {
  it('top level, bilingual, repeater, object and section content reach their inputs', () => {
    const { byId, summary } = mapIssues(
      [
        { path: 'slug', message: 'Required' },
        { path: 'title.ar', message: 'Required' },
        { path: 'valuePoints.1.text.en', message: 'Too long' },
        { path: 'rating.value', message: 'Required' },
        { path: 'content.heading.ar', message: 'Required' },
      ],
      FIELDS,
    );
    expect(byId).toEqual({
      'f-slug': 'Required',
      'f-title-ar': 'Required',
      'f-valuePoints-1-text-en': 'Too long',
      'f-rating-value': 'Required',
      'f-content-heading-ar': 'Required',
    });
    expect(summary).toEqual([
      { id: 'f-slug', message: 'Slug: Required' },
      { id: 'f-title-ar', message: 'Service name (Arabic): Required' },
      { id: 'f-valuePoints-1-text-en', message: 'Value we add 2, Text (English): Too long' },
      { id: 'f-rating-value', message: 'Rating line, Rating as shown: Required' },
      { id: 'f-content-heading-ar', message: 'Content, Heading (Arabic): Required' },
    ]);
  });

  it('a whole bilingual pair names its group (review L12); a deep rich-text path its editor', () => {
    const { byId, summary } = mapIssues(
      [
        { path: 'title', message: 'Required' },
        { path: 'body.ar.content.0.content.1.text', message: 'Too long' },
      ],
      FIELDS,
    );
    expect(byId).toEqual({ 'f-title': 'Required', 'f-body-ar': 'Too long' });
    expect(summary[0]).toEqual({ id: 'f-title', message: 'Service name: Required' });
    expect(summary[1]).toEqual({ id: 'f-body-ar', message: 'Body (Arabic): Too long' });
  });

  it('an error inside a single control is that control’s (a chip, an index)', () => {
    expect(mapIssues([{ path: 'tags.3', message: 'Too long' }], FIELDS).byId).toEqual({
      'f-tags': 'Too long',
    });
  });

  it('a clip’s window reaches its inputs; the clip as a whole names its group', () => {
    const clip: FieldDef[] = [{ name: 'clip', label: 'Hero clip', kind: 'clip' }];
    expect(mapIssues([{ path: 'clip.endS', message: 'Too long' }], clip).byId).toEqual({
      'f-clip-end': 'Too long',
    });
    expect(mapIssues([{ path: 'clip', message: 'Choose one' }], clip).summary).toEqual([
      { id: 'f-clip', message: 'Hero clip: Choose one' },
    ]);
  });

  it('a path that names no declared field is listed without a link', () => {
    const { byId, summary } = mapIssues(
      [
        { path: 'disciplineId', message: 'Publishing needs a discipline' },
        { path: '', message: 'Choose at least one' },
      ],
      FIELDS,
    );
    expect(byId).toEqual({});
    expect(summary).toEqual([
      { message: 'disciplineId: Publishing needs a discipline' },
      { message: 'Choose at least one' },
    ]);
  });

  it('a whole repeater, an item, an object or section content names its group (review L5)', () => {
    const { byId, summary } = mapIssues(
      [
        { path: 'valuePoints', message: 'At most 6' },
        { path: 'valuePoints.1', message: 'Fill this card or remove it' },
        { path: 'rating', message: 'Give both parts' },
        { path: 'content', message: 'Unknown key' },
        { path: 'content.nope', message: 'Unrecognized key' },
      ],
      FIELDS,
    );
    expect(byId).toEqual({
      'f-valuePoints': 'At most 6',
      'f-rating': 'Give both parts',
      'f-content': 'Unknown key',
    });
    expect(summary.map((e) => e.id)).toEqual([
      'f-valuePoints',
      'f-valuePoints',
      'f-rating',
      'f-content',
      'f-content',
    ]);
    expect(summary[1]?.message).toBe('Value we add 2: Fill this card or remove it');
  });

  it('a repeater’s item index is the payload’s, mapped back past untouched blank items (review M3)', () => {
    // The first item was never touched, so it is not sent: the server's item 0 is the
    // form's item 1.
    const values = { valuePoints: [{}, { title: { en: 'x', ar: '' } }] };
    const { byId, summary } = mapIssues(
      [{ path: 'valuePoints.0.title.ar', message: 'Required' }],
      FIELDS,
      'f',
      values,
    );
    expect(byId).toEqual({ 'f-valuePoints-1-title-ar': 'Required' });
    expect(summary[0]?.message).toBe('Value we add 2, Title (Arabic): Required');
    // Without the values, the index is read as it came.
    expect(
      mapIssues([{ path: 'valuePoints.0.title.ar', message: 'Required' }], FIELDS).byId,
    ).toEqual({ 'f-valuePoints-0-title-ar': 'Required' });
  });

  it('section content reads the section’s own type for a sub-field (review L7)', async () => {
    const { SECTION_UI } = await import('@/lib/admin/sectionUi');
    // A key two section types both hold, under different labels where they differ.
    const types = Object.entries(SECTION_UI).filter(([, f]) => f?.some((x) => x.name === 'items'));
    expect(types.length).toBeGreaterThan(1);
    for (const [type, fields] of types) {
      const own = fields!.find((x) => x.name === 'items')!;
      const { summary } = mapIssues([{ path: 'content.items', message: 'x' }], FIELDS, 'f', {
        type,
        content: { values: {}, json: null },
      });
      expect(summary[0]?.message, type).toBe(`Content, ${own.label}: x`);
    }
  });

  it('keeps the first message per field inline, and every one in the summary', () => {
    const { byId, summary } = mapIssues(
      [
        { path: 'slug', message: 'Required' },
        { path: 'slug', message: 'Lower case only' },
      ],
      FIELDS,
    );
    expect(byId).toEqual({ 'f-slug': 'Required' });
    expect(summary).toHaveLength(2);
  });

  it('maps every resource field’s own path to an id it renders', () => {
    for (const ui of Object.values(RESOURCE_UI)) {
      for (const field of ui.fields) {
        const lang = ['bilingual', 'prose', 'richtext'].includes(field.kind) ? '.en' : '';
        const { byId } = mapIssues([{ path: `${field.name}${lang}`, message: 'x' }], ui.fields);
        if (['repeater', 'object', 'sectionContent', 'clip'].includes(field.kind)) continue;
        expect(Object.keys(byId), `${ui.slug}.${field.name}`).toEqual([
          issueToFieldId(`${field.name}${lang}`),
        ]);
      }
    }
  });
});

describe('errorsFromApi', () => {
  it('reads the kernel’s issues', () => {
    const err = new AdminApiError({
      error: 'validation',
      status: 422,
      issues: [{ path: 'title.en', message: 'Required' }],
    });
    expect(errorsFromApi(err, FIELDS)?.byId).toEqual({ 'f-title-en': 'Required' });
  });

  it('reads the one field a mapped constraint names', () => {
    const err = new AdminApiError({
      error: 'validation',
      status: 422,
      detail: 'That slug is taken.',
      field: 'slug',
    });
    expect(errorsFromApi(err, FIELDS)).toEqual({
      byId: { 'f-slug': 'That slug is taken.' },
      summary: [{ id: 'f-slug', message: 'Slug: That slug is taken.' }],
    });
  });

  it('is null for an error that is not about fields', () => {
    expect(errorsFromApi(new AdminApiError({ error: 'conflict', status: 409 }), FIELDS)).toBeNull();
    expect(errorsFromApi(new Error('offline'), FIELDS)).toBeNull();
  });
});

describe('badInputErrors (review M2)', () => {
  it('names each box the browser could not read, linked to it', () => {
    expect(
      badInputErrors([
        { id: 'f-sortOrder', type: 'number', label: 'Sort order' },
        { id: 'f-scheduledFor', type: 'datetime-local', label: 'Scheduled for' },
      ]),
    ).toEqual({
      byId: {
        'f-sortOrder': 'Enter a number, or clear the box.',
        'f-scheduledFor': 'Enter the whole date and time, or clear it.',
      },
      summary: [
        { id: 'f-sortOrder', message: 'Sort order: Enter a number, or clear the box.' },
        {
          id: 'f-scheduledFor',
          message: 'Scheduled for: Enter the whole date and time, or clear it.',
        },
      ],
    });
  });
});

describe('the rest of the field kit (Admin v2 F5b)', () => {
  const fields: FieldDef[] = [
    { name: 'heading', label: 'Heading', kind: 'bilingual' },
    {
      name: 'accent',
      label: 'Highlighted words',
      kind: 'accent',
      accent: { of: 'heading', mode: 'range' },
    },
    { name: 'button', label: 'Closing button', kind: 'link' },
    {
      name: 'cardSlugs',
      label: 'The two cards beside it',
      kind: 'slugRelation',
      relation: { resource: 'portfolio', labelKey: 'title', valueKey: 'slug' },
    },
  ];

  it('an accent lands on the picker its path names', () => {
    expect(mapIssues([{ path: 'accent.en.from', message: 'Out of range.' }], fields)).toEqual({
      byId: { 'f-accent-en-from': 'Out of range.' },
      summary: [{ id: 'f-accent-en-from', message: 'Highlighted words (English): Out of range.' }],
    });
    expect(mapIssues([{ path: 'accent.ar.to', message: 'Too far.' }], fields).byId).toEqual({
      'f-accent-ar-to': 'Too far.',
    });
    // The whole accent: its group, which carries the id.
    expect(mapIssues([{ path: 'accent', message: 'Bad range.' }], fields).byId).toEqual({
      'f-accent': 'Bad range.',
    });
  });

  it('a link lands on its words or on where it goes', () => {
    expect(
      mapIssues([{ path: 'button.href', message: 'must be #anchor or /path' }], fields),
    ).toEqual({
      byId: { 'f-button-href': 'must be #anchor or /path' },
      summary: [
        {
          id: 'f-button-href',
          message: 'Closing button, where it goes: must be #anchor or /path',
        },
      ],
    });
    expect(mapIssues([{ path: 'button.label.ar', message: 'Required' }], fields).summary).toEqual([
      {
        id: 'f-button-label-ar',
        message: 'Closing button, words on the link (Arabic): Required',
      },
    ]);
  });

  it('a slug list lands on its group', () => {
    expect(mapIssues([{ path: 'cardSlugs.1', message: 'Not a slug.' }], fields).byId).toEqual({
      'f-cardSlugs': 'Not a slug.',
    });
  });

  it('a section content accent stored as two numbers finds its one field', () => {
    const content = RESOURCE_UI['sections']!.fields.find((f) => f.kind === 'sectionContent')!;
    const mapped = mapIssues(
      [{ path: 'content.accentFromEn', message: 'Number must be less than or equal to 30' }],
      [{ name: 'type', label: 'Type', kind: 'select' }, content],
      'f',
      { type: 'hero' },
    );
    expect(mapped.byId).toEqual({
      'f-content-accentFrom-en-from': 'Number must be less than or equal to 30',
    });
    expect(mapped.summary[0]?.message).toContain('Highlighted words (English)');
  });
});
