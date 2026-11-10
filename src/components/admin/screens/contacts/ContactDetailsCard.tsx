import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  CONTACT_CHOSEN_SOURCES,
  type ContactPatch,
  type CustomFieldDefinition,
} from '@schemas/crm';
import type { ContactDetailRow } from '@/lib/crm/contactPage';
import { CONTACT_SOURCE_LABELS, sourceLabelOf } from '@/lib/crm/contactView';

// Details (Admin v2 C7, crm.md §11 screen 6): the contact's own words, with an explicit Save
// (no autosave, P-5). One versioned PATCH of the fields that changed, through the page's queue
// (`save`): a 409 says "Someone else changed this. Refreshed." and the form takes the stored
// values. The custom fields the CRM settings define (C9b) are drawn here too; until then there
// are none. E-mails and phones are edited in Contact details, after a reveal.

type Values = Record<string, string | boolean>;

const BASE: readonly [keyof ContactPatch, string][] = [
  ['displayName', 'display_name'],
  ['title', 'title'],
  ['companyName', 'company_name'],
  ['city', 'city'],
  ['country', 'country'],
  ['locale', 'locale'],
  ['source', 'source'],
];

const str = (value: unknown) => (typeof value === 'string' ? value : '');

function valuesOf(contact: ContactDetailRow, fields: readonly CustomFieldDefinition[]): Values {
  const out: Values = {};
  for (const [, column] of BASE) out[column] = str(contact[column]);
  const custom = (contact['custom'] ?? {}) as Record<string, unknown>;
  for (const field of fields) {
    const v = custom[field.key];
    out[`custom.${field.key}`] =
      field.type === 'boolean' ? v === true : v === null || v === undefined ? '' : String(v);
  }
  return out;
}

/**
 * The PATCH body for what changed (the version is the queue's), or null when nothing did.
 * An emptied optional box is sent as null; the name is never empty (the form says so first).
 */
export function detailsPatch(
  before: Values,
  after: Values,
  fields: readonly CustomFieldDefinition[],
): ContactPatch | null {
  const patch: Record<string, unknown> = {};
  for (const [key, column] of BASE) {
    const now = str(after[column]).trim();
    if (now === str(before[column]).trim()) continue;
    patch[key] = key === 'displayName' || key === 'locale' || key === 'source' ? now : now || null;
  }
  const custom: Record<string, string | number | boolean | null> = {};
  let customChanged = false;
  for (const field of fields) {
    const k = `custom.${field.key}`;
    const v = after[k];
    custom[field.key] =
      field.type === 'boolean'
        ? v === true
        : str(v).trim() === ''
          ? null
          : field.type === 'number'
            ? Number(v)
            : str(v).trim();
    if (v !== before[k]) customChanged = true;
  }
  if (customChanged) patch['custom'] = custom;
  return Object.keys(patch).length > 0 ? (patch as ContactPatch) : null;
}

interface Props {
  contact: ContactDetailRow;
  customFields: readonly CustomFieldDefinition[];
  busy: boolean;
  /** One PATCH through the page's queue; resolves to whether it saved. */
  save: (patch: ContactPatch) => Promise<boolean>;
}

export default function ContactDetailsCard({ contact, customFields, busy, save }: Props) {
  const id = useId();
  const [values, setValues] = useState<Values>(() => valuesOf(contact, customFields));
  const [error, setError] = useState('');
  const [said, setSaid] = useState('');

  const base = useRef<Values>(values);

  // The stored values whenever the contact is read again (a save, a star, a 409's refresh),
  // keeping what the person has typed and not saved yet: only an untouched box follows.
  useEffect(() => {
    const before = base.current;
    const stored = valuesOf(contact, customFields);
    base.current = stored;
    setValues((now) => {
      const next: Values = { ...stored };
      for (const key of Object.keys(stored)) {
        if (key in now && now[key] !== before[key]) next[key] = now[key]!;
      }
      return next;
    });
  }, [contact, customFields]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaid('');
    if (!str(values['display_name']).trim()) {
      setError('Give them a name.');
      return;
    }
    if (str(values['country']).trim() && !/^[A-Z]{2}$/.test(str(values['country']).trim())) {
      setError('Use a two-letter country code, such as SA.');
      return;
    }
    const patch = detailsPatch(valuesOf(contact, customFields), values, customFields);
    if (!patch) {
      setError('');
      setSaid('Nothing to save.');
      return;
    }
    setError('');
    if (await save(patch)) setSaid('Saved.');
  }

  const set = (key: string) => (value: string | boolean) =>
    setValues((v) => ({ ...v, [key]: value }));
  const text = (key: string, label: string, attrs: Record<string, unknown> = {}) => (
    <div className="f">
      <label className="f__l" htmlFor={`${id}-${key}`}>
        {label}
      </label>
      <input
        id={`${id}-${key}`}
        value={str(values[key])}
        autoComplete="off"
        onChange={(event) => set(key)(event.target.value)}
        {...attrs}
      />
    </div>
  );
  const chosenSource = str(values['source']);
  const sources = (CONTACT_CHOSEN_SOURCES as readonly string[]).includes(chosenSource)
    ? CONTACT_CHOSEN_SOURCES
    : [chosenSource, ...CONTACT_CHOSEN_SOURCES];

  return (
    <section className="card" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="card-title">
        Details
      </h2>
      <form onSubmit={(event) => void submit(event)} noValidate>
        {text('display_name', 'Name', { maxLength: 120, dir: 'auto', 'aria-required': true })}
        {text('title', 'Title', { maxLength: 120, dir: 'auto' })}
        {text('company_name', 'Company', { maxLength: 120, dir: 'auto' })}
        <div className="lead-add__row">
          {text('city', 'City', { maxLength: 80, dir: 'auto' })}
          {text('country', 'Country code', { maxLength: 2, dir: 'ltr' })}
        </div>
        <div className="lead-add__row">
          <div className="f">
            <label className="f__l" htmlFor={`${id}-locale`}>
              Language
            </label>
            <select
              id={`${id}-locale`}
              value={str(values['locale']) || 'en'}
              onChange={(event) => set('locale')(event.target.value === 'ar' ? 'ar' : 'en')}
            >
              <option value="en">English</option>
              <option value="ar">Arabic</option>
            </select>
          </div>
          <div className="f">
            <label className="f__l" htmlFor={`${id}-source`}>
              How they found us
            </label>
            <select
              id={`${id}-source`}
              value={chosenSource}
              onChange={(event) => set('source')(event.target.value)}
            >
              {sources.map((s) => (
                <option key={s} value={s} disabled={s === chosenSource && s === 'import'}>
                  {(CONTACT_SOURCE_LABELS as Record<string, string>)[s] ?? sourceLabelOf(s)}
                </option>
              ))}
            </select>
          </div>
        </div>
        {customFields.map((field) =>
          field.type === 'boolean' ? (
            <label key={field.key} className="field-inline">
              <input
                type="checkbox"
                checked={values[`custom.${field.key}`] === true}
                onChange={(event) => set(`custom.${field.key}`)(event.target.checked)}
              />
              <span>{field.label}</span>
            </label>
          ) : field.type === 'select' ? (
            <div className="f" key={field.key}>
              <label className="f__l" htmlFor={`${id}-c-${field.key}`}>
                {field.label}
              </label>
              <select
                id={`${id}-c-${field.key}`}
                value={str(values[`custom.${field.key}`])}
                onChange={(event) => set(`custom.${field.key}`)(event.target.value)}
              >
                <option value="">Not set</option>
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div key={field.key}>
              {text(`custom.${field.key}`, field.label, {
                type: field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text',
                dir: 'auto',
                maxLength: field.maxLength ?? 500,
              })}
            </div>
          ),
        )}
        {error && (
          <p className="msg" data-kind="error" role="alert">
            {error}
          </p>
        )}
        <p className="visually-hidden" role="status">
          {said}
        </p>
        <button type="submit" data-variant="primary" disabled={busy}>
          Save details
        </button>
      </form>
    </section>
  );
}
