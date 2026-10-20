import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { FieldDef } from '@/lib/admin/uiSchema';

// The relation pickers' words once their options have arrived (Admin v2 U8b made the post
// editor's Author and Category relations): the empty option is words, never a dash (README
// P-12). The options load in an effect, which renderToStaticMarkup never runs, so the hook is
// stood in for here with the answer it gives once loaded (or while loading).

const state = vi.hoisted(() => ({ loading: false }));
vi.mock('@/components/admin/fields/useOptions', () => ({
  useOptions: () => ({
    options: [
      { value: 'a', label: 'Alya' },
      { value: 'b', label: 'Basel' },
    ],
    error: '',
    loading: state.loading,
  }),
}));

const { default: RelationField } = await import('@/components/admin/fields/RelationField');

const DASHES = /[–—]/;
const author: FieldDef = {
  name: 'authorId',
  label: 'Author',
  kind: 'relation',
  relation: { resource: 'team', labelKey: 'name', filter: { status: 'published' } },
};
const services: FieldDef = {
  name: 'serviceIds',
  label: 'Services',
  kind: 'multiRelation',
  maxItems: 3,
  relation: { resource: 'services', labelKey: 'title' },
};

const render = (field: FieldDef, value: unknown) =>
  renderToStaticMarkup(createElement(RelationField, { field, value, onChange: () => undefined }));

describe('RelationField’s empty option (P-12)', () => {
  it('a single relation offers "Not set", then the options', () => {
    state.loading = false;
    for (const field of [author, { ...author, required: true }]) {
      const html = render(field, '');
      expect(html).toContain('<option value="" selected="">Not set</option>');
      expect(html).toContain('<option value="a">Alya</option>');
      expect(html).not.toMatch(DASHES);
    }
  });

  it('a multi relation’s picker offers "Not set", and says the limit when full', () => {
    state.loading = false;
    const open = render(services, ['a']);
    expect(open).toMatch(/<option value="" selected="">Not set<\/option>/);
    expect(open).not.toMatch(DASHES);
    const full = render({ ...services, maxItems: 1 }, ['a']);
    expect(full).toContain('At most 1');
    expect(full).not.toMatch(DASHES);
  });

  it('while the options load, both say so, without a dash', () => {
    state.loading = true;
    for (const html of [render(author, ''), render(services, [])]) {
      expect(html).toContain('Loading…');
      expect(html).not.toMatch(DASHES);
    }
    state.loading = false;
  });
});
