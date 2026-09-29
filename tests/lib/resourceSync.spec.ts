import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RESOURCE_UI } from '@/lib/admin/uiSchema';

// The "Sync to edge" control (Round 3, item A): a resource that declares `syncAction`
// renders the button and its status line, and every other resource renders neither.
// Effects (the GET of the counts) do not run under renderToStaticMarkup — the endpoint
// itself is covered by tests/lib/redirectResource.spec.ts.

vi.mock('@/components/admin/RichText', () => ({ default: () => null }));

const { default: ResourceTable, EDGE_NOT_SYNCED } =
  await import('@/components/admin/ResourceTable');

const render = (resource: string) =>
  renderToStaticMarkup(createElement(ResourceTable, { resource }));

describe('ResourceTable — sync to edge', () => {
  it('redirects declare the sync action against the sync endpoint', () => {
    expect(RESOURCE_UI['redirects']?.syncAction).toEqual({
      endpoint: '/api/admin/redirects/sync',
      label: 'Sync to edge',
    });
  });

  it('renders the button and a status line for a resource with a sync action', () => {
    const html = render('redirects');
    expect(html).toContain('>Sync to edge<');
    expect(html).toMatch(/data-sync[^>]*>/);
    expect(html).toContain('aria-live="polite"');
  });

  it('renders no sync control for every other resource', () => {
    for (const [slug, ui] of Object.entries(RESOURCE_UI)) {
      if (ui.syncAction) continue;
      expect(render(slug), slug).not.toContain('Sync to edge');
    }
  });

  it('the not-synced wording tells the operator the site is serving the previous rules', () => {
    // The maintenance panel's message, adapted: the row is committed, the edge is not.
    expect(EDGE_NOT_SYNCED).toMatch(/^Saved to the database, but the edge did not pick it up/);
    expect(EDGE_NOT_SYNCED).toContain('Sync to edge');
  });

  it('every redirect field carries help text (the rules are refusals the editor must understand)', () => {
    for (const field of RESOURCE_UI['redirects']!.fields) {
      expect(field.help, field.name).toBeTruthy();
    }
  });
});
