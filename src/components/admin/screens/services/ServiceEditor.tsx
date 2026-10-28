import { useState } from 'react';
import Icon from '@/components/admin/kit/Icon';
import Note from '@/components/admin/kit/Note';
import StatusBadge, { Badge } from '@/components/admin/kit/StatusBadge';
import { ClockProvider } from '@/components/admin/kit/clock';
import EditorForm from '@/components/admin/fields/EditorForm';
import SeoPanel from '@/components/admin/screens/seo/SeoPanel';
import type { SeoPanelSetup } from '@/components/admin/screens/seo/types';
import { adminFetch, describeError } from '@/lib/admin/client';
import { stagedUrl } from '@/lib/admin/releaseEvents';
import { confirmDialog } from '@/lib/admin/confirm';
import { deleteFromEditor } from '@/lib/admin/editorDelete';
import { visibleTabs, type SeoAccess } from '@/lib/admin/editorTabs';
import { formToPayload } from '@/lib/admin/formPayload';
import { saveModeFor } from '@/lib/admin/saveMode';
import { uiFor, type EditorPanel, type FieldDef } from '@/lib/admin/uiSchema';
import { useEntitySave } from '@/lib/admin/useEntitySave';
import { duplicatePayload, leadsCount, nameOf, type Row } from './model';
import ServiceCasePanel from './ServiceCasePanel';
import ServiceLeadsPanel, { type ServiceLeadRow } from './ServiceLeadsPanel';
import { historyTargetOf } from '@/lib/admin/historyTarget';

// A service's editor (Admin v2 U5, AV-14; the prototype's route('/services/:cat/:slug')): the
// AdminServiceEditor island at /admin/services/[id] and /new. U8's EditorForm in tabs, Content
// | Case study | SEO | Leads | Publishing (ui/services.ts), saved by useEntitySave with the
// version it loaded (a 409 keeps the work), drawn with U9's cards in the Content tab. Decided
// on the server page from ROLE_CAPS and passed in (UX only; every route checks again):
//   write      services.write: an editable form, Duplicate and the case study's form; without
//              it (SEO) the content is read-only and the SEO tab is where it works;
//   archive    content.archiveDelete: "Archived" offered, an archived service editable, and
//              Delete (editorDelete.ts; main's list row action, kept); anyone else reads an
//              archived service, since the archive gate refuses their save;
//   seoAccess  the SEO tab's (full, view, none) and its setup, read on the server;
//   leads      leads.manage: the Leads tab (its rows read on the server) and the "N leads".
// Duplicate posts a draft copy of the service AS SAVED (its slug suffixed, "(copy)" after the
// English name, right after it in its discipline; the case study is not copied), then opens
// the copy. The status line above the fields says where the service stands.

export interface ServiceEditorProps {
  id: string | null;
  write: boolean;
  archive: boolean;
  seoAccess: SeoAccess;
  leads: boolean;
  initialTab: string | null;
  seo: SeoPanelSetup | null;
  /** The Leads tab's rows (leads holders only), or null when not read. */
  leadRows: { rows: ServiceLeadRow[]; more: boolean } | null;
  leadsFailed: boolean;
  /** How many leads named it (leads holders only), or null. */
  leadCount: number | null;
  /** A new service's starting values (the discipline it is added to). */
  defaults?: Record<string, unknown> | undefined;
  /** The studio's zone, for the dates the Leads tab prints in the server's HTML. */
  tz: string;
  /**
   * R12b: a create page in release mode (the server page's createReleaseMode, from the
   * shell's flag). The create then carries the marker, so a page left open across a
   * switch-off is refused (409 `releases-off`), never written live. Only a create uses it: a
   * saved record's mode is its own answer's.
   */
  releaseMode?: boolean | undefined;
}

/** The form's fields: "Archived" only for a role that may archive (unless it already is). */
export function serviceFields(
  fields: readonly FieldDef[],
  archive: boolean,
  status: unknown,
): FieldDef[] {
  return fields.map((field) =>
    field.name === 'status' && !archive && status !== 'archived' && field.options
      ? { ...field, options: field.options.filter((o) => o.value !== 'archived') }
      : field,
  );
}

interface ListResponse {
  rows: Row[];
}

export default function ServiceEditor({
  id,
  write,
  archive,
  seoAccess,
  leads,
  initialTab,
  seo,
  leadRows,
  leadsFailed,
  leadCount,
  defaults,
  tz,
  releaseMode = false,
}: ServiceEditorProps) {
  const ui = uiFor('services');
  const target = { kind: 'resource', slug: ui.slug, staged: releaseMode } as const;
  const save = useEntitySave(target, id, {
    fields: ui.fields,
    mode: saveModeFor(target),
    ...(defaults ? { defaults } : {}),
  });
  const [copying, setCopying] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  const stored = save.saved['status'];
  const archivedLock = id !== null && !archive && stored === 'archived';
  const readOnly = !write || archivedLock;
  const offered: EditorPanel[] = [
    ...(write ? ['case' as const] : []),
    ...(leads ? ['leads' as const] : []),
  ];
  const tabs = visibleTabs(ui.tabs ?? [], { seoAccess, panels: offered });
  const hasSeo = tabs.some((t) => t.panel === 'seo');

  async function duplicate() {
    if (id === null) return;
    if (save.dirty) {
      const go = await confirmDialog({
        message:
          'The copy is made from the saved version. Your unsaved changes stay here, not in the copy.',
        confirmLabel: 'Duplicate',
        danger: false,
      });
      if (!go) return;
    }
    setCopying(true);
    setCopyError('');
    try {
      const list = await adminFetch<ListResponse>('/api/admin/services?limit=100');
      const taken = new Set((list.rows ?? []).map((row) => String(row['slug'] ?? '')));
      const payload = duplicatePayload(formToPayload(save.saved, ui.fields), taken);
      // R12b: in draft mode the copy is made from the pending change, so it says so: once
      // releases are switched off (the change perhaps thrown away) it is refused, never live.
      const created = await adminFetch<Row>(
        stagedUrl('/api/admin/services', save.mode === 'draft'),
        {
          method: 'POST',
          body: payload,
        },
      );
      window.location.href = `/admin/services/${String(created['id'])}`;
    } catch (err) {
      setCopyError(`It was not copied. ${describeError(err)}`);
      setCopying(false);
    }
  }

  async function remove() {
    if (id === null) return;
    setDeleting(true);
    setDeleteError('');
    try {
      const left = await deleteFromEditor({
        slug: ui.slug,
        id,
        singular: 'Service',
        name: nameOf({ ...save.saved, id }),
        back: '/admin/services',
        done: 'service-deleted',
        go: save.leave,
        staged: save.mode === 'draft',
      });
      if (!left) setDeleting(false);
    } catch (err) {
      setDeleteError(`It was not deleted. ${describeError(err)}`);
      setDeleting(false);
    }
  }

  const seoPanel = !hasSeo ? undefined : seo ? (
    <SeoPanel
      target={seo.target}
      context={seo.context}
      readOnly={seoAccess !== 'full'}
      canAdvanced={seoAccess === 'full'}
    />
  ) : (
    <Note tone="info">
      {id
        ? 'This service’s SEO could not be read. Reload the page to try again.'
        : 'Save the service first. Its SEO can be added once it exists.'}
    </Note>
  );
  const casePanel =
    id !== null ? (
      <ServiceCasePanel serviceId={id} write={write} archive={archive} />
    ) : (
      <Note tone="info">Save the service first. Its case study can be added once it exists.</Note>
    );
  const leadsPanel =
    id !== null ? (
      <ServiceLeadsPanel leads={leadRows} failed={leadsFailed} />
    ) : (
      <Note tone="info">A new service has no leads yet.</Note>
    );

  const note = !readOnly
    ? undefined
    : archivedLock
      ? 'This service is archived. Only an Admin can change it.'
      : seoAccess === 'full' && hasSeo
        ? 'You can read this service. Your role changes its SEO only.'
        : 'You can read this service. Your role cannot change it.';

  return (
    <ClockProvider tz={tz}>
      <EditorForm
        history={historyTargetOf(target, id)}
        save={save}
        fields={serviceFields(ui.fields, archive, stored)}
        groups={ui.groups}
        submitLabel={save.isNew ? 'Create service' : 'Save changes'}
        back={{ href: '/admin/services', label: 'Back to services' }}
        tabs={tabs}
        tabsLabel="Service editor"
        panels={{
          ...(seoPanel ? { seo: seoPanel } : {}),
          case: casePanel,
          leads: leadsPanel,
        }}
        initialTab={initialTab}
        readOnly={readOnly}
        readOnlyNote={note}
        publicHref={ui.publicHref}
      >
        {!save.isNew && (
          <div className="svc-ed__bar">
            <StatusBadge status={typeof stored === 'string' ? stored : 'draft'} />
            {leadCount !== null && <Badge tone="klein">{leadsCount(leadCount)}</Badge>}
            {write && !archivedLock && (
              <button
                type="button"
                className="btn"
                data-variant="ghost"
                disabled={copying}
                onClick={() => void duplicate()}
              >
                <Icon name="copy" size={14} />
                Duplicate
              </button>
            )}
            {copyError && (
              <span className="msg" data-kind="error" role="alert">
                {copyError}
              </span>
            )}
            {archive && (
              <button
                type="button"
                className="btn"
                data-variant="danger"
                disabled={deleting}
                onClick={() => void remove()}
              >
                <Icon name="trash" size={14} />
                Delete
              </button>
            )}
            {deleteError && (
              <span className="msg" data-kind="error" role="alert">
                {deleteError}
              </span>
            )}
          </div>
        )}
      </EditorForm>
    </ClockProvider>
  );
}
