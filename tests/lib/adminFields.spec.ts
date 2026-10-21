import { readFileSync } from 'node:fs';
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

  it('media: a choose button; the picker is mounted on the first Choose (Admin v2 U4)', () => {
    const html = render(f({ name: 'posterId', label: 'Poster', kind: 'media' }), '');
    expect(html).toContain('No image chosen');
    expect(html).toContain('Choose…');
    // The buttons take the field's name from the group ("Poster, group, Choose…").
    expect(html).toContain('<legend class="field-legend">Poster</legend>');
    // The picker's dialog is not in the form's server HTML: it opens at the end of <body>
    // (BodyPortal), so Enter in its search box can never submit the form around it.
    expect(html).not.toContain('<dialog');
  });

  it('media: the picker is a native <dialog> named "<Label>: choose", with Use image', async () => {
    const { default: MediaPicker } = await import('@/components/admin/fields/media/MediaPicker');
    const html = renderToStaticMarkup(
      createElement(MediaPicker, {
        open: true,
        onClose: noop,
        onPick: noop,
        title: 'Poster: choose',
      }),
    );
    expect(html).toContain('<dialog');
    const titleId = /<h2 id="([^"]+)">Poster: choose<\/h2>/.exec(html)?.[1];
    expect(titleId).toBeTruthy();
    expect(html).toContain(`aria-labelledby="${titleId}"`);
    expect(html).toContain('Use image');
    expect(html).toContain('Search media');
    // Upload in place waits for the stats route to say the role and the Worker can take a
    // file; it is never in the first render, and `media.upload: false` keeps it off.
    expect(html).not.toContain('type="file"');
    expect(html).not.toMatch(/\sstyle=/);
  });

  it('media: `media.upload: false` reaches the picker, which then never offers Upload', () => {
    const field = readFileSync('src/components/admin/fields/MediaField.tsx', 'utf8');
    expect(field).toContain('upload={field.media?.upload !== false}');
    const picker = readFileSync('src/components/admin/fields/media/MediaPicker.tsx', 'utf8');
    expect(picker).toContain('const showUpload = upload && canUpload;');
    expect(picker).toMatch(/if \(!open \|\| !upload\) return;/);
    // The kit's sample field never writes (risk R9).
    const kit = readFileSync('src/components/admin/screens/kit/samples.ts', 'utf8');
    expect(kit).toContain("kind: 'media', media: { upload: false }");
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
    // "Advanced (JSON)" is Admin-only since F5b (decision D5).
    expect(typed).not.toContain('Advanced (JSON)');
    expect(
      renderToStaticMarkup(
        createElement(Field, {
          field,
          value: { values: {}, json: null },
          values: { type: 'cta' },
          onChange: noop,
          canAdvanced: true,
        }),
      ),
    ).toContain('Advanced (JSON)');
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

  it('multiline bilingual (U7): a five-row textarea per language, both still required', () => {
    const answer = f({
      name: 'answer',
      label: 'Answer',
      kind: 'bilingual',
      multiline: true,
      required: true,
    });
    const html = render(answer, { en: 'Answer first.', ar: '' });
    expect(html).toMatch(/<textarea rows="5" id="f-answer-en" lang="en"/);
    expect(html).toMatch(/<textarea rows="5" id="f-answer-ar" lang="ar" dir="rtl"/);
    expect(html).not.toContain('<input type="text" id="f-answer');
    // Unlike prose, the Arabic may not lag: it is counted as missing.
    expect(html).toContain('<span class="visually-hidden"> (missing)</span>');
    expect(html).not.toContain('Arabic not written yet');
    // Unset, a bilingual pair renders exactly as before (one-line inputs).
    expect(render(title, { en: 'Logo', ar: 'الشعار' })).not.toContain('<textarea');
    expectUniqueIds(html);
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
    // A stored value off the step is read out as stored, not as the step it is near.
    expect(
      render(
        f({
          name: 'intervalMs',
          label: 'Interval',
          kind: 'range',
          range: { min: 2000, max: 12000, step: 500, suffix: ' ms' },
        }),
        7250,
      ),
    ).toContain('<output for="f-intervalMs">7250 ms</output>');
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

describe('the rest of the field kit (Admin v2 F5b)', () => {
  const headline = { en: 'Ideas that leave the brain', ar: 'أفكار تغادر العقل الآن' };
  const accentRange = f({
    name: 'accent',
    label: 'Highlighted words',
    kind: 'accent',
    accent: { of: 'heading', mode: 'range' },
  });
  const accentFrom = f({
    name: 'accentFrom',
    label: 'Highlighted words',
    kind: 'accent',
    accent: { of: 'headline', mode: 'from', keys: { en: 'accentFromEn', ar: 'accentFromAr' } },
  });

  it('accent: a word picker per language, counted from 1, with a preview', () => {
    const html = render(
      accentRange,
      { en: { from: 2, to: 4 }, ar: { from: null, to: null } },
      { heading: headline },
    );
    expect(html).toContain('id="f-accent-en-from"');
    expect(html).toContain('id="f-accent-en-to"');
    // Words are numbered for a reader, and are the renderer's own tokens.
    expect(html).toContain('>1. Ideas</option>');
    expect(html).toContain('>5. brain</option>');
    expect(html).toContain('>No highlight</option>');
    // The preview marks exactly the chosen words.
    expect(html).toContain('<mark class="accentf__on">leave the</mark>');
    // The Arabic half is in the DOM, hidden, RTL, with no range chosen.
    expect(html).toContain('id="f-accent-ar-from"');
    expect(html).toContain('dir="rtl"');
    expect(html).not.toContain('id="f-accent-ar-to"'); // no start, no end picker
    expectUniqueIds(html);
    expect(html).not.toContain('style=');
  });

  it('accent: “from word N to the end” has no second picker', () => {
    const html = render(
      accentFrom,
      { en: { from: 1, to: null }, ar: { from: null, to: null } },
      { headline },
    );
    expect(html).toContain('id="f-accentFrom-en-from"');
    expect(html).not.toContain('id="f-accentFrom-en-to"');
    expect(html).toContain('<mark class="accentf__on">that leave the brain</mark>');
  });

  it('accent: no words yet, no picker — just what to do', () => {
    const html = render(accentRange, null, { heading: { en: '', ar: '' } });
    expect(html).toContain('Write the English words first');
    expect(html).not.toContain('<select');
  });

  it('accent: one stored without its heading is shown, kept, and removable (review H1)', () => {
    const sections = RESOURCE_UI['sections']!.fields;
    const content = sections.find((x) => x.kind === 'sectionContent')!;
    const slogan = rowToForm({ type: 'slogan', content: { accentFromEn: 2 } }, sections);
    const html = render(content, slogan['content'], { type: 'slogan' });
    const text = html.replace(/<[^>]*>/g, '');
    expect(text).toContain(
      'The colour is kept on from word 3 to the end of the heading the page shows now.',
    );
    expect(text).toContain('Remove the English highlight');
    expect(html).not.toContain('id="f-content-accentFrom-en-from"');
    // Nothing stored in Arabic: the usual cue.
    expect(text).toContain('Write the Arabic words first');

    const cta = rowToForm(
      { type: 'cta', content: { accent: { en: { from: 1, to: 3 } } } },
      sections,
    );
    expect(render(content, cta['content'], { type: 'cta' }).replace(/<[^>]*>/g, '')).toContain(
      'The colour is kept on words 2 to 3 of the heading the page shows now.',
    );
  });

  it('accent: the preview shows what the page shows, a kept range past the end included', () => {
    const value = rowToForm(
      { heading: { en: 'One two', ar: 'واحد اثنان' }, accent: { en: { from: 5 } } },
      [f({ name: 'heading', kind: 'bilingual' }), accentRange],
    )['accent'];
    const html = render(accentRange, value, { heading: { en: 'One two', ar: 'واحد اثنان' } });
    expect(html).not.toContain('accentf__on');
  });

  it('accent: an error lands on the picker it names', () => {
    const html = renderToStaticMarkup(
      createElement(Field, {
        field: accentRange,
        value: { en: { from: 40, to: null }, ar: { from: null, to: null } },
        values: { heading: headline },
        onChange: noop,
        errors: { 'f-accent-en-from': 'Pick a word that is in the heading.' },
      }),
    );
    expect(html).toMatch(/id="f-accent-en-from"[^>]*aria-invalid="true"/);
    expect(html).toContain('English: Pick a word that is in the heading.');
  });

  it('link: the words in both languages and a picker for where it goes', () => {
    const link = f({ name: 'button', label: 'Closing button', kind: 'link' });
    const html = render(link, { label: { en: 'See all', ar: 'شاهد الكل' }, href: '' });
    expect(html).toContain('id="f-button-label-en"');
    expect(html).toContain('id="f-button-label-ar"');
    expect(html).toContain('Where it goes');
    // The pages are asked for only when the picker is reached (the kit screen reads
    // nothing), so the server renders the empty picker beside the box that always holds
    // the value.
    expect(html).toContain('id="f-button-target"');
    expect(html).toContain('id="f-button-href"');
    expect(html).toContain('Pick a page…');
    expectUniqueIds(html);
    expect(html).not.toContain('style=');
  });

  it('link: an href the schema would refuse is marked, and said in words', () => {
    const link = f({ name: 'button', label: 'Closing button', kind: 'link' });
    const bad = render(link, { label: { en: '', ar: '' }, href: 'https://example.com' });
    expect(bad).toContain('value="https://example.com"');
    expect(bad).toMatch(/id="f-button-href"[^>]*aria-invalid="true"/);
    expect(bad).toContain('Use a page of this site');
    // Where the schema takes an external link, https is fine.
    const external = f({
      name: 'button',
      label: 'Closing button',
      kind: 'link',
      link: { external: true },
    });
    const ok = render(external, { label: { en: '', ar: '' }, href: 'https://example.com' });
    expect(ok).not.toMatch(/id="f-button-href"[^>]*aria-invalid="true"/);
  });

  it('link: an error lands on the box or the language it names', () => {
    const link = f({ name: 'button', label: 'Closing button', kind: 'link' });
    const html = renderToStaticMarkup(
      createElement(Field, {
        field: link,
        value: { label: { en: 'See all', ar: '' }, href: '/portfolio' },
        onChange: noop,
        errors: {
          'f-button-label-ar': 'Write it in Arabic too.',
          'f-button-href': 'Not a page of this site.',
        },
      }),
    );
    expect(html).toContain('Arabic: Write it in Arabic too.');
    expect(html).toContain('Not a page of this site.');
  });

  it('slugRelation: the chosen order, each with its slug, and move/remove that say what they do', () => {
    const cards = f({
      name: 'cardSlugs',
      label: 'The two cards beside it',
      kind: 'slugRelation',
      maxItems: 2,
      relation: { resource: 'portfolio', labelKey: 'title', valueKey: 'slug' },
    });
    const html = render(cards, ['hilton-rebrand', 'noon-campaign']);
    expect(html).toContain('<legend class="field-legend">The two cards beside it</legend>');
    expect(html).toContain('2 of 2');
    // No options loaded under renderToStaticMarkup: the slug stands in for the name.
    expect(html).toMatch(/aria-label="Move hilton-rebrand down"/);
    expect(html).toMatch(/aria-label="Remove noon-campaign"/);
    // ...and is then said once, not twice (a repeated slug is noise to a screen reader,
    // and two identical texts break a getByText in the kit e2e).
    expect(html.match(/>hilton-rebrand</g)).toHaveLength(1);
    expect(html).not.toContain('item-slug');
    expect(html).toContain('At most 2');
    expect(render(cards, [])).toContain('None chosen yet.');
    expectUniqueIds(html);
    expect(html).not.toContain('style=');
  });
});

describe('clip v2 (Admin v2 F5b)', () => {
  const clip = f({ name: 'clip', label: 'Hero clip', kind: 'clip', pathOnly: true });
  const state = (patch: Record<string, string>) => ({
    source: 'path',
    streamUid: '',
    path: '/media/showreel.mp4',
    startS: '',
    endS: '',
    ...patch,
  });

  it('the site file is picked from the registry, with its length', () => {
    const html = render(clip, state({}));
    expect(html).toContain('<select id="f-clip-path"');
    expect(html).toContain('showreel.mp4 (18.4 s)');
    // No Stream for a table with no Stream column (0028).
    expect(html).not.toContain('Stream UID');
    expectUniqueIds(html);
    expect(html).not.toContain('style=');
  });

  it('a window reads as what it is, drawn with SVG geometry', () => {
    const html = render(clip, state({ startS: '6.2', endS: '7.9' }));
    expect(html).toContain('6.2 s to 7.9 s of showreel.mp4 (18.4 s)');
    expect(html).toContain('<svg class="clipf__line"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toMatch(/<rect class="clipf__win" x="33\.\d+"/);
    // No window: the whole file, said in words.
    expect(render(clip, state({}))).toContain('The whole of showreel.mp4 (18.4 s)');
  });

  it('a window the schema would refuse is said before the save is', () => {
    expect(render(clip, state({ startS: '0', endS: '40' }))).toContain(
      'A clip plays at most 30 seconds.',
    );
    expect(render(clip, state({ startS: '17', endS: '19' }))).toContain(
      'The video ends at 18.4 s, so the end is past it.',
    );
  });

  it('the hint says it in plain words, without a dash (P-12)', () => {
    const text = render(clip, state({})).replace(/<[^>]*>/g, ' ');
    expect(text).toContain(
      'A window plays that part of the video on a loop, for at most 30 seconds.',
    );
    expect(text).not.toMatch(/[–—]/);
  });

  it('a stored path the site no longer has stays visible', () => {
    const html = render(clip, state({ path: '/media/gone.mp4' }));
    expect(html).toContain('/media/gone.mp4');
    // Nothing is claimed about a file whose length we do not know.
    expect(html).not.toContain('clipf__says');
  });
});

describe('section content prefilled with the built-in copy (Admin v2 F5b)', () => {
  const field = RESOURCE_UI['sections']!.fields.find((x) => x.kind === 'sectionContent')!;
  const builtIn = {
    tag: { en: 'Get in touch', ar: 'تواصل معنا' },
    heading: { en: 'Say hello', ar: 'قل مرحبا' },
    text: { en: 'We read everything.', ar: 'نقرأ كل شيء.' },
    buttonLabel: { en: 'Start a project', ar: 'ابدأ مشروعا' },
  };
  const render = (value: unknown, props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      createElement(Field, {
        field,
        value,
        values: { type: 'cta' },
        onChange: noop,
        builtIn,
        ...props,
      }),
    );

  it('a field with nothing of its own shows the words the page shows', () => {
    const html = render({ values: {}, json: null });
    expect(html).toContain('value="Say hello"');
    expect(html).toContain('value="Get in touch"');
    expect(html).toContain('Change one to make it yours');
    // Nothing to put back yet.
    expect(html).not.toContain('Reset to the built-in copy');
  });

  it('a field the editor wrote keeps their words, and Reset appears', () => {
    const html = render({
      values: { heading: { en: 'Our own words', ar: 'كلماتنا' } },
      json: null,
    });
    expect(html).toContain('value="Our own words"');
    // The others still show the built-in.
    expect(html).toContain('value="Get in touch"');
    expect(html).toContain('Reset to the built-in copy');
  });

  it('the Arabic left at the built-in under a changed English is said', () => {
    const html = render({
      values: { heading: { en: 'Our own words', ar: 'قل مرحبا' } },
      json: null,
    });
    expect(html).toContain('Arabic still shows the built-in text.');
    // Both changed: nothing to say.
    expect(
      render({ values: { heading: { en: 'Our own words', ar: 'كلماتنا' } }, json: null }),
    ).not.toContain('Arabic still shows the built-in text.');
  });

  it('an accent beside a prefilled heading counts its words (review M4)', () => {
    const html = render(
      { values: {}, json: null },
      {
        builtIn: {
          ...builtIn,
          heading: { en: 'Say hello there', ar: 'قل مرحبا هنا' },
          accent: { en: { from: 1 }, ar: { from: 1 } },
        },
      },
    );
    expect(html).toContain('value="Say hello there"');
    expect(html).toContain('id="f-content-accent-en-from"');
    expect(html).toContain('<mark class="accentf__on">hello there</mark>');
    expect(html).not.toContain('Write the English words first');
  });

  it('its notes say it without a dash (P-12)', () => {
    const sections = RESOURCE_UI['sections']!.fields;
    const plain = (html: string) => html.replace(/<[^>]*>/g, ' ');
    const notes = [
      render({ values: {}, json: null }),
      renderToStaticMarkup(
        createElement(Field, {
          field,
          value: { values: {}, json: null },
          values: { type: 'cta' },
          onChange: noop,
        }),
      ),
      renderToStaticMarkup(
        createElement(Field, {
          field,
          value: rowToForm({ type: 'team', content: {} }, sections)['content'],
          values: { type: 'team' },
          onChange: noop,
        }),
      ),
    ].map(plain);
    expect(notes[1]).toContain('Every field is optional. Leave one empty');
    expect(notes[2]).toContain('so there is nothing to override here.');
    for (const text of notes) expect(text).not.toMatch(/[–—]/);
  });

  it('with no built-in known, the field reads as it did before', () => {
    const html = renderToStaticMarkup(
      createElement(Field, {
        field,
        value: { values: {}, json: null },
        values: { type: 'cta' },
        onChange: noop,
      }),
    );
    expect(html).toContain('Leave one empty to keep the built-in copy');
    expect(html).not.toContain('Reset to the built-in copy');
  });
});
