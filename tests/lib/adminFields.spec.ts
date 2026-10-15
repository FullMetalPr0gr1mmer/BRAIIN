import { describe, it, expect, vi } from 'vitest';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RESOURCE_UI, type FieldDef } from '@/lib/admin/uiSchema';
import { rowToForm } from '@/lib/admin/formPayload';

// The Tiptap editor is irrelevant here and heavy in node.
vi.mock('@/components/admin/RichText', () => ({ default: () => null }));

const { Field } = await import('@/components/admin/FormField');

// Server-renders every field kind the admin has — the new composite ones especially — so
// a component that throws while rendering, or renders an input without a label, fails
// here rather than in front of an editor. Effects (option loading, the media fetch) do
// not run under renderToStaticMarkup; their shaping is tested in formPayload.spec.ts.

const noop = () => undefined;
const render = (field: FieldDef, value: unknown, values: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(Field, { field, value, onChange: noop, values }));

/** Every id in the markup is unique (label[for] must point at exactly one control). */
function expectUniqueIds(html: string) {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  expect(new Set(ids).size, `duplicate ids: ${ids.join(', ')}`).toBe(ids.length);
}

const f = (field: Partial<FieldDef> & Pick<FieldDef, 'name' | 'kind'>): FieldDef => ({
  label: field.name,
  ...field,
});

describe('admin field kinds render', () => {
  it('relation: a labelled select that keeps a stored id selectable', () => {
    const html = render(
      f({
        name: 'pageId',
        label: 'Page',
        kind: 'relation',
        required: true,
        relation: { resource: 'pages', labelKey: 'title' },
      }),
      '11111111-1111-4111-8111-111111111111',
    );
    expect(html).toContain('<select id="f-pageId"');
    expect(html).toContain('Page *');
    expect(html).toContain('11111111-1111-4111-8111-111111111111');
  });

  it('multiRelation: the chosen order, with move/remove buttons that say what they do', () => {
    const html = render(
      f({
        name: 'ids',
        label: 'Services',
        kind: 'multiRelation',
        relation: { resource: 'services', labelKey: 'title' },
      }),
      ['a', 'b'],
    );
    expect(html).toContain('<legend class="field-legend">Services</legend>');
    expect(html).toMatch(/aria-label="Move a down"/);
    expect(html).toMatch(/aria-label="Remove b"/);
    // Adding is an explicit button, never a side effect of moving through the select.
    expect(html).toContain('Add to Services');
    expect(html).toMatch(/<button type="button" class="btn" disabled="">Add<\/button>/);
  });

  it('multiSelect: one checkbox per option, checked from the value', () => {
    const html = render(
      f({
        name: 'skills',
        kind: 'multiSelect',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
      }),
      ['b'],
    );
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html.match(/checked=""/g)).toHaveLength(1);
  });

  it('media: a choose button and a native <dialog> picker', () => {
    const html = render(f({ name: 'posterId', label: 'Poster', kind: 'media' }), '');
    expect(html).toContain('No image chosen');
    expect(html).toContain('<dialog');
    expect(html).toContain('aria-label="Poster: choose"');
    // The buttons take the field's name from the group ("Poster, group, Choose…").
    expect(html).toContain('<legend class="field-legend">Poster</legend>');
  });

  it('repeater: nested fields with ids unique per item', () => {
    const rep = f({
      name: 'columns',
      label: 'Column',
      kind: 'repeater',
      maxItems: 2,
      itemFields: [f({ name: 'title', label: 'Title', kind: 'bilingual' })],
    });
    const html = render(rep, [{ title: { en: 'A', ar: 'أ' } }, {}]);
    expect(html).toContain('Column 1');
    expect(html).toContain('Column 2');
    expect(html).toContain('At most 2'); // the add button says why it is disabled
    expectUniqueIds(html);
  });

  it('object (Round 3): its fields, labelled, with ids under the object’s name, no add/remove', () => {
    const rating = f({
      name: 'rating',
      label: 'Rating line',
      kind: 'object',
      required: true,
      help: 'Text only.',
      itemFields: [
        f({ name: 'value', label: 'Rating as shown', kind: 'text', required: true }),
        f({ name: 'label', label: 'Label after it', kind: 'bilingual', required: true }),
      ],
    });
    const html = render(rating, { value: '4.8 / 5', label: { en: 'avg', ar: 'متوسط' } });
    expect(html).toContain('Rating line *');
    expect(html).toContain('Rating as shown');
    expect(html).toContain('id="f-rating-value"');
    expect(html).toContain('id="f-rating-label-en"');
    expect(html).toContain('value="4.8 / 5"');
    expect(html).toContain('Text only.');
    expect(html).not.toContain('Remove');
    expect(html).not.toContain('Add ');
    expect(html).not.toContain('Move up');
    expectUniqueIds(html);
    // nothing stored: still renders every input, empty
    expect(render(rating, null)).toContain('id="f-rating-value"');
  });

  it('clip: shows only the chosen source, and its window', () => {
    const clip = f({ name: 'clip', label: 'Clip', kind: 'clip' });
    const none = render(clip, { source: '', streamUid: '', path: '', startS: '', endS: '' });
    expect(none).not.toContain('Start (seconds)');
    const path = render(clip, {
      source: 'path',
      streamUid: '',
      path: '/media/a.mp4',
      startS: '1',
      endS: '5',
    });
    expect(path).toContain('/media/a.mp4');
    expect(path).toContain('Start (seconds)');
    expect(path).not.toContain('Stream UID');
    expectUniqueIds(path);
  });

  it('sectionContent: the typed editor for the sibling type, JSON when asked, a note for table-backed types', () => {
    const field = RESOURCE_UI['sections']!.fields.find((x) => x.kind === 'sectionContent')!;
    const typed = render(
      field,
      { values: { heading: { en: 'Hi', ar: 'أهلاً' } }, json: null },
      { type: 'cta' },
    );
    expect(typed).toContain('Button label');
    expect(typed).toContain('Advanced (JSON)');
    expectUniqueIds(typed);

    const json = render(field, { values: {}, json: '{"intro":true}' }, { type: 'hero' });
    expect(json).toContain('Content JSON');

    // What a LOADED table-backed section actually produces (not a hand-built state).
    const sections = RESOURCE_UI['sections']!.fields;
    const loaded = rowToForm({ type: 'team', content: {} }, sections)['content'];
    const table = render(field, loaded, { type: 'team' });
    expect(table).toContain('takes its content from its own table');
    expect(table).not.toContain('Content JSON');

    const none = render(field, { values: {}, json: null }, {});
    expect(none).toContain('Choose a section type');
  });

  it('upload: a labelled file input honouring accept', () => {
    const html = render(
      f({
        name: 'cv',
        label: 'CV',
        kind: 'upload',
        upload: { endpoint: '/api/admin/media/upload', accept: '.pdf' },
      }),
      '',
    );
    expect(html).toContain('type="file"');
    expect(html).toContain('accept=".pdf"');
    const attached = render(
      f({ name: 'cv', label: 'CV', kind: 'upload', upload: { endpoint: '/x', accept: '.pdf' } }),
      '11111111-1111-4111-8111-111111111111',
      {},
    );
    // Remove says WHICH file field it clears.
    expect(attached).toMatch(/aria-describedby="[^"]*-cv-label"[^>]*>Remove file/);
  });

  it('every field of every resource renders without throwing, with unique ids', () => {
    // One React root per form, as EditorForm renders it: since F5a a repeater's Sortable
    // instructions carry a useId() id, which React keeps unique within a root (separate
    // roots would each start the same sequence, a collision no browser ever sees).
    for (const [slug, ui] of Object.entries(RESOURCE_UI)) {
      const html = renderToStaticMarkup(
        createElement(
          Fragment,
          null,
          ...ui.fields.map((field) =>
            createElement(Field, {
              key: field.name,
              field,
              value: undefined,
              onChange: noop,
              values: { type: 'cta' },
            }),
          ),
        ),
      );
      expect(html.length, slug).toBeGreaterThan(0);
      expectUniqueIds(html);
    }
  });
});

describe('the field kit v2 (Admin v2 F5a)', () => {
  const title = f({ name: 'title', label: 'Service name', kind: 'bilingual', required: true });

  it('bilingual: both inputs in the DOM under the pinned ids, the Arabic one RTL, one hidden', () => {
    const html = render(title, { en: 'Logo', ar: 'الشعار' });
    expect(html).toMatch(/<input type="text" id="f-title-en" lang="en"[^>]*value="Logo"/);
    expect(html).toMatch(
      /<input type="text" id="f-title-ar" lang="ar" dir="rtl"[^>]*value="الشعار"/,
    );
    // English is shown first; the Arabic half is in the DOM, hidden.
    expect(html).toMatch(
      /<div class="bi__half" hidden="">\s*<div class="bi__h"><label for="f-title-ar"/,
    );
    // The group is named by its label; the EN | AR switch by "<Label> language".
    expect(html).toContain('<legend id="f-title-legend" class="field-legend">Service name');
    // Each input is named by the group's label and its language (review L14).
    expect(html).toContain('aria-labelledby="f-title-legend f-title-en-lang"');
    expect(html).toContain('<label for="f-title-ar" id="f-title-ar-lang"');
    expect(html).toContain('<legend class="visually-hidden">Service name language</legend>');
    expectUniqueIds(html);
  });

  it('the required star is seen, the word "required" is heard', () => {
    const html = render(title, { en: '', ar: '' });
    expect(html).toContain(
      'Service name <span class="req" aria-hidden="true">*</span><span class="visually-hidden"> required</span>',
    );
    expect(html).toContain('aria-required="true"');
  });

  it('a required pair with no Arabic names the AR option "Arabic (missing)"', () => {
    const missing = render(title, { en: 'Logo', ar: '' });
    expect(missing).toContain(
      'Arabic<span class="seg__cue" aria-hidden="true"></span><span class="visually-hidden"> (missing)</span>',
    );
    // Written: no cue.
    expect(render(title, { en: 'Logo', ar: 'الشعار' })).not.toContain('(missing)');
    // An optional pair left wholly blank is not a gap; English without Arabic is.
    const optional = f({ name: 'intro', label: 'Intro', kind: 'bilingual' });
    expect(render(optional, { en: '', ar: '' })).not.toContain('(missing)');
    expect(render(optional, { en: 'Hi', ar: '' })).toContain('(missing)');
  });

  it('prose lets the Arabic lag, with a neutral line', () => {
    const blurb = f({ name: 'blurb', label: 'Tagline', kind: 'prose' });
    const html = render(blurb, { en: 'Brands that last', ar: '' });
    expect(html).toContain('Arabic not written yet');
    expect(html).not.toContain('(missing)');
    expect(html).toContain('<textarea id="f-blurb-ar" lang="ar" dir="rtl"');
  });

  it('a counter in the label row for a field with maxLength', () => {
    const short = f({ name: 'metaTitle', label: 'Title tag', kind: 'text', maxLength: 60 });
    const html = render(short, 'Logo design');
    expect(html).toContain('<span class="f__meta">11/60</span>');
    expect(html).toContain('maxLength="60"');
  });

  it('inline errors: aria-invalid, the message linked by aria-describedby', () => {
    const html = renderToStaticMarkup(
      createElement(Field, {
        field: title,
        value: { en: 'Logo', ar: '' },
        onChange: noop,
        errors: { 'f-title-ar': 'Required' },
      }),
    );
    expect(html).toMatch(
      /id="f-title-ar"[^>]*aria-invalid="true"[^>]*aria-describedby="f-title-ar-error"/,
    );
    expect(html).toContain(
      '<p id="f-title-ar-error" class="field-error f__err">Arabic: Required</p>',
    );
    const slug = renderToStaticMarkup(
      createElement(Field, {
        field: f({ name: 'slug', label: 'Slug', kind: 'slug', help: 'The page address.' }),
        value: 'x',
        onChange: noop,
        errors: { 'f-slug': 'Taken' },
      }),
    );
    expect(slug).toMatch(
      /<input id="f-slug"[^>]*aria-invalid="true" aria-describedby="f-slug-hint f-slug-error"/,
    );
    expect(slug).toContain('<p id="f-slug-error" class="field-error f__err">Taken</p>');
  });

  it('checkbox is a switch: a button, role switch, aria-checked, named by its label', () => {
    const html = render(f({ name: 'visible', label: 'Visible', kind: 'checkbox' }), true);
    expect(html).toContain('<label for="f-visible" id="f-visible-label">Visible</label>');
    expect(html).toMatch(
      /<button type="button" role="switch" id="f-visible" aria-checked="true" aria-labelledby="f-visible-label"/,
    );
    expect(render(f({ name: 'visible', label: 'Visible', kind: 'checkbox' }), false)).toContain(
      'aria-checked="false"',
    );
  });

  it('color: a picker, the hex as text, swatches pressed by value and painted by SVG', () => {
    const html = render(
      f({
        name: 'tint',
        label: 'Tint',
        kind: 'color',
        color: { swatches: ['#0024BC', '#22a9ff'], contrastWith: '#FFFFFF' },
      }),
      '#0024BC',
    );
    expect(html).toContain('type="color"');
    expect(html).toContain('value="#0024bc"');
    expect(html).toMatch(/<input id="f-tint" type="text" class="in--mono"[^>]*value="#0024BC"/);
    expect(html).toMatch(/aria-label="#0024BC" aria-pressed="true"/);
    expect(html).toMatch(/aria-label="#22A9FF" aria-pressed="false"/);
    expect(html).toContain(
      '<rect x="1" y="1" width="24" height="24" rx="6" fill="#0024BC"></rect>',
    );
    expect(html).toMatch(/White text on it: \d+\.\d:1, passes AA\./);
  });

  it('range: a slider with its value read out in an <output for>', () => {
    const html = render(
      f({
        name: 'intervalMs',
        label: 'Interval',
        kind: 'range',
        range: { min: 2000, max: 12000, step: 500, suffix: ' ms' },
      }),
      6000,
    );
    expect(html).toMatch(
      /<input id="f-intervalMs" type="range" min="2000" max="12000" step="500"[^>]*value="6000"/,
    );
    expect(html).toContain('<output for="f-intervalMs">6000 ms</output>');
  });

  it('tags and chips: each chip removable by name; at the most, the box is disabled', () => {
    const tags = render(f({ name: 'tags', label: 'Tags', kind: 'tags', maxItems: 2 }), [
      'hero',
      'logo',
    ]);
    expect(tags).toContain('aria-label="Remove tag hero"');
    expect(tags).toContain('aria-label="Remove tag logo"');
    expect(tags).toMatch(
      /<input id="f-tags" type="text"[^>]*disabled=""[^>]*placeholder="At most 2"/,
    );
    expect(tags).toContain('At most 2.');
    const chips = render(
      f({ name: 'keywords', label: 'Keywords', kind: 'chips', chips: { bilingual: true } }),
      { en: ['brand'], ar: ['هوية'] },
    );
    expect(chips).toContain('id="f-keywords-en"');
    expect(chips).toMatch(/<input id="f-keywords-ar" type="text" lang="ar" dir="rtl"/);
    expect(chips).toContain('aria-label="Remove tag هوية"');
    expectUniqueIds(chips);
  });

  it('repeater v2: a handle, Move buttons and Remove per item, named for it', () => {
    const rep = f({
      name: 'valuePoints',
      label: 'Value we add',
      kind: 'repeater',
      itemFields: [f({ name: 'title', label: 'Title', kind: 'bilingual' })],
    });
    const html = render(rep, [{ title: { en: 'Faster', ar: 'أسرع' } }, {}]);
    expect(html).toContain('aria-label="Reorder Faster"');
    expect(html).toContain('aria-label="Move Faster up"');
    expect(html).toContain('aria-label="Move Value we add 2 down"');
    expect(html).toContain('aria-label="Remove value we add 2"');
    expect(html).toContain('aria-label="Collapse Value we add 2"');
    expect(html).toContain('id="f-valuePoints-0-title-en"');
    expect(html).toContain('id="f-valuePoints-1-title-ar"');
    expect(html).toContain('<span class="f__meta">2 items</span>');
    expectUniqueIds(html);
  });

  it('media v2: the alt-text badge says what is missing', async () => {
    const { altGap } = await import('@/components/admin/fields/MediaField');
    expect(altGap({ id: 'm', alt: { en: 'A frame', ar: '' } })).toBe('No Arabic alt');
    expect(altGap({ id: 'm', alt: { en: '', ar: '' } })).toBe('No alt text');
    expect(altGap({ id: 'm', alt: { en: 'A', ar: 'ب' } })).toBeNull();
    expect(altGap({ id: 'm' })).toBeNull();
  });

  it('no field renders a style attribute (CSP: style-src has no unsafe-inline)', () => {
    const kinds: FieldDef[] = [
      title,
      f({ name: 'blurb', label: 'Tagline', kind: 'prose' }),
      f({ name: 'visible', label: 'Visible', kind: 'checkbox' }),
      f({ name: 'tint', label: 'Tint', kind: 'color', color: { swatches: ['#0024BC'] } }),
      f({ name: 'n', label: 'N', kind: 'range', range: { min: 0, max: 10, step: 1 } }),
      f({ name: 'tags', label: 'Tags', kind: 'tags' }),
      f({ name: 'k', label: 'K', kind: 'chips', chips: { bilingual: true } }),
      f({ name: 'body', label: 'Body', kind: 'richtext' }),
      f({ name: 'posterId', label: 'Poster', kind: 'media' }),
      f({
        name: 'items',
        label: 'Item',
        kind: 'repeater',
        itemFields: [f({ name: 'title', label: 'Title', kind: 'bilingual' })],
      }),
    ];
    const values: Record<string, unknown> = {
      tint: '#0024BC',
      n: 3,
      tags: ['a'],
      k: { en: ['a'], ar: ['ب'] },
      items: [{}],
    };
    for (const field of kinds) {
      expect(render(field, values[field.name]), field.kind).not.toMatch(/\sstyle=/);
    }
    for (const ui of Object.values(RESOURCE_UI)) {
      for (const field of ui.fields) expect(render(field, undefined)).not.toMatch(/\sstyle=/);
    }
  });
});

describe('every field shows its own error (F5a review L5, L6, L12)', () => {
  const withError = (field: FieldDef, value: unknown, errors: Record<string, string>) =>
    renderToStaticMarkup(createElement(Field, { field, value, onChange: noop, errors }));

  it('a whole bilingual pair: on the group, read as its description', () => {
    const html = withError(
      f({ name: 'title', label: 'Service name', kind: 'bilingual' }),
      { en: '', ar: '' },
      { 'f-title': 'Write both languages.' },
    );
    expect(html).toMatch(/<fieldset id="f-title"[^>]*aria-describedby="f-title-error"/);
    expect(html).toContain(
      '<p id="f-title-error" class="field-error f__err">Write both languages.</p>',
    );
  });

  it('a relation, under the idPrefix it is rendered with', () => {
    const relation = f({
      name: 'disciplineId',
      label: 'Discipline',
      kind: 'relation',
      relation: { resource: 'disciplines', labelKey: 'name' },
    });
    const html = renderToStaticMarkup(
      createElement(Field, {
        field: relation,
        value: '',
        onChange: noop,
        idPrefix: 'f-items-0',
        errors: { 'f-items-0-disciplineId': 'Choose one.' },
      }),
    );
    expect(html).toMatch(
      /<select id="f-items-0-disciplineId"[^>]*aria-invalid="true" aria-describedby="f-items-0-disciplineId-error"/,
    );
    expect(html).toContain('Choose one.');
  });

  it('an object, a clip, section content and an upload: the group or the box, marked', () => {
    const object = withError(
      f({
        name: 'rating',
        label: 'Rating line',
        kind: 'object',
        itemFields: [f({ name: 'value', label: 'Value', kind: 'text' })],
      }),
      {},
      { 'f-rating': 'Give both parts.' },
    );
    expect(object).toMatch(
      /<fieldset id="f-rating" tabindex="-1"[^>]*aria-describedby="f-rating-error"/,
    );
    expect(object).toContain('Give both parts.');

    const clip = withError(
      f({ name: 'clip', label: 'Hero clip', kind: 'clip' }),
      { source: 'path', streamUid: '', path: '/media/a.mp4', startS: '1', endS: '40' },
      { 'f-clip-end': 'At most 30 seconds.', 'f-clip': 'Check the window.' },
    );
    expect(clip).toMatch(
      /id="f-clip-end"[^>]*aria-invalid="true" aria-describedby="f-clip-end-error"/,
    );
    expect(clip).toContain(
      '<p id="f-clip-end-error" class="field-error f__err">At most 30 seconds.</p>',
    );
    expect(clip).toMatch(/<fieldset id="f-clip" tabindex="-1"/);
    expect(clip).toContain('Check the window.');

    const content = RESOURCE_UI['sections']!.fields.find((x) => x.kind === 'sectionContent')!;
    const section = renderToStaticMarkup(
      createElement(Field, {
        field: content,
        value: { values: {}, json: null },
        values: { type: 'cta' },
        onChange: noop,
        errors: { 'f-content': 'Unrecognized key.' },
      }),
    );
    expect(section).toMatch(/<fieldset id="f-content" tabindex="-1"/);
    expect(section).toContain('Unrecognized key.');

    const upload = withError(
      f({ name: 'cv', label: 'CV', kind: 'upload', upload: { endpoint: '/x', accept: '.pdf' } }),
      '',
      { 'f-cv': 'Too large.' },
    );
    expect(upload).toMatch(/id="f-cv"[^>]*aria-invalid="true" aria-describedby="f-cv-error"/);
    expect(upload).toContain('Too large.');
  });

  it('a whole repeater: on its group', () => {
    const html = withError(
      f({
        name: 'steps',
        label: 'Step',
        kind: 'repeater',
        itemFields: [f({ name: 'title', label: 'Title', kind: 'text' })],
      }),
      [],
      { 'f-steps': 'At most 4.' },
    );
    expect(html).toMatch(/<fieldset id="f-steps" tabindex="-1"/);
    expect(html).toContain('<p id="f-steps-error" class="field-error f__err">At most 4.</p>');
  });
});
