import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';
import { uiFor } from '@/lib/admin/uiSchema';
import { Field, formToPayload, rowToForm, type Row } from './FormField';
import { EDGE_NOT_SYNCED } from './ResourceTable';

// The create/edit form for every CRUD resource, driven by RESOURCE_UI.
//
// ── The version field is the whole point of the save path ────────────────────────
// The form loads a row, remembers its `version`, and sends that back on save. If a
// colleague saved in between, the server answers 409 and this shows "someone else saved
// changes" rather than silently overwriting their work. Last-write-wins is the default
// behaviour of every naive CMS form and it loses data quietly — the author never finds
// out, and neither does the person whose paragraph vanished.

export interface ResourceFormProps {
  resource: string;
  /** Row id, or `null` to create. */
  id: string | null;
}

export default function ResourceForm({ resource, id }: ResourceFormProps) {
  const ui = uiFor(resource);
  const isNew = id === null;

  // A new record starts from the create schema's defaults (a box the server would tick is
  // shown ticked).
  const [values, setValues] = useState<Row>(() =>
    isNew
      ? Object.fromEntries(
          ui.fields
            .filter((f) => f.defaultValue !== undefined)
            .map((f) => [f.name, f.defaultValue]),
        )
      : {},
  );
  // As loaded: a datetime the editor did not touch is left out of the PATCH, so the stored
  // instant keeps its full precision (the input shows minutes only).
  const [initial, setInitial] = useState<Row>({});
  const [version, setVersion] = useState(1);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  // A resource with an edge snapshot (redirects) reports `kvSynced` on every write. False
  // is a committed row the public request path does not see yet — shown with the
  // maintenance panel's wording, and carried across the create → edit navigation as
  // `?edge=missed` (the create response is gone once the page changes).
  const [edgeMissed, setEdgeMissed] = useState(
    () =>
      typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('edge') === 'missed',
  );
  const [busy, setBusy] = useState(!isNew);

  const load = useCallback(async () => {
    if (isNew) return;
    setBusy(true);
    try {
      const row = await adminFetch<Row>(`/api/admin/${ui.slug}/${id}`);
      const form = rowToForm(row, ui.fields);
      setValues(form);
      setInitial(form);
      setVersion(Number(row['version'] ?? 1));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [ui.slug, ui.fields, id, isNew]);

  useEffect(() => {
    void load();
  }, [load]);

  function set(name: string, value: unknown) {
    setSaved(false);
    setEdgeMissed(false);
    setValues((previous) => ({ ...previous, [name]: value }));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setError('');
    setSaved(false);
    try {
      const body = formToPayload(values, ui.fields);
      if (isNew) {
        const created = await adminFetch<Row>(`/api/admin/${ui.slug}`, { method: 'POST', body });
        const missed = created['kvSynced'] === false ? '?edge=missed' : '';
        window.location.href = `/admin/${ui.slug}/${String(created['id'])}${missed}`;
        return;
      }
      for (const field of ui.fields) {
        if (field.kind === 'datetime' && values[field.name] === initial[field.name]) {
          delete body[field.name];
        }
      }
      const updated = await adminFetch<Row>(`/api/admin/${ui.slug}/${id}`, {
        method: 'PATCH',
        body: { ...body, version },
      });
      // Re-seed from the SERVER's response, not from local state: the row now carries a
      // bumped version, a trigger-set updated_at, and derived fields such as
      // reading_minutes that the client never computed.
      const reseeded = rowToForm(updated, ui.fields);
      setValues(reseeded);
      setInitial(reseeded);
      setVersion(Number(updated['version'] ?? version + 1));
      setEdgeMissed(updated['kvSynced'] === false);
      setSaved(true);
    } catch (err) {
      setError(describeError(err));
    }
  }

  if (busy) return <p>Loading…</p>;

  return (
    <form onSubmit={(event) => void save(event)}>
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      {saved && !edgeMissed && (
        <p className="msg" data-kind="ok" role="status">
          Saved.
        </p>
      )}
      {edgeMissed && (
        <p className="msg" data-kind="error" role="alert">
          {EDGE_NOT_SYNCED}
        </p>
      )}

      <div className="card">
        {ui.fields.map((field) => (
          <Field
            key={field.name}
            field={field}
            value={values[field.name]}
            values={values}
            onChange={set}
          />
        ))}
      </div>

      <div className="toolbar form-actions">
        <button type="submit" data-variant="primary">
          {isNew ? `Create ${ui.singular.toLowerCase()}` : 'Save changes'}
        </button>
        <a className="btn" href={`/admin/${ui.slug}`}>
          Back to {ui.title.toLowerCase()}
        </a>
        {!isNew && <span className="admin-sub">Version {version}</span>}
      </div>
    </form>
  );
}
