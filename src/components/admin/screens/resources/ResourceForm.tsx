import EditorForm from '@/components/admin/fields/EditorForm';
import Note from '@/components/admin/kit/Note';
import SeoPanel from '@/components/admin/screens/seo/SeoPanel';
import type { SeoPanelSetup } from '@/components/admin/screens/seo/types';
import { visibleTabs, type SeoAccess } from '@/lib/admin/editorTabs';
import { saveModeFor } from '@/lib/admin/saveMode';
import { uiFor } from '@/lib/admin/uiSchema';
import { useEntitySave } from '@/lib/admin/useEntitySave';
import { EDGE_NOT_SYNCED } from './ResourceTable';

// The create/edit form for every CRUD resource, driven by RESOURCE_UI.
//
// ── The version field is the whole point of the save path ────────────────────────
// The form loads a row, remembers its `version`, and sends that back on save. If a
// colleague saved in between, the server answers 409 and this shows "someone else saved
// changes" rather than silently overwriting their work. Last-write-wins is the default
// behaviour of every naive CMS form and it loses data quietly — the author never finds
// out, and neither does the person whose paragraph vanished.
//
// Since Admin v2 F5a the save is useEntitySave's (src/lib/admin/useEntitySave.ts, the
// rules in the pure entitySave.ts) and the form is EditorForm's; this screen names what it
// edits. Kept as they were: a new record starts from the create schema's defaults; a
// create opens the record's edit screen, with `?edge=missed` when the edge snapshot missed
// it (redirects); an untouched datetime keeps its stored seconds; "Version N".
//
// Admin v2 U8b: a resource whose ResourceUi has `tabs` is drawn in tabs (EditorForm), its
// SEO tab (`panel: 'seo'`, for `ui.seoEntity`) the shared SeoPanel, set up on the server
// page (`seo`: loadSeoPanelSetup) and read-only for a role that only views SEO; a role
// that reads the resource without its write capability gets the form read-only
// (`readOnly`, the server page's canWriteResource). "Open on site" follows `ui.publicHref`.
// Every one of these is UX: the server decides every read and write.

export interface ResourceFormProps {
  resource: string;
  /** Row id, or `null` to create. */
  id: string | null;
  /**
   * F5b: "Advanced (JSON)" on a section's content is offered (decision D5 — the UX half
   * of `content.archiveDelete`, so no screen writes `role === 'admin'`). The page reads
   * it from the session; the server validates every save whatever this says.
   */
  canAdvanced?: boolean | undefined;
  /** U8b: the role reads this resource but lacks its write capability. */
  readOnly?: boolean | undefined;
  /** U8b: the tab to open on (the server's reading of `?tab=`, editorTabs.ts firstTab). */
  initialTab?: string | null | undefined;
  /** U8b: the role's access to the record's SEO (`seo.entityMeta`). */
  seoAccess?: SeoAccess | undefined;
  /** U8b: the SEO tab's setup, made on the server page; null for a new record. */
  seo?: SeoPanelSetup | null | undefined;
}

/** What a read-only role is told above the fields. */
export function readOnlyNoteFor(singular: string, seoAccess: SeoAccess, hasSeoTab: boolean) {
  const noun = singular.toLowerCase();
  return seoAccess === 'full' && hasSeoTab
    ? `You can read this ${noun}. Your role changes its SEO only.`
    : `You can read this ${noun}. Your role cannot change it.`;
}

export default function ResourceForm({
  resource,
  id,
  canAdvanced,
  readOnly = false,
  initialTab,
  seoAccess = 'none',
  seo = null,
}: ResourceFormProps) {
  const ui = uiFor(resource);
  const target = { kind: 'resource', slug: ui.slug } as const;
  const save = useEntitySave(target, id, { fields: ui.fields, mode: saveModeFor(target) });
  const tabs = ui.tabs ? visibleTabs(ui.tabs, { seoAccess }) : undefined;
  const hasSeoTab = Boolean(tabs?.some((t) => t.panel === 'seo'));
  const noun = ui.singular.toLowerCase();

  const seoPanel = !hasSeoTab ? undefined : seo ? (
    <SeoPanel
      target={seo.target}
      context={seo.context}
      readOnly={seoAccess !== 'full'}
      canAdvanced={seoAccess === 'full'}
    />
  ) : (
    <Note tone="info">
      {id
        ? `This ${noun}’s SEO could not be read. Reload the page to try again.`
        : `Save the ${noun} first. Its SEO can be added once it exists.`}
    </Note>
  );

  return (
    <EditorForm
      save={save}
      fields={ui.fields}
      submitLabel={save.isNew ? `Create ${noun}` : 'Save changes'}
      back={{ href: `/admin/${ui.slug}`, label: `Back to ${ui.title.toLowerCase()}` }}
      canAdvanced={canAdvanced}
      tabs={tabs}
      tabsLabel={`${ui.singular} editor`}
      panels={seoPanel ? { seo: seoPanel } : undefined}
      initialTab={initialTab}
      readOnly={readOnly}
      readOnlyNote={readOnly ? readOnlyNoteFor(ui.singular, seoAccess, hasSeoTab) : undefined}
      publicHref={ui.publicHref}
    >
      {/* A resource with an edge snapshot (redirects) reports `kvSynced` on every write.
          False is a committed row the public request path does not see yet, said with
          the maintenance panel's wording, and carried across the create → edit navigation
          as `?edge=missed` (the create response is gone once the page changes). */}
      {save.edgeMissed && (
        <p className="msg" data-kind="error" role="alert">
          {EDGE_NOT_SYNCED}
        </p>
      )}
    </EditorForm>
  );
}
