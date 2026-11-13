import { useEffect, useId, useState } from 'react';
import Icon from '@/components/admin/kit/Icon';
import { adminFetch, describeError } from '@/lib/admin/client';
import { confirmDialog } from '@/lib/admin/confirm';
import { toast } from '@/lib/admin/toast';
import { CUSTOM_LIMITS, FIELD_KEY, FIELD_TYPE_NAMES, keyFromLabel } from './copy';
import type { CrmSettingsRow, CustomField } from './types';

// The custom fields card (Admin v2 C9b, crm.md §4.7 and §11 screen 11): the extra fields every
// contact has under Details and in Add contact, up to 12, each a label, a type (Text, Number or
// Date) and a key, the short name its values are saved under. A new field's key follows its
// label until someone types one. Once saved, a field's key and type are fixed (the database
// holds the type too), so stored values always fit their field; the label can change at any
// time. Removing a saved field deletes what every contact holds in it, so the save asks first.
// One explicit Save sends the whole set at the version the screen read (P-5); the version is
// the row's, shared with the scoring and response cards.

let next = 0;

export interface FieldDraft {
  local: string;
  key: string;
  label: string;
  type: CustomField['type'];
  /** Saved before: the key and type are fixed. */
  saved: boolean;
  /** A key someone typed: it no longer follows the label. */
  keyTyped: boolean;
}

export function fieldDrafts(fields: readonly CustomField[]): FieldDraft[] {
  return fields.map((f) => ({ ...f, local: `saved-${f.key}`, saved: true, keyTyped: true }));
}

/**
 * What would stop this set saving, in words, or null. The server checks it again. A new field
 * may not take the key of a saved field (`loaded`), even one this save removes: the database
 * would treat it as the same field, keep its values and refuse a change of type.
 */
export function fieldsProblem(
  drafts: readonly FieldDraft[],
  loaded: readonly CustomField[] = [],
): string | null {
  if (drafts.length > CUSTOM_LIMITS.maxFields) {
    return `Up to ${CUSTOM_LIMITS.maxFields} custom fields.`;
  }
  if (drafts.some((d) => d.label.trim().length === 0)) return 'Every field needs a label.';
  if (drafts.some((d) => d.label.trim().length > CUSTOM_LIMITS.maxLabel)) {
    return `A label is up to ${CUSTOM_LIMITS.maxLabel} characters.`;
  }
  if (drafts.some((d) => !FIELD_KEY.test(d.key))) {
    return 'A key uses lower-case letters, digits and _, and starts with a letter.';
  }
  if (new Set(drafts.map((d) => d.key)).size !== drafts.length) {
    return 'Each field needs its own key.';
  }
  const savedKeys = new Set(loaded.map((f) => f.key));
  if (drafts.some((d) => !d.saved && savedKeys.has(d.key))) {
    return 'A new field needs a key no saved field has used. Choose another key.';
  }
  return null;
}

/** The saved fields this set leaves out: their values go when it is saved. */
export function removedFields(
  loaded: readonly CustomField[],
  drafts: readonly FieldDraft[],
): CustomField[] {
  const kept = new Set(drafts.filter((d) => d.saved).map((d) => d.key));
  return loaded.filter((f) => !kept.has(f.key));
}

/** What the save sends: the set in order, labels trimmed. */
export function fieldsPayload(drafts: readonly FieldDraft[]): CustomField[] {
  return drafts.map((d) => ({ key: d.key, label: d.label.trim(), type: d.type }));
}

/** The question asked before a save that removes saved fields. */
export function removeQuestion(removed: readonly CustomField[]): string {
  const names = removed.map((f) => f.label).join(', ');
  return removed.length === 1
    ? `Remove ${names}? What every contact holds in it is deleted. This cannot be undone.`
    : `Remove ${names}? What every contact holds in them is deleted. This cannot be undone.`;
}

interface Props {
  settings: CrmSettingsRow;
  version: number;
  onSaved: (settings: CrmSettingsRow) => void;
}

export default function CustomFieldsCard({ settings, version, onSaved }: Props) {
  const id = useId();
  const [loaded, setLoaded] = useState<CustomField[]>(settings.customFields);
  const [drafts, setDrafts] = useState<FieldDraft[]>(() => fieldDrafts(settings.customFields));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoaded(settings.customFields);
    setDrafts(fieldDrafts(settings.customFields));
  }, [settings]);

  const update = (local: string, patch: Partial<FieldDraft>) =>
    setDrafts((list) =>
      list.map((d) => {
        if (d.local !== local) return d;
        const nextDraft = { ...d, ...patch };
        // A new field's key follows its label until someone types a key.
        if (patch.label !== undefined && !d.saved && !d.keyTyped) {
          const taken = new Set([
            ...loaded.map((f) => f.key),
            ...list.filter((o) => o.local !== local).map((o) => o.key),
          ]);
          nextDraft.key = keyFromLabel(patch.label, taken, list.indexOf(d) + 1);
        }
        return nextDraft;
      }),
    );
  const move = (index: number, by: -1 | 1) =>
    setDrafts((list) => {
      const to = index + by;
      if (to < 0 || to >= list.length) return list;
      const copy = [...list];
      [copy[index], copy[to]] = [copy[to]!, copy[index]!];
      return copy;
    });
  const remove = (local: string) => setDrafts((list) => list.filter((d) => d.local !== local));
  const add = () =>
    setDrafts((list) => {
      const taken = new Set([...loaded.map((f) => f.key), ...list.map((d) => d.key)]);
      return [
        ...list,
        {
          local: `new-${++next}`,
          key: keyFromLabel('New field', taken, list.length + 1),
          label: 'New field',
          type: 'text',
          saved: false,
          keyTyped: false,
        },
      ];
    });

  async function save() {
    const problem = fieldsProblem(drafts, loaded);
    if (problem) {
      setError(problem);
      return;
    }
    const removed = removedFields(loaded, drafts);
    if (
      removed.length > 0 &&
      !(await confirmDialog({
        message: removeQuestion(removed),
        confirmLabel: 'Remove and save',
        cancelLabel: 'Keep them',
      }))
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const answer = await adminFetch<{ settings: CrmSettingsRow }>('/api/admin/crm/settings', {
        method: 'PUT',
        body: { version, customFields: fieldsPayload(drafts) },
      });
      toast('Custom fields saved.', 'ok');
      setLoaded(answer.settings.customFields);
      setDrafts(fieldDrafts(answer.settings.customFields));
      onSaved(answer.settings);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card crm-card" aria-labelledby={`${id}-h`}>
      <h2 className="card-title" id={`${id}-h`}>
        Custom fields
      </h2>
      <p className="admin-sub">
        Show on every contact under Details, and in Add contact. A field&apos;s key and type are
        fixed once it is saved. Removing a field deletes what every contact holds in it.
      </p>
      <p className="f__hint">
        Add only what the work needs. Never a field for health, religion or other sensitive details.
      </p>
      {drafts.length === 0 ? (
        <p className="f__hint">No custom fields yet.</p>
      ) : (
        <ol className="crm-stages">
          {drafts.map((d, i) => {
            const name = d.label.trim() || 'this field';
            return (
              <li className="crm-stage" key={d.local}>
                <label className="f">
                  <span className="f__l">
                    Label<span className="visually-hidden"> of field {i + 1}</span>
                  </span>
                  <input
                    type="text"
                    value={d.label}
                    maxLength={CUSTOM_LIMITS.maxLabel}
                    dir="auto"
                    required
                    onChange={(e) => update(d.local, { label: e.target.value })}
                  />
                </label>
                {d.saved ? (
                  <p className="f__hint">
                    {FIELD_TYPE_NAMES[d.type]}, saved as <code>{d.key}</code>
                  </p>
                ) : (
                  <div className="crm-field__row">
                    <label className="f">
                      <span className="f__l">
                        Type<span className="visually-hidden"> of field {i + 1}</span>
                      </span>
                      <select
                        value={d.type}
                        onChange={(e) =>
                          update(d.local, { type: e.target.value as CustomField['type'] })
                        }
                      >
                        {(Object.keys(FIELD_TYPE_NAMES) as CustomField['type'][]).map((t) => (
                          <option key={t} value={t}>
                            {FIELD_TYPE_NAMES[t]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="f">
                      <span className="f__l">
                        Key<span className="visually-hidden"> of field {i + 1}</span>
                      </span>
                      <input
                        type="text"
                        value={d.key}
                        maxLength={CUSTOM_LIMITS.maxKey}
                        dir="ltr"
                        autoComplete="off"
                        spellCheck={false}
                        aria-describedby={`${id}-keyhint`}
                        onChange={(e) =>
                          update(d.local, { key: e.target.value.trim(), keyTyped: true })
                        }
                      />
                    </label>
                  </div>
                )}
                <div className="crm-stage__acts">
                  <button
                    type="button"
                    className="btn"
                    data-variant="ghost"
                    data-size="sm"
                    disabled={i === 0}
                    aria-label={`Move up: ${name}`}
                    onClick={() => move(i, -1)}
                  >
                    Move up
                  </button>
                  <button
                    type="button"
                    className="btn"
                    data-variant="ghost"
                    data-size="sm"
                    disabled={i === drafts.length - 1}
                    aria-label={`Move down: ${name}`}
                    onClick={() => move(i, 1)}
                  >
                    Move down
                  </button>
                  <button
                    type="button"
                    className="btn"
                    data-variant="ghost"
                    data-size="sm"
                    aria-label={`Remove: ${name}`}
                    onClick={() => remove(d.local)}
                  >
                    <Icon name="trash" size={14} />
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <p className="f__hint" id={`${id}-keyhint`}>
        A key uses lower-case letters, digits and _, and starts with a letter.
      </p>
      <div className="crm-card__foot">
        <button
          type="button"
          className="btn"
          data-variant="ghost"
          disabled={drafts.length >= CUSTOM_LIMITS.maxFields}
          onClick={add}
        >
          <Icon name="plus" size={16} />
          Add field
        </button>
        <span className="f__hint">
          {drafts.length} of {CUSTOM_LIMITS.maxFields} fields
        </span>
      </div>
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button
          type="button"
          className="btn"
          data-variant="primary"
          disabled={busy}
          onClick={() => void save()}
        >
          Save fields
        </button>
      </div>
    </section>
  );
}
