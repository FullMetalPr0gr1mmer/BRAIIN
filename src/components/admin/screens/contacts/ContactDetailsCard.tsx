import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  CONTACT_CHOSEN_SOURCES,
  type ContactPatch,
  type CustomFieldDefinition,
} from '@schemas/crm';
import type { ContactDetailRow } from '@/lib/crm/contactPage';
import { toast } from '@/lib/admin/toast';
import { CONTACT_SOURCE_LABELS, sourceLabelOf } from '@/lib/crm/contactView';
import { CustomFieldInputs, customErrors, customPatch, unreadableBoxes } from './customFields';

// Details (Admin v2 C7, crm.md §11 screen 6): the contact's own words, with an explicit Save
// (no autosave, P-5). One versioned PATCH of the fields that changed, through the page's queue
// (`save`): a success is a toast, "Details saved." (crm.md §11, toasts for success only); a 409 says "Someone else changed this. Refreshed." and the form takes the stored
// values. The custom fields the CRM settings define (C9b) are drawn here too, after the
// contact's own fields; a changed one is sent as itself (a cleared box as null), and the
// server lays it over what is stored. E-mails and phones are edited in Contact details, after
// a reveal.

type Values = Record<string, string>;

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
    out[`custom.${field.key}`] = typeof v === 'string' || typeof v === 'number' ? String(v) : '';
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
  const custom = customPatch(fields, customOf(before, fields), customOf(after, fields));
  if (custom) patch['custom'] = custom;
  return Object.keys(patch).length > 0 ? (patch as ContactPatch) : null;
}

/** The custom boxes of a form's values, by field key. */
function customOf(values: Values, fields: readonly CustomFieldDefinition[]): Values {
  return Object.fromEntries(fields.map((f) => [f.key, str(values[`custom.${f.key}`])]));
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
  const [customProblems, setCustomProblems] = useState<Record<string, string>>({});
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
    const unreadable = unreadableBoxes(customFields, id, (box) => document.getElementById(box));
    const problems = customErrors(customFields, customOf(values, customFields), unreadable);
    setCustomProblems(problems);
    const first = customFields.find((f) => problems[f.key]);
    if (first) {
      setError(`${first.label}: ${problems[first.key]}`);
      return;
    }
    const patch = detailsPatch(valuesOf(contact, customFields), values, customFields);
    if (!patch) {
      setError('');
      setSaid('Nothing to save.');
      return;
    }
    setError('');
    // Success is a toast (crm.md §11): nothing else on the card changes after a save of the
    // city or the source (C7 review, C7-UX-3).
    if (await save(patch)) toast('Details saved.', 'ok');
  }

  const set = (key: string) => (value: string) => setValues((v) => ({ ...v, [key]: value }));
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
        {text('company_name', 'Company', {
          maxLength: 120,
          dir: 'auto',
          // (Admin v2 C11) While linked to a company record the name is the record's: it is
          // changed there (a rename reaches every contact), or the contact is unlinked first.
          ...(typeof contact['company_id'] === 'string'
            ? { readOnly: true, 'aria-describedby': `${id}-company-hint` }
            : {}),
        })}
        {typeof contact['company_id'] === 'string' && (
          <p id={`${id}-company-hint`} className="f__hint">
            Linked to a company record. Rename it there, or unlink it under Company.
          </p>
        )}
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
        <CustomFieldInputs
          fields={customFields}
          values={customOf(values, customFields)}
          idPrefix={id}
          errors={customProblems}
          onChange={(key, value) => set(`custom.${key}`)(value)}
        />
        {error && (
          <p className="msg" data-kind="error" role="alert">
            {error}
          </p>
        )}
        <p className="f__hint" role="status">
          {said}
        </p>
        <button type="submit" data-variant="primary" disabled={busy}>
          Save details
        </button>
      </form>
    </section>
  );
}
