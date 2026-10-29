import type { SeoPanelSetup } from '@/components/admin/screens/seo/types';
import type { SeoAccess } from '@/lib/admin/editorTabs';
import type { VisibilityModeKey } from '@/lib/admin/visibilityCopy';

// The page editor's shapes in the browser (Admin v2 E1). The server page builds them
// (src/lib/admin/pages/editor.ts, server only: it reads the built-in copy, which must never
// ship in the admin bundle, F6) and hands them to the AdminPageEditor island as props.

type Row = Record<string, unknown>;
export type Bi = { en: string; ar: string };

/** What the signed-in role may do here, from ROLE_CAPS (UX only: every route checks again). */
export interface PageEditorAccess {
  /** `pages.write` in full (Admin, Content Creator): the sections and the page details. */
  sections: boolean;
  /** `content.archiveDelete` (Admin): delete a section, and "Advanced (JSON)" (F5b D5). */
  remove: boolean;
  /** `content.publish` (Admin, Content Creator): Publish, with releases on. */
  publish: boolean;
  /** `seo.entityMeta`: full edits the page's SEO, view reads it, none has no SEO drawer. */
  seo: SeoAccess;
  /** `maintenance.manage` (Admin): the way to the page's visibility setting. */
  visibility: boolean;
  /**
   * The screens of the sections' link rows this role opens (its menu's, nav reachableHrefs):
   * a row naming any other is drawn without its link.
   */
  opens: readonly string[];
}

/** The page the editor opens on, as the server read it. */
export interface PageEditorPage {
  id: string;
  slug: string;
  title: Bi;
  status: string;
  /** The English public path, or null when no route renders the page. */
  path: string | null;
  /**
   * Whether the live preview (R9's route) renders that path in English and Arabic (E2): the
   * server decides it with R9's own map, which the editor's first load does not carry.
   */
  previewable: boolean;
  visibility: VisibilityModeKey;
}

/**
 * The built-in copy of every look of every section type, in content shape, with each type's
 * `notVerbatim` fields left out (F5b's contract for the `builtIn` prop): by type, then by
 * look (the key F6's builtInLook gives, which library.ts's lookKey restates).
 */
export type BuiltInLooks = Readonly<Record<string, Readonly<Record<string, Row>>>>;

export interface PageEditorSetup {
  page: PageEditorPage;
  access: PageEditorAccess;
  builtIns: BuiltInLooks;
  /** The SEO drawer's setup (U10's loadSeoPanelSetup), or null when the role has none. */
  seo: SeoPanelSetup | null;
}
