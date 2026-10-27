import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from '@/components/admin/kit/Icon';
import Note from '@/components/admin/kit/Note';
import StatusBadge from '@/components/admin/kit/StatusBadge';
import EditorForm from '@/components/admin/fields/EditorForm';
import SeoPanel from '@/components/admin/screens/seo/SeoPanel';
import type { SeoPanelSetup } from '@/components/admin/screens/seo/types';
import { adminFetch, describeError } from '@/lib/admin/client';
import { deleteFromEditor } from '@/lib/admin/editorDelete';
import { visibleTabs, type SeoAccess } from '@/lib/admin/editorTabs';
import { saveModeFor } from '@/lib/admin/saveMode';
import { uiFor, type FieldDef } from '@/lib/admin/uiSchema';
import { useEntitySave, type EntitySave } from '@/lib/admin/useEntitySave';
import { MEDIA_VIEW_FIELDS, remapMediaErrors, setView, splitMedia } from './media';
import { projectName } from './model';
import { publishRequirements, requirementsSummary } from './publish';
import TestimonialsCard from './TestimonialsCard';
import { PROJECT_FIELDS, PROJECT_GROUPS, PROJECT_TABS } from './view';
import { historyTargetOf } from '@/lib/admin/historyTarget';

// A project's editor (Admin v2 U6, AV-15; the prototype's /projects/:slug): the
// AdminProjectEditor island at /admin/portfolio/[id] and /new. U8's EditorForm in tabs, Basics
// | Case study | Breakdown & gallery | SEO | Publishing (view.ts), with U9's cards.
//
// One save. The form edits the API's fields as ui/portfolio.ts declares them and useEntitySave
// sends them with the version it loaded: ONE PATCH, which the kernel's `persist` turns into
// ONE save_portfolio() call (the project, its services and its media in one transaction,
// 0022), or, with releases on, one staged change. The media controls (the hero banner, the
// final film, the breakdown, the gallery) are a view over the one `media` set (media.ts): the
// form shows the view, every change to a control is joined back into the set at once, and the
// server's errors about an item land on the control that holds it. Nothing else is sent.
//
// Decided on the server page from ROLE_CAPS and passed in (UX only; every route checks again):
//   write      portfolio.write: an editable form, the testimonial card; SEO reads the rest;
//   archive    content.archiveDelete: "Archived" offered, an archived project editable, and
//              Delete (editorDelete.ts; main's list row action, kept);
//   seoAccess  the SEO tab's (full, view, none) and its setup, read on the server.
// The Publishing tab lists what a publish needs (publish.ts), the poster's alt text read from
// the library; the server stays the gate.

type Row = Record<string, unknown>;

export interface ProjectEditorProps {
  id: string | null;
  write: boolean;
  archive: boolean;
  seoAccess: SeoAccess;
  initialTab: string | null;
  seo: SeoPanelSetup | null;
  /** A new project's starting values. */
  defaults?: Row | undefined;
}

/** The view over the save: the media set as its four controls (see the header). */
export function useProjectView(save: EntitySave): EntitySave {
  const media = save.values['media'];
  const { view, layout } = useMemo(() => splitMedia(media), [media]);
  const saved = save.saved['media'];
  const savedView = useMemo(() => splitMedia(saved).view, [saved]);
  // The set as it stands after the last change made here, so two changes in one event (a
  // field's blur and a press of Save) both land.
  const latest = useRef(media);
  latest.current = media;
  const set = useCallback(
    (name: string, value: unknown) => {
      if (!MEDIA_VIEW_FIELDS.has(name)) {
        save.set(name, value);
        return;
      }
      const next = setView(latest.current, name, value);
      latest.current = next;
      save.set('media', next);
    },
    [save.set],
  );
  const errors = useMemo(() => remapMediaErrors(save.errors, layout), [save.errors, layout]);
  return {
    ...save,
    values: { ...save.values, ...view },
    saved: { ...save.saved, ...savedView },
    errors,
    set,
  };
}

/** The form's fields: "Archived" only for a role that may archive (unless it already is). */
export function projectFields(
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

export default function ProjectEditor({
  id,
  write,
  archive,
  seoAccess,
  initialTab,
  seo,
  defaults,
}: ProjectEditorProps) {
  const ui = uiFor('portfolio');
  const target = { kind: 'resource', slug: ui.slug } as const;
  const save = useEntitySave(target, id, {
    fields: ui.fields,
    mode: saveModeFor(target),
    ...(defaults ? { defaults } : {}),
  });
  const viewSave = useProjectView(save);

  const stored = save.saved['status'];
  const archivedLock = id !== null && !archive && stored === 'archived';
  const readOnly = !write || archivedLock;
  const tabs = visibleTabs(PROJECT_TABS, { seoAccess });
  const hasSeo = tabs.some((t) => t.panel === 'seo');

  // The poster's row, for the publish requirements' alt text (as MediaField reads its own).
  const posterId =
    typeof save.values['posterMediaId'] === 'string' ? save.values['posterMediaId'] : '';
  const [poster, setPoster] = useState<Row | null>(null);
  useEffect(() => {
    setPoster(null);
    if (!posterId) return;
    const controller = new AbortController();
    adminFetch<Row>(`/api/admin/media/${posterId}`, { signal: controller.signal })
      .then(setPoster)
      .catch(() => setPoster(null));
    return () => controller.abort();
  }, [posterId]);
  const requirements = publishRequirements(viewSave.values, poster);

  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  async function remove() {
    if (id === null) return;
    setDeleting(true);
    setDeleteError('');
    try {
      const left = await deleteFromEditor({
        slug: ui.slug,
        id,
        singular: 'Project',
        name: projectName({ ...save.saved, id }),
        back: '/admin/portfolio',
        done: 'project-deleted',
        go: save.leave,
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
        ? 'This project’s SEO could not be read. Reload the page to try again.'
        : 'Save the project first. Its SEO can be added once it exists.'}
    </Note>
  );

  const note = !readOnly
    ? undefined
    : archivedLock
      ? 'This project is archived. Only an Admin can change it.'
      : seoAccess === 'full' && hasSeo
        ? 'You can read this project. Your role changes its SEO only.'
        : 'You can read this project. Your role cannot change it.';

  return (
    <EditorForm
      history={historyTargetOf(target, id)}
      save={viewSave}
      fields={projectFields(PROJECT_FIELDS, archive, stored)}
      groups={PROJECT_GROUPS}
      submitLabel={save.isNew ? 'Create project' : 'Save changes'}
      back={{ href: '/admin/portfolio', label: 'Back to projects' }}
      tabs={tabs}
      tabsLabel="Project editor"
      panels={seoPanel ? { seo: seoPanel } : undefined}
      tabExtras={{
        case:
          write && id !== null ? (
            <TestimonialsCard projectId={id} />
          ) : id === null ? (
            <Note tone="info">Save the project first. Quotes can be linked once it exists.</Note>
          ) : undefined,
        publishing: (
          <section className="card prj-reqs" aria-labelledby="prj-reqs-h">
            <h2 className="card-title" id="prj-reqs-h">
              Before it can be published
            </h2>
            <p className="admin-sub" aria-live="polite">
              {requirementsSummary(requirements)}
            </p>
            <ul className="prj-reqs__list">
              {requirements.map((req) => (
                <li key={req.id} data-met={req.met ? '' : undefined}>
                  <span className="prj-reqs__mark" aria-hidden="true">
                    {req.met ? '✓' : '•'}
                  </span>
                  <span>
                    {req.label}
                    <span className="visually-hidden">{req.met ? ': done' : ': to do'}</span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="admin-sub">The server checks these again when it publishes.</p>
          </section>
        ),
      }}
      initialTab={initialTab}
      readOnly={readOnly}
      readOnlyNote={note}
      publicHref={publicPath}
    >
      {!save.isNew && (
        <div className="prj-ed__bar">
          <StatusBadge status={typeof stored === 'string' ? stored : 'draft'} />
          {save.saved['isFeatured'] === true && (
            <span className="badge" data-tone="klein">
              Featured
            </span>
          )}
          {save.saved['isPlaceholder'] === true && (
            <span className="badge" data-tone="gray">
              Sample
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
  );
}

/** "Open on site": a published project's case study, as saved. */
function publicPath(values: Readonly<Row>): string | null {
  return values['status'] === 'published' && typeof values['slug'] === 'string' && values['slug']
    ? `/portfolio/${values['slug']}`
    : null;
}
