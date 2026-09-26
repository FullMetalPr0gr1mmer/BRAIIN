import { useRef, useState } from 'react';
import { adminUpload, describeError } from '@/lib/admin/client';
import type { FieldDef } from '@/lib/admin/uiSchema';

// A file sent to `field.upload.endpoint` (multipart, CSRF-headed — adminUpload); the
// field then holds the id the endpoint returns. The endpoint is the gate: it checks the
// size before reading the body, the type by magic bytes, and the capability. `accept`
// here is only a hint to the file chooser.

interface Props {
  field: FieldDef;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
  idPrefix: string;
}

export default function UploadField({ field, value, onChange, idPrefix }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const id = `${idPrefix}-${field.name}`;
  const current = typeof value === 'string' ? value : '';

  async function send(file: File) {
    if (!field.upload) return;
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      const result = await adminUpload<{ id: string }>(field.upload.endpoint, form);
      setName(file.name);
      onChange(field.name, result.id);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
      // Cleared after every attempt: picking the SAME file again must fire `change`.
      if (input.current) input.current.value = '';
    }
  }

  function remove() {
    setName('');
    if (input.current) input.current.value = '';
    onChange(field.name, '');
  }

  return (
    <div className="field-group">
      <label className="field" htmlFor={id}>
        <span id={`${id}-label`}>
          {field.label}
          {field.required ? ' *' : ''}
        </span>
        <input
          ref={input}
          id={id}
          type="file"
          accept={field.upload?.accept}
          disabled={busy || !field.upload}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void send(file);
          }}
        />
      </label>
      <p className="admin-sub" aria-live="polite">
        {busy ? 'Uploading…' : current ? (name ? `Uploaded ${name}.` : 'A file is attached.') : ''}
      </p>
      {current && !busy && (
        <button type="button" className="btn" aria-describedby={`${id}-label`} onClick={remove}>
          Remove file
        </button>
      )}
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      {field.help && <p className="admin-sub">{field.help}</p>}
    </div>
  );
}
