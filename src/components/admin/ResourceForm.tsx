import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';
import { uiFor } from '@/lib/admin/uiSchema';
import { Field, formToPayload, rowToForm, type Row } from './FormField';

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

  const [values, setValues] = useState<Row>({});
  const [version, setVersion] = useState(1);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(!isNew);

  const load = useCallback(async () => {
    if (isNew) return;
    setBusy(true);
    try {
      const row = await adminFetch<Row>(`/api/admin/${ui.slug}/${id}`);
      setValues(rowToForm(row, ui.fields));
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
        window.location.href = `/admin/${ui.slug}/${String(created['id'])}`;
        return;
      }
      const updated = await adminFetch<Row>(`/api/admin/${ui.slug}/${id}`, {
        method: 'PATCH',
        body: { ...body, version },
      });
      // Re-seed from the SERVER's response, not from local state: the row now carries a
      // bumped version, a trigger-set updated_at, and derived fields such as
      // reading_minutes that the client never computed.
      setValues(rowToForm(updated, ui.fields));
      setVersion(Number(updated['version'] ?? version + 1));
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
      {saved && (
        <p className="msg" data-kind="ok" role="status">
          Saved.
        </p>
      )}

      <div className="card">
        {ui.fields.map((field) => (
          <Field key={field.name} field={field} value={values[field.name]} onChange={set} />
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
