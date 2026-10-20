import type { EditorTabDef, FieldDef, ResourceUi } from './uiSchema';

// Tabbed editors (Admin v2 U8b): the pure rules EditorForm draws its tabs by, so the tests
// can hold them without a browser. Browser code, in the field kit's chunk (admin-fields,
// astro.config.mjs ADMIN_FIELDS): only an editor loads it.
//
//   fieldOfId       which field an element id belongs to (`f-<name>` or `f-<name>-…`: the
//                   ids FormField gives a field's controls, its halves and its items);
//   tabOfElement    which tab holds that field (an error link or "Next gap" asks for an
//                   element in a hidden tab, and the editor switches to it first);
//   tabsWithErrors  the tabs that hold a field with an error (their tab says so);
//   visibleTabs     the tabs a role is offered: a panel tab needs its panel's access;
//   firstTab        the tab the editor opens on: the address's `?tab=` when it is one of
//                   them, else the SEO tab for a role that may only change SEO, else the first;
//   validateTabs    what a ResourceUi's tabs must hold (tests/lib/editorTabs.spec.ts runs it
//                   over every resource): every field in exactly one field tab, ids of
//                   lowercase words and hyphens, unique, a panel tab only with `seoEntity`.

/** Access to the record's SEO, from `seo.entityMeta`: full, view or none. */
export type SeoAccess = 'full' | 'view' | 'none';

const ID_PREFIX = 'f';

/** The name of the field an element id belongs to, or null (the longest name that fits). */
export function fieldOfId(id: string, fields: readonly Pick<FieldDef, 'name'>[]): string | null {
  let found: string | null = null;
  for (const field of fields) {
    const own = `${ID_PREFIX}-${field.name}`;
    if ((id === own || id.startsWith(`${own}-`)) && (!found || field.name.length > found.length)) {
      found = field.name;
    }
  }
  return found;
}

/** The field tab holding the element `id`, or null (not a field of this form). */
export function tabOfElement(
  id: string,
  tabs: readonly EditorTabDef[],
  fields: readonly Pick<FieldDef, 'name'>[],
): string | null {
  const name = fieldOfId(id, fields);
  if (!name) return null;
  return tabs.find((tab) => tab.fields?.includes(name))?.id ?? null;
}

/** The tabs holding a field with an error (errors by element id, fieldErrors.ts). */
export function tabsWithErrors(
  errorsById: Readonly<Record<string, string | undefined>>,
  tabs: readonly EditorTabDef[],
  fields: readonly Pick<FieldDef, 'name'>[],
): Set<string> {
  const out = new Set<string>();
  for (const [id, message] of Object.entries(errorsById)) {
    if (!message) continue;
    const tab = tabOfElement(id, tabs, fields);
    if (tab) out.add(tab);
  }
  return out;
}

/** The tabs a role is offered: a panel tab needs the panel's access (SEO: view or full). */
export function visibleTabs(
  tabs: readonly EditorTabDef[],
  { seoAccess = 'none' }: { seoAccess?: SeoAccess } = {},
): EditorTabDef[] {
  return tabs.filter((tab) => tab.panel !== 'seo' || seoAccess !== 'none');
}

/**
 * The tab an editor opens on: the requested one (the address's `?tab=`) when offered;
 * else, for a role that reads the record but may change only its SEO, the SEO tab (what it
 * came to do); else the first.
 */
export function firstTab(
  tabs: readonly EditorTabDef[],
  requested: string | null | undefined,
  { readOnly = false, seoAccess = 'none' }: { readOnly?: boolean; seoAccess?: SeoAccess } = {},
): string {
  const offered = visibleTabs(tabs, { seoAccess });
  const asked = offered.find((tab) => tab.id === requested);
  if (asked) return asked.id;
  if (readOnly && seoAccess === 'full') {
    const seo = offered.find((tab) => tab.panel === 'seo');
    if (seo) return seo.id;
  }
  return offered[0]?.id ?? '';
}

const TAB_ID = /^[a-z]+(?:-[a-z]+)*$/;

/**
 * The field names the shared SEO editor (SeoPanel) gives its controls, ids `f-<name>…` like
 * the record's own. With the SEO tab mounted both forms are on the page, so a resource field
 * of one of these names would repeat an element id (and an error link would reach the wrong
 * field): validateTabs refuses it. tests/lib/editorTabs.spec.ts holds this list to
 * seoPanelFields().
 */
export const SEO_PANEL_FIELD_NAMES = [
  'metaTitle',
  'metaDescription',
  'ogMediaId',
  'ogImage',
  'robots',
  'canonicalOverride',
  'schemaType',
] as const;

/** What is wrong with a resource's tabs; empty when they are sound (or it has none). */
export function validateTabs(
  ui: Pick<ResourceUi, 'fields' | 'tabs' | 'seoEntity' | 'slug'>,
): string[] {
  const tabs = ui.tabs;
  if (!tabs) return [];
  const problems: string[] = [];
  const seen = new Set<string>();
  const placed = new Map<string, string>();
  const names = new Set(ui.fields.map((field) => field.name));
  for (const tab of tabs) {
    if (!TAB_ID.test(tab.id))
      problems.push(`${ui.slug}: tab id "${tab.id}" is not lowercase words`);
    if (seen.has(tab.id)) problems.push(`${ui.slug}: tab "${tab.id}" twice`);
    seen.add(tab.id);
    if (tab.panel && tab.fields) problems.push(`${ui.slug}: tab "${tab.id}" is a panel and fields`);
    if (!tab.panel && !tab.fields) problems.push(`${ui.slug}: tab "${tab.id}" holds nothing`);
    if (tab.panel === 'seo' && !ui.seoEntity) {
      problems.push(`${ui.slug}: tab "${tab.id}" mounts SEO without seoEntity`);
    }
    if (tab.panel === 'seo') {
      for (const name of SEO_PANEL_FIELD_NAMES) {
        if (names.has(name)) problems.push(`${ui.slug}: "${name}" repeats an SEO panel field's id`);
      }
    }
    for (const name of tab.fields ?? []) {
      if (!names.has(name)) problems.push(`${ui.slug}: tab "${tab.id}" names no field "${name}"`);
      const already = placed.get(name);
      if (already) problems.push(`${ui.slug}: "${name}" is in "${already}" and "${tab.id}"`);
      placed.set(name, tab.id);
    }
  }
  for (const name of names) {
    if (!placed.has(name)) problems.push(`${ui.slug}: "${name}" is in no tab`);
  }
  return problems;
}
