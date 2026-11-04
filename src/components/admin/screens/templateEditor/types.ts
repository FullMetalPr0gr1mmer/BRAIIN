import type { TemplateKind } from '@schemas/templateCopyKeys';

// The template editors' shapes in the browser (Admin v2 E3). The server page builds them
// (src/lib/admin/pages/templates.ts, server only: it reads the items under the person's RLS and
// the built-in shared text, which must never ship in the admin bundle, F6) and hands them to
// the AdminTemplateEditor island as props.

export type Bi = { en: string; ar: string };

/** One service or project the picker offers. */
export interface TemplateItem {
  id: string;
  slug: string;
  title: Bi;
  status: string;
  /** Its page's English path (`/services/logo`). */
  path: string;
  /** Whether R9's preview renders that path in both languages (E2's rule, decided server-side). */
  previewable: boolean;
}

/** The picker's groups: services by discipline (an `<optgroup>` each), projects one flat list. */
export interface TemplateItemGroup {
  /** The group's label (a discipline's English name), or null for the flat list. */
  label: string | null;
  items: TemplateItem[];
}

/** What the role may do here, from ROLE_CAPS (UX only: every route checks again). */
export interface TemplateEditorAccess {
  /** The item's own words: `services.write` / `portfolio.write` in full. */
  item: boolean;
  /** The shared text: `pages.write` in full. */
  shared: boolean;
}

export interface TemplateEditorSetup {
  kind: TemplateKind;
  groups: TemplateItemGroup[];
  /** The item shown first (the address's `?item=`, else the first published one), or null. */
  selected: string | null;
  /** The template's built-in shared text, key by key (src/lib/templates/copy.ts). */
  builtIn: Readonly<Record<string, unknown>>;
  access: TemplateEditorAccess;
}
