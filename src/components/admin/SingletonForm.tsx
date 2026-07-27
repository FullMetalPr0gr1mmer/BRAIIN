import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';
import { singletonFor } from '@/lib/admin/uiSchema';
import { Field, formToPayload, rowToForm, type Row } from './FormField';

// Editor for the per-tenant config singletons: SEO defaults, general settings,
// integrations, Style-Finder logic.
//
// `version: 0` is meaningful here rather than being a placeholder. A tenant that has
// never saved this config has NO ROW — the GET endpoint answers with defaults and
// version 0 — and the PATCH treats 0 as "I am creating it". That is what makes the
// optimistic-lock story hold across the create boundary: two admins who both open a
// fresh settings page and both save produce one insert and one 409, not two inserts or
// a silent overwrite.

export interface SingletonFormProps {
  /** Key into SINGLETON_UI. */
  config: string;
}

export default function SingletonForm({ config }: SingletonFormProps) {
  const ui = singletonFor(config);
  const [values, setValues] = useState<Row>({});
  const [version, setVersion] = useState(0);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(true);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const row = await adminFetch<Row>(ui.endpoint);
      setValues(rowToForm(row, ui.fields));
      setVersion(Number(row['version'] ?? 0));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [ui.endpoint, ui.fields]);

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
      const updated = await adminFetch<Row>(ui.endpoint, {
        method: 'PATCH',
        body: { ...body, version },
      });
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
          Save {ui.title.toLowerCase()}
        </button>
        <span className="admin-sub">{version === 0 ? 'Not saved yet' : `Version ${version}`}</span>
      </div>
    </form>
  );
}
