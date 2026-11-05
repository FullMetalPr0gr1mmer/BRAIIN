import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RESOURCES } from '@/lib/admin/resources';
import { stagedEntry } from '@/lib/release/staged';
import { uiFor, type FieldDef } from '@/lib/admin/uiSchema';
import { COLLECTIONS } from '@/components/admin/screens/collection/collections';
import { isItemSchedule, isLifecycleStatus } from '@/components/admin/fields/VisibilityField';

vi.mock('@/components/admin/RichText', () => ({ default: () => null }));

const { default: ResourceForm } = await import('@/components/admin/screens/resources/ResourceForm');
const { default: ServiceEditor } =
  await import('@/components/admin/screens/services/ServiceEditor');
const { default: ProjectEditor } =
  await import('@/components/admin/screens/projects/ProjectEditor');
const { default: CollectionDrawer } =
  await import('@/components/admin/screens/collection/CollectionDrawer');

// Admin v2 R14b §4 on the real create screens, not a hand-made save: every create page in
// release mode (its SaveTarget `staged`, R12b) draws the release form, "Visible on the site"
// for the status and no per-item schedule; releases off, it draws main's select and schedule.
// tests/lib/editorForm.spec.ts holds the rule on EditorForm alone.
//
// The rehearsal on c09daaed (E2E_RELEASES=on) failed "a new post": the switch WAS drawn, in
// the Publishing tab's panel, which a create opening on Content leaves `hidden`. A hidden
// panel is out of the accessibility tree, so the e2e's role query counted 0 while its CSS
// locators (the select, the schedule) counted the hidden panel's controls. The product was
// right; the e2e now opens the tab first. Both halves are held here.

const CREATE_PAGES = 'src/pages/admin';

/** The create pages that hand a ResourceForm `releaseMode` (createReleaseMode), by slug. */
function resourceFormCreates(): string[] {
  return Object.keys(RESOURCES)
    .filter((slug) => {
      try {
        const page = readFileSync(`${CREATE_PAGES}/${slug}/new.astro`, 'utf8');
        return page.includes('AdminResourceForm') && page.includes('createReleaseMode');
      } catch {
        return false;
      }
    })
    .sort();
}

const lifecycle = (fields: readonly FieldDef[]) => fields.some(isLifecycleStatus);
const scheduled = (fields: readonly FieldDef[]) => fields.some(isItemSchedule);

// The status switch (VisibilityField): a `status` that is not the content lifecycle (a
// redirect's HTTP status) stays a select, and a resource's own "Visible on the site" field (a
// client's `visible`) is another control, so both are matched by the status's own id.
const STATUS_SWITCH =
  /<label for="f-status" id="f-status-label">Visible on the site<\/label><\/div><button type="button" role="switch" id="f-status" aria-checked="false"/;
const STATUS_SELECT = /<select id="f-status"/;

/** The release form: no lifecycle select, no schedule, the switch (when the record has one). */
function expectReleaseForm(html: string, fields: readonly FieldDef[]) {
  expect(html).not.toContain('id="f-scheduledFor"');
  if (lifecycle(fields)) {
    expect(html).not.toMatch(STATUS_SELECT);
    expect(html).toMatch(STATUS_SWITCH);
  }
}

/** Main's form: the select and the schedule as the resource declares them, no switch. */
function expectLiveForm(html: string, fields: readonly FieldDef[]) {
  expect(html).not.toMatch(STATUS_SWITCH);
  if (lifecycle(fields)) expect(html).toMatch(STATUS_SELECT);
  if (scheduled(fields)) expect(html).toContain('id="f-scheduledFor"');
}

/** The tab panel (`data-editor-tab`) holding the control `id`, and whether it is hidden. */
function panelOf(html: string, id: string): { tab: string; hidden: boolean } | null {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) return null;
  const open = html.lastIndexOf('<div role="tabpanel"', at);
  if (open < 0) return null;
  const tag = html.slice(open, html.indexOf('>', open));
  const tab = /data-editor-tab="([^"]+)"/.exec(tag)?.[1];
  return tab ? { tab, hidden: tag.includes('hidden=""') } : null;
}

const render = (element: ReactElement) => renderToStaticMarkup(element);

describe('R14b: a create in release mode draws the release form, on every create screen', () => {
  const slugs = resourceFormCreates();

  it('finds the release-managed ResourceForm creates (the list this file walks)', () => {
    // A create page outside the release (the Style-Finder's) passes createReleaseMode false
    // without asking; it is still walked, and must stay main's in both renders.
    expect(slugs).toEqual(
      expect.arrayContaining(['blog', 'categories', 'disciplines', 'navigation', 'sections']),
    );
    expect(slugs.length).toBeGreaterThanOrEqual(8);
    // Not vacuous: most of them, and most collections, carry the lifecycle status.
    const withStatus = (list: string[]) => list.filter((slug) => lifecycle(uiFor(slug).fields));
    expect(withStatus(slugs).length).toBeGreaterThanOrEqual(5);
    expect(withStatus(Object.values(COLLECTIONS).map((d) => d.slug)).length).toBeGreaterThanOrEqual(
      4,
    );
  });

  it.each(resourceFormCreates())('/admin/%s/new', (slug) => {
    const ui = uiFor(slug);
    const managed = stagedEntry(RESOURCES[slug]!) !== undefined;
    const on = render(
      createElement(ResourceForm, { resource: slug, id: null, releaseMode: managed }),
    );
    const off = render(
      createElement(ResourceForm, { resource: slug, id: null, releaseMode: false }),
    );
    if (managed) expectReleaseForm(on, ui.fields);
    else expectLiveForm(on, ui.fields);
    expectLiveForm(off, ui.fields);
  });

  it('/admin/services/new and /admin/portfolio/new (their own editors)', () => {
    const service = (releaseMode: boolean) =>
      render(
        createElement(ServiceEditor, {
          id: null,
          write: true,
          archive: true,
          seoAccess: 'full',
          leads: false,
          initialTab: null,
          seo: null,
          leadRows: null,
          leadsFailed: false,
          leadCount: null,
          defaults: { status: 'draft' },
          tz: 'Asia/Riyadh',
          releaseMode,
        }),
      );
    const project = (releaseMode: boolean) =>
      render(
        createElement(ProjectEditor, {
          id: null,
          write: true,
          archive: true,
          seoAccess: 'full',
          initialTab: null,
          seo: null,
          defaults: { status: 'draft' },
          releaseMode,
        }),
      );
    for (const [draw, fields] of [
      [service, uiFor('services').fields],
      [project, uiFor('portfolio').fields],
    ] as const) {
      expect(lifecycle(fields)).toBe(true);
      expect(scheduled(fields)).toBe(true);
      expectReleaseForm(draw(true), fields);
      expectLiveForm(draw(false), fields);
    }
  });

  it.each(Object.keys(COLLECTIONS).sort())('the %s collection’s Add drawer', (slug) => {
    const def = COLLECTIONS[slug]!;
    const fields = uiFor(def.slug).fields;
    const drawer = (staged: boolean) =>
      render(
        createElement(CollectionDrawer, {
          def,
          id: null,
          listed: null,
          permissions: { write: true, remove: true },
          staged,
          defaults: { status: 'draft' },
          onClose: () => undefined,
          onCreated: () => undefined,
          onSaved: () => undefined,
          onDeleted: () => undefined,
        }),
      );
    expectReleaseForm(drawer(true), fields);
    expectLiveForm(drawer(false), fields);
  });
});

describe('the rehearsal’s "a new post": the switch is in a hidden tab until it is opened', () => {
  it('a new post opens on Content; the switch is drawn in the hidden Publishing panel', () => {
    const html = render(
      createElement(ResourceForm, { resource: 'blog', id: null, releaseMode: true }),
    );
    expect(panelOf(html, 'f-status')).toEqual({ tab: 'publishing', hidden: true });
    expect(panelOf(html, 'f-title-en') ?? panelOf(html, 'f-slug')).toEqual({
      tab: 'content',
      hidden: false,
    });
  });

  it('so the e2e opens the Publishing tab before it asks for the switch by its role', () => {
    const source = readFileSync('tests/admin/releases-ui.e2e.ts', 'utf8');
    const start = source.indexOf("test.describe('releases on, as admin: a new post'");
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf('test.describe(', start + 1));
    const tabClick = block.indexOf("getByRole('tab', { name: 'Publishing', exact: true })");
    const roleQuery = block.indexOf("getByRole('switch', { name: 'Visible on the site' })");
    expect(tabClick).toBeGreaterThan(-1);
    expect(roleQuery).toBeGreaterThan(tabClick);
    expect(block.slice(tabClick, roleQuery)).toContain('.click()');
  });
});
