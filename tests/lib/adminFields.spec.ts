import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RESOURCE_UI, type FieldDef } from '@/lib/admin/uiSchema';

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

    const table = render(field, { values: {}, json: null }, { type: 'statistics' });
    expect(table).toContain('takes its content from its own table');

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
  });

  it('every field of every resource renders without throwing, with unique ids', () => {
    for (const [slug, ui] of Object.entries(RESOURCE_UI)) {
      const html = ui.fields.map((field) => render(field, undefined, { type: 'cta' })).join('');
      expect(html.length, slug).toBeGreaterThan(0);
      expectUniqueIds(html);
    }
  });
});
