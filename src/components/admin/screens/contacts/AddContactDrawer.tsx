import { useId, useState, type FormEvent, type ReactNode } from 'react';
import Drawer from '@/components/admin/kit/Drawer';
import ErrorSummary, { type FieldError } from '@/components/admin/kit/ErrorSummary';
import Note from '@/components/admin/kit/Note';
import {
  CONTACT_CHOSEN_SOURCES,
  CONTACT_STAGES,
  type ContactCreate,
  type ContactStage,
} from '@schemas/crm';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { withFlash } from '@/lib/admin/flash';
import { CONTACT_SOURCE_LABELS, CONTACT_STAGE_LABELS } from '@/lib/crm/contactView';
import type { ContactPerson } from './shared';

// "Add contact" (Admin v2 C7, crm.md §11 screen 7): someone met at an event, a referral, a
// call. Loaded with import() when the button is first pressed, so neither this form nor the kit
// pieces it draws ride on the list's first load. One POST to /api/admin/crm/contacts (the
// Worker encrypts and blind-indexes the e-mail and phone; nothing typed is stored as typed):
//   200  "Contact added", and the contact's page
//   409  a taken e-mail: "Someone with this e-mail already exists", with an Open link (the
//        other contact's id; never its details)
//   422  each field's own message, and a summary first
//   429  the hourly limit, said inline
// No consent toggles (crm.md §11: LATER). What was typed is never put in an address, in storage
// or in a toast.

export interface AddContactDrawerProps {
  open: boolean;
  onClose: () => void;
  people: readonly ContactPerson[];
  /** The signed-in person: the default owner. */
  me: string;
}

export interface ContactForm {
  name: string;
  title: string;
  email: string;
  phone: string;
  company: string;
  stage: ContactStage;
  owner: string;
  locale: 'en' | 'ar';
  city: string;
  source: (typeof CONTACT_CHOSEN_SOURCES)[number];
  tags: string;
}

/** What the error summary calls each field. */
const LABELS: Readonly<Record<keyof ContactForm, string>> = {
  name: 'Name',
  title: 'Title',
  email: 'E-mail',
  phone: 'Phone or WhatsApp',
  company: 'Company',
  stage: 'Stage',
  owner: 'Owner',
  locale: 'Language',
  city: 'City',
  source: 'How they found us',
  tags: 'Tags',
};

/** The field each API key belongs to (a channel's is found by its kind, `issueField`). */
const FIELDS: Readonly<Record<string, keyof ContactForm>> = {
  displayName: 'name',
  title: 'title',
  companyName: 'company',
  stage: 'stage',
  ownerId: 'owner',
  locale: 'locale',
  city: 'city',
  source: 'source',
  tags: 'tags',
};

/** A channel the server refused, in words: Zod's own text is not written for people (P-12). */
const CHANNEL_WORDS: Readonly<Record<'email' | 'phone', string>> = {
  email: 'Type the whole e-mail address, like name@example.com.',
  phone: 'Type the whole number, with its country code.',
};

/**
 * The form field a server issue belongs to, and what to say under it (C7 review, C7-COR-1). A
 * channel's path is `channels.<n>…`: the n-th channel of the body that was sent, whose kind
 * says whether it is the e-mail or the phone box (the e-mail goes first when both are given).
 */
export function issueField(
  path: string,
  message: string,
  sent: ContactCreate,
): { key: keyof ContactForm; message: string } | null {
  const [head, index] = path.split('.');
  if (head === 'channels') {
    const kind = sent.channels?.[Number(index)]?.kind;
    if (kind === 'email' || kind === 'phone') return { key: kind, message: CHANNEL_WORDS[kind] };
    return null;
  }
  const key = FIELDS[head ?? ''];
  return key ? { key, message } : null;
}

/** Tags as typed: comma separated, trimmed, each once. */
export function tagsOf(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  ];
}

/** The request body: empty boxes left out. */
export function contactBody(form: ContactForm): ContactCreate {
  const body: ContactCreate = {
    displayName: form.name.trim(),
    stage: form.stage,
    locale: form.locale,
    source: form.source,
    ownerId: form.owner || null,
  };
  if (form.title.trim()) body.title = form.title.trim();
  if (form.company.trim()) body.companyName = form.company.trim();
  if (form.city.trim()) body.city = form.city.trim();
  const tags = tagsOf(form.tags);
  if (tags.length > 0) body.tags = tags;
  const channels: NonNullable<ContactCreate['channels']> = [];
  if (form.email.trim())
    channels.push({ kind: 'email', value: form.email.trim(), isPrimary: true });
  if (form.phone.trim())
    channels.push({ kind: 'phone', value: form.phone.trim(), isPrimary: true });
  if (channels.length > 0) body.channels = channels;
  return body;
}

/** What the form itself refuses before it asks the server. */
export function checkContact(form: ContactForm): Partial<Record<keyof ContactForm, string>> {
  const errors: Partial<Record<keyof ContactForm, string>> = {};
  if (!form.name.trim()) errors.name = 'Give them a name.';
  if (tagsOf(form.tags).length > 10) errors.tags = 'A contact has up to 10 tags.';
  if (tagsOf(form.tags).some((t) => t.length > 32)) errors.tags = 'A tag is up to 32 characters.';
  return errors;
}

export default function AddContactDrawer({ open, onClose, people, me }: AddContactDrawerProps) {
  const prefix = useId();
  const id = (key: keyof ContactForm) => `${prefix}-${key}`;
  const owners = people.filter((p) => p.canOwn);
  const [form, setForm] = useState<ContactForm>(() => ({
    name: '',
    title: '',
    email: '',
    phone: '',
    company: '',
    stage: 'lead',
    owner: owners.some((p) => p.id === me) ? me : '',
    locale: 'en',
    city: '',
    source: 'manual',
    tags: '',
  }));
  const [errors, setErrors] = useState<Partial<Record<keyof ContactForm, string>>>({});
  const [summary, setSummary] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState('');
  const [taken, setTaken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof ContactForm) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }) as ContactForm);

  function show(found: Partial<Record<keyof ContactForm, string>>) {
    setErrors(found);
    setSummary(
      (Object.entries(found) as [keyof ContactForm, string][]).map(([key, message]) => ({
        id: id(key),
        message: `${LABELS[key]}: ${message}`,
      })),
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure('');
    setTaken(null);
    const local = checkContact(form);
    if (Object.keys(local).length > 0) return show(local);
    show({});
    setBusy(true);
    const sent = contactBody(form);
    try {
      const added = await adminFetch<{ id: string }>('/api/admin/crm/contacts', {
        method: 'POST',
        body: sent,
      });
      // The confirmation rides to the contact's page, which shows it.
      location.assign(withFlash(`/admin/contacts/${added.id}`, 'contact-added'));
    } catch (err) {
      setBusy(false);
      if (err instanceof AdminApiError && err.info.status === 409) {
        const other = err.body['contactId'];
        setTaken(typeof other === 'string' ? other : '');
        return;
      }
      if (err instanceof AdminApiError && err.info.status === 422 && err.info.issues) {
        const found: Partial<Record<keyof ContactForm, string>> = {};
        for (const issue of err.info.issues) {
          const field = issueField(issue.path, issue.message, sent);
          if (field) found[field.key] ??= field.message;
        }
        if (Object.keys(found).length > 0) return show(found);
      }
      setFailure(
        err instanceof AdminApiError && err.info.status === 429
          ? 'You have added a lot of contacts in the last hour. Try again later.'
          : describeError(err),
      );
    }
  }

  const field = (key: keyof ContactForm, label: string, control: ReactNode, required = false) => (
    <div className="f">
      <label className="f__l" htmlFor={id(key)}>
        <span>
          {label}
          {required && (
            <>
              <span className="req" aria-hidden="true">
                {' '}
                *
              </span>
              <span className="visually-hidden"> (required)</span>
            </>
          )}
        </span>
      </label>
      {control}
      {errors[key] && (
        <p id={`${id(key)}-error`} className="field-error f__err">
          {errors[key]}
        </p>
      )}
    </div>
  );
  const input = (key: keyof ContactForm, attrs: Record<string, unknown> = {}, hint = false) => (
    <input
      id={id(key)}
      value={form[key]}
      autoComplete="off"
      aria-invalid={errors[key] ? true : undefined}
      aria-describedby={
        [errors[key] ? `${id(key)}-error` : '', hint ? `${id(key)}-hint` : '']
          .filter(Boolean)
          .join(' ') || undefined
      }
      onChange={(event) => set(key)(event.target.value)}
      {...attrs}
    />
  );
  const select = (key: keyof ContactForm, options: readonly [string, string][]) => (
    <select id={id(key)} value={form[key]} onChange={(event) => set(key)(event.target.value)}>
      {options.map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Add a contact"
      dismissible={false}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form={`${prefix}-form`} data-variant="primary" disabled={busy}>
            Add contact
          </button>
        </>
      }
    >
      <form id={`${prefix}-form`} className="lead-add" onSubmit={(e) => void submit(e)} noValidate>
        <p className="admin-sub">Someone you met, or who reached you another way.</p>
        <ErrorSummary errors={summary} />
        {failure && (
          <p className="msg" data-kind="error" role="alert">
            {failure}
          </p>
        )}
        {taken !== null && (
          <Note tone="warn" role="alert">
            <p>
              Someone with this e-mail already exists.{' '}
              {taken && <a href={`/admin/contacts/${taken}`}>Open them</a>}
            </p>
          </Note>
        )}
        <div className="lead-add__row">
          {field(
            'name',
            'Name',
            input('name', { maxLength: 120, 'aria-required': true, dir: 'auto' }),
            true,
          )}
          {field('title', 'Title', input('title', { maxLength: 120, dir: 'auto' }))}
        </div>
        <div className="lead-add__row">
          {field('email', 'E-mail', input('email', { type: 'email', maxLength: 254, dir: 'ltr' }))}
          {field(
            'phone',
            'Phone or WhatsApp',
            input('phone', { type: 'tel', maxLength: 32, dir: 'ltr' }),
          )}
        </div>
        <div className="lead-add__row">
          {field('company', 'Company', input('company', { maxLength: 120, dir: 'auto' }))}
          {field('city', 'City', input('city', { maxLength: 80, dir: 'auto' }))}
        </div>
        <div className="lead-add__row">
          {field(
            'stage',
            'Stage',
            select(
              'stage',
              CONTACT_STAGES.map((s) => [s, CONTACT_STAGE_LABELS[s]] as [string, string]),
            ),
          )}
          {field(
            'owner',
            'Owner',
            select('owner', [
              ['', 'No owner'],
              ...owners.map((p) => [p.id, p.name] as [string, string]),
            ]),
          )}
        </div>
        <div className="lead-add__row">
          {field(
            'locale',
            'Language',
            select('locale', [
              ['en', 'English'],
              ['ar', 'Arabic'],
            ]),
          )}
          {field(
            'source',
            'How they found us',
            select(
              'source',
              CONTACT_CHOSEN_SOURCES.map((s) => [s, CONTACT_SOURCE_LABELS[s]] as [string, string]),
            ),
          )}
        </div>
        {field('tags', 'Tags', input('tags', { maxLength: 360, dir: 'auto' }, true))}
        <p id={`${id('tags')}-hint`} className="f__hint">
          Separate tags with commas. Up to 10.
        </p>
      </form>
    </Drawer>
  );
}
