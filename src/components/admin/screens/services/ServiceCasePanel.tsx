import { useCallback, useEffect, useState } from 'react';
import EmptyState from '@/components/admin/kit/EmptyState';
import Icon from '@/components/admin/kit/Icon';
import Note from '@/components/admin/kit/Note';
import EditorForm from '@/components/admin/fields/EditorForm';
import { adminFetch, describeError } from '@/lib/admin/client';
import { saveModeFor } from '@/lib/admin/saveMode';
import { toast } from '@/lib/admin/toast';
import { uiFor, type FieldDef } from '@/lib/admin/uiSchema';
import { useEntitySave } from '@/lib/admin/useEntitySave';
import { textOf, type Row } from './model';

// A service's Case study tab (Admin v2 U5, AV-14; the prototype's case tab): the service's
// `service_cases` row (one per service, the 0028 key) in a form of its own, with its own
// Save and version, beside the service's form (which stays mounted, hidden, so this form's
// ids take another prefix: EditorForm `idPrefix`). The linked project's client and sector are
// shown read-only (they are the project's), with a card of what the block shows. A design
// sample says so, and how to make it real: write the real words, switch off the Placeholder
// box and save. A service with no case yet offers "Add a case study" to the roles that write
// services. The server decides every read and write (services.write; the archive gate and the
// 0025 placeholder guard hold for this row as for any).

const CASE_PREFIX = 'fc';

interface ListResponse {
  rows: Row[];
}

export interface ServiceCasePanelProps {
  serviceId: string;
  write: boolean;
  archive: boolean;
}

export default function ServiceCasePanel({ serviceId, write, archive }: ServiceCasePanelProps) {
  const [caseId, setCaseId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await adminFetch<ListResponse>(
        `/api/admin/service-cases?limit=1&service_id=${encodeURIComponent(serviceId)}`,
      );
      setCaseId(data.rows?.[0]?.id ?? null);
      setError('');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoaded(true);
    }
  }, [serviceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!loaded) return <p className="admin-sub">Loading…</p>;
  if (error) {
    return (
      <p className="msg" data-kind="error" role="alert">
        {`The case study could not be read. ${error}`}
      </p>
    );
  }
  if (!caseId && !creating) {
    return (
      <EmptyState
        icon="briefcase"
        title="No case study yet"
        text="The service page shows its case study under the deliverables."
      >
        {write && (
          <button type="button" className="btn" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} />
            Add a case study
          </button>
        )}
      </EmptyState>
    );
  }
  return (
    <CaseForm
      key={caseId ?? 'new'}
      caseId={caseId}
      serviceId={serviceId}
      write={write}
      archive={archive}
      onCreated={(row) => {
        toast('Case study created.', 'ok');
        setCreating(false);
        setCaseId(String(row['id']));
      }}
    />
  );
}

/** The case form's fields: never the service (it is this one), Archived only for Admin. */
export function caseFields(
  fields: readonly FieldDef[],
  archive: boolean,
  status: unknown,
): FieldDef[] {
  return fields
    .filter((field) => field.name !== 'serviceId')
    .map((field) =>
      field.name === 'status' && !archive && status !== 'archived' && field.options
        ? { ...field, options: field.options.filter((o) => o.value !== 'archived') }
        : field,
    );
}

interface CaseFormProps {
  caseId: string | null;
  serviceId: string;
  write: boolean;
  archive: boolean;
  onCreated: (row: Record<string, unknown>) => void;
}

function CaseForm({ caseId, serviceId, write, archive, onCreated }: CaseFormProps) {
  const ui = uiFor('service-cases');
  const target = { kind: 'resource', slug: 'service-cases' } as const;
  const save = useEntitySave(target, caseId, {
    fields: ui.fields,
    mode: saveModeFor(target),
    defaults: { serviceId, status: 'draft', isPlaceholder: false },
    onCreated,
  });
  const status = save.saved['status'];
  const sample = save.saved['isPlaceholder'] === true;
  const readOnly = !write || (!archive && status === 'archived');
  const projectId = typeof save.values['portfolioId'] === 'string' ? save.values['portfolioId'] : '';

  return (
    <div className="svc-case">
      <EditorForm
        save={save}
        fields={caseFields(ui.fields, archive, status)}
        submitLabel={caseId ? 'Save case study' : 'Create case study'}
        idPrefix={CASE_PREFIX}
        readOnly={readOnly}
        readOnlyNote={
          readOnly
            ? status === 'archived' && write
              ? 'This case study is archived. Only an Admin can change it.'
              : 'You can read this case study. Your role cannot change it.'
            : undefined
        }
        after={<ProjectCard projectId={projectId} title={save.values['title']} />}
      >
        {sample && (
          <Note tone="warn">
            This is a design sample. Write the real words, switch off “Placeholder (design
            sample)” and save to make it real. Until then it cannot be published.
          </Note>
        )}
      </EditorForm>
    </div>
  );
}

/** The linked project, as the block shows it: its picture, the headline, the client. */
function ProjectCard({ projectId, title }: { projectId: string; title: unknown }) {
  const [projects, setProjects] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!projectId || projects !== null) return;
    const controller = new AbortController();
    adminFetch<ListResponse>('/api/admin/portfolio?limit=100', { signal: controller.signal })
      .then((data) => setProjects(data.rows ?? []))
      .catch((err) => {
        if (!controller.signal.aborted) setError(describeError(err));
      });
    return () => controller.abort();
  }, [projectId, projects]);

  if (!projectId) {
    return (
      <section className="card svc-case__pv" aria-labelledby="svc-case-pv">
        <h2 className="card-title" id="svc-case-pv">
          Preview
        </h2>
        <p className="admin-sub">Choose the linked project: its picture and client show here.</p>
      </section>
    );
  }
  const project = projects?.find((row) => row.id === projectId) ?? null;
  const thumb =
    project && typeof project['poster_thumb_url'] === 'string' ? project['poster_thumb_url'] : null;
  const client = project ? textOf(project['client_name']) : '';
  const sector = project ? textOf(project['sector_name']) : '';
  const confidential = project?.['client_visible'] === false;
  return (
    <section className="card svc-case__pv" aria-labelledby="svc-case-pv">
      <h2 className="card-title" id="svc-case-pv">
        Preview
      </h2>
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      {projects === null && !error && <p className="admin-sub">Loading…</p>}
      {projects !== null && !project && (
        <p className="admin-sub">The linked project was not found.</p>
      )}
      {project && (
        <figure className="svc-case__card">
          <span className="svc-case__poster">
            {thumb ? (
              <img src={thumb} alt="" width="320" height="200" />
            ) : (
              <Icon name="image" size={24} />
            )}
          </span>
          <figcaption>
            <b dir="auto">{textOf(title) || 'No headline yet'}</b>
            <span className="admin-sub" dir="auto">
              {textOf(project['title'])}
            </span>
            <dl className="svc-case__facts">
              <dt>Client</dt>
              <dd dir="auto">
                {client
                  ? confidential
                    ? `${client} (shown as “Confidential client”: not cleared to be named)`
                    : client
                  : 'None'}
              </dd>
              <dt>Sector</dt>
              <dd dir="auto">{sector || 'None'}</dd>
            </dl>
            <p className="admin-sub">The client and the sector come from the project.</p>
          </figcaption>
        </figure>
      )}
    </section>
  );
}
