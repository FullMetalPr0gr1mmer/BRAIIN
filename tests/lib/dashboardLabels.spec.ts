import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import QuickActionsDrawer from '@/components/admin/screens/dashboard/QuickActionsDrawer';
import RoleDefaultsModal from '@/components/admin/screens/dashboard/RoleDefaultsModal';

// The dashboard's two selects (Admin v2 U1): the quick-actions drawer's Icon and the preset
// modal's Role. A label wrapped around a select takes in every option's text, so the Icon
// select answered to "Link" as well as the Link field did (its options include "Link" and
// "Outside link"): a screen reader heard the options in its name, and the e2e's
// getByLabel('Link') matched two controls. Each select is named by a label beside it (for/id).

const drawer = renderToStaticMarkup(
  createElement(QuickActionsDrawer, {
    open: true,
    onClose: () => undefined,
    items: [],
    library: [],
    onSave: async () => true,
    onReset: async () => true,
  }),
);
const modal = renderToStaticMarkup(
  createElement(RoleDefaultsModal, {
    open: true,
    onClose: () => undefined,
    roles: [
      { role: 'admin', label: 'Admin', widgets: [], library: [] },
      { role: 'seo', label: 'SEO', widgets: [], library: [] },
    ],
    board: null,
    hidden: [],
    quick: [],
  }),
);

/** Every label's markup, from its start tag to its end tag. */
const labels = (html: string) =>
  [...html.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/g)].map((m) => m[0]);

describe.each([
  ['the quick-actions drawer', drawer, 'Icon'],
  ['the preset modal', modal, 'Role'],
])('%s', (_name, html, name) => {
  it('no label wraps a select', () => {
    expect(html).toContain('<select');
    expect(labels(html).filter((label) => label.includes('<select'))).toEqual([]);
  });

  it(`the select is named "${name}" by a label beside it`, () => {
    const id = /<select\b[^>]*\bid="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    const named = labels(html).filter((label) => label.includes(`for="${id}"`));
    expect(named.map((label) => label.replace(/<[^>]+>/g, ''))).toEqual([name]);
  });
});

it('the drawer has exactly one control answering to "Link": the link field', () => {
  // As Playwright's getByLabel('Link') reads it: a label's whole text, case-insensitive.
  const matching = labels(drawer).filter((label) =>
    label
      .replace(/<[^>]+>/g, '')
      .toLowerCase()
      .includes('link'),
  );
  expect(matching).toHaveLength(1);
  expect(matching[0]).toContain('placeholder="/admin/leads or https://"');
});
