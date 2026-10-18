import { useId, useState, type FormEvent, type ReactNode } from 'react';
import Drawer from '@/components/admin/kit/Drawer';
import ErrorSummary, { type FieldError } from '@/components/admin/kit/ErrorSummary';
import Note from '@/components/admin/kit/Note';
import { BUDGET_BANDS, BUDGET_BAND_LABELS } from '@schemas/lead';
import { MANUAL_LEAD_CHANNELS, type LeadManualCreate } from '@schemas/crm';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { toast } from '@/lib/admin/toast';
import type { DisciplineView } from '@/lib/crm/leadPage';
import { CHANNEL_LABELS } from '@/lib/crm/leadView';

// "Add a lead manually" (Admin v2 C4b, crm.md §11 screen 4 and §7.2): for calls, walk-ins and
// WhatsApp messages. Loaded with import() when the button is first pressed (shared.tsx), so
// neither this form nor the kit pieces it draws with ride on the list's or the board's first
// load (P-10). A create-only POST to /api/admin/leads (decision D3: not useEntitySave, which
// serves the resource and singleton editors; no autosave, P-5):
//   200  "Lead added", and the lead's page; when the e-mail wrote before, that page names the
//        earlier leads (their ids in the address, never the address itself)
//   409  a phone that matches an earlier lead while the e-mail does not: the matches (name,
//        number, spam) with Open links, and "Add as someone new" sends it again as new
//   422  each field's own message, and a summary first
//   429  the hourly limit, said inline
// What was typed is never put in an address, in storage or in a toast.

export interface AddLeadDrawerProps {
  open: boolean;
  onClose: () => void;
  disciplines: readonly DisciplineView[];
}

interface Match {
  id: string;
  lead_number: number | null;
  name: string | null;
  spam: boolean;
}

type Form = {
  name: string;
  company: string;
  email: string;
  phone: string;
  service: string;
  budget: string;
  timeline: string;
  message: string;
  locale: 'en' | 'ar';
  channel: (typeof MANUAL_LEAD_CHANNELS)[number];
};

const EMPTY: Form = {
  name: '',
  company: '',
  email: '',
  phone: '',
  service: '',
  budget: '',
  timeline: '',
  message: '',
  locale: 'en',
  channel: 'phone',
};

/** The field each API key belongs to, and what the summary calls it. */
const FIELDS: Readonly<Record<string, { key: keyof Form; label: string }>> = {
  name: { key: 'name', label: 'Name' },
  company: { key: 'company', label: 'Company' },
  email: { key: 'email', label: 'E-mail' },
  phone: { key: 'phone', label: 'Phone or WhatsApp' },
  serviceOfInterest: { key: 'service', label: 'Service' },
  budgetBand: { key: 'budget', label: 'Budget' },
  timeline: { key: 'timeline', label: 'When do you need it?' },
  message: { key: 'message', label: 'Message' },
  locale: { key: 'locale', label: 'Language' },
  channel: { key: 'channel', label: 'How they reached us' },
};

/** The request body: empty boxes left out, so the schema's "at least one" rules apply. */
export function manualLeadBody(form: Form, createNew: boolean): LeadManualCreate {
  const body: LeadManualCreate = {
    name: form.name.trim(),
    message: form.message.trim(),
    locale: form.locale,
    channel: form.channel,
  };
  if (form.company.trim()) body.company = form.company.trim();
  if (form.email.trim()) body.email = form.email.trim();
  if (form.phone.trim()) body.phone = form.phone.trim();
  if (form.service) body.serviceOfInterest = form.service;
  if (form.budget) body.budgetBand = form.budget as LeadManualCreate['budgetBand'] & string;
  if (form.timeline.trim()) body.timeline = form.timeline.trim();
  if (createNew) body.createNew = true;
  return body;
}

/** What the form itself refuses before it asks the server. */
export function checkManualLead(form: Form): Partial<Record<keyof Form, string>> {
  const errors: Partial<Record<keyof Form, string>> = {};
  if (!form.name.trim()) errors.name = 'Give the lead a name.';
  if (!form.message.trim()) errors.message = 'Write what they asked for.';
  if (!form.email.trim() && !form.phone.trim())
    errors.email = 'Add an e-mail address or a phone number.';
  return errors;
}

export default function AddLeadDrawer({ open, onClose, disciplines }: AddLeadDrawerProps) {
  const prefix = useId();
  const id = (key: keyof Form) => `${prefix}-${key}`;
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const [summary, setSummary] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState('');
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof Form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }) as Form);

  function show(found: Partial<Record<keyof Form, string>>) {
    setErrors(found);
    setSummary(
      (Object.entries(found) as [keyof Form, string][]).map(([key, message]) => ({
        id: id(key),
        message: `${Object.values(FIELDS).find((f) => f.key === key)?.label ?? key}: ${message}`,
      })),
    );
  }

  async function submit(createNew: boolean) {
    setFailure('');
    const local = checkManualLead(form);
    if (Object.keys(local).length > 0) return show(local);
    show({});
    setBusy(true);
    try {
      const added = await adminFetch<{ id: string; sameEmail: { id: string }[] }>(
        '/api/admin/leads',
        { method: 'POST', body: manualLeadBody(form, createNew) },
      );
      toast('Lead added', 'ok');
      const same = added.sameEmail.map((lead) => lead.id).filter(Boolean);
      location.assign(
        same.length > 0
          ? `/admin/leads/${added.id}?same=${same.map(encodeURIComponent).join(',')}`
          : `/admin/leads/${added.id}`,
      );
    } catch (err) {
      setBusy(false);
      if (err instanceof AdminApiError && err.info.error === 'possible-duplicate') {
        const found = err.body['matches'];
        setMatches(Array.isArray(found) ? (found as Match[]) : []);
        return;
      }
      if (err instanceof AdminApiError && err.info.status === 422 && err.info.issues) {
        const found: Partial<Record<keyof Form, string>> = {};
        for (const issue of err.info.issues) {
          const field = FIELDS[issue.path.split('.')[0] ?? ''];
          if (field) found[field.key] ??= issue.message;
        }
        if (Object.keys(found).length > 0) return show(found);
      }
      setFailure(
        err instanceof AdminApiError && err.info.status === 429
          ? 'You have added a lot of leads in the last hour. Try again later.'
          : describeError(err),
      );
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setMatches(null);
    void submit(false);
  }

  const field = (
    key: keyof Form,
    label: string,
    control: ReactNode,
    options: { required?: boolean; hint?: string } = {},
  ) => (
    <div className="f">
      <label className="f__l" htmlFor={id(key)}>
        <span>
          {label}
          {options.required && (
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
      {options.hint && (
        <p id={`${id(key)}-hint`} className="f__hint">
          {options.hint}
        </p>
      )}
    </div>
  );
  const described = (key: keyof Form) => (errors[key] ? `${id(key)}-error` : undefined);
  const input = (key: keyof Form, attrs: Record<string, unknown> = {}) => (
    <input
      id={id(key)}
      value={form[key]}
      aria-invalid={errors[key] ? true : undefined}
      aria-describedby={described(key)}
      onChange={(event) => set(key)(event.target.value)}
      {...attrs}
    />
  );

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="Add a lead manually"
      dismissible={false}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form={`${prefix}-form`} data-variant="primary" disabled={busy}>
            Add lead
          </button>
        </>
      }
    >
      <form id={`${prefix}-form`} className="lead-add" onSubmit={onSubmit} noValidate>
        <p className="admin-sub">For calls, walk-ins and WhatsApp messages.</p>
        <ErrorSummary errors={summary} />
        {failure && (
          <p className="msg" data-kind="error" role="alert">
            {failure}
          </p>
        )}
        {matches && (
          <Note tone="warn" role="alert">
            <p>
              This phone number is on an earlier lead. Open it if it is the same person, or add this
              one as someone new.
            </p>
            <ul className="lead-dupes">
              {matches.map((match) => (
                <li key={match.id}>
                  <a href={`/admin/leads/${match.id}`}>
                    Open {match.lead_number === null ? 'the earlier lead' : `#${match.lead_number}`}
                  </a>{' '}
                  <span dir="auto">{match.name ?? ''}</span>
                  {match.spam && ' (marked as spam)'}
                </li>
              ))}
            </ul>
            <button type="button" disabled={busy} onClick={() => void submit(true)}>
              Add as someone new
            </button>
          </Note>
        )}
        <div className="lead-add__row">
          {field(
            'name',
            'Name',
            input('name', { maxLength: 120, 'aria-required': true, autoComplete: 'off' }),
            {
              required: true,
            },
          )}
          {field('company', 'Company', input('company', { maxLength: 120, autoComplete: 'off' }))}
        </div>
        <div className="lead-add__row">
          {field(
            'email',
            'E-mail',
            input('email', { type: 'email', maxLength: 254, autoComplete: 'off', dir: 'ltr' }),
          )}
          {field(
            'phone',
            'Phone or WhatsApp',
            input('phone', { type: 'tel', maxLength: 32, autoComplete: 'off', dir: 'ltr' }),
          )}
        </div>
        {field(
          'service',
          'Service',
          <select
            id={id('service')}
            value={form.service}
            onChange={(event) => set('service')(event.target.value)}
          >
            <option value="">Not sure yet</option>
            {disciplines.map((discipline) =>
              discipline.services.length > 0 ? (
                <optgroup key={discipline.slug} label={discipline.name}>
                  {discipline.services.map((service) => (
                    <option key={service.slug} value={service.slug}>
                      {service.name}
                    </option>
                  ))}
                </optgroup>
              ) : null,
            )}
          </select>,
        )}
        <div className="lead-add__row">
          {field(
            'budget',
            'Budget',
            <select
              id={id('budget')}
              value={form.budget}
              onChange={(event) => set('budget')(event.target.value)}
            >
              <option value="">Not given</option>
              {BUDGET_BANDS.map((band) => (
                <option key={band} value={band}>
                  {BUDGET_BAND_LABELS[band].en}
                </option>
              ))}
            </select>,
          )}
          {field('timeline', 'When do you need it?', input('timeline', { maxLength: 120 }))}
        </div>
        {field(
          'message',
          'Message',
          <textarea
            id={id('message')}
            rows={4}
            maxLength={5000}
            dir="auto"
            placeholder="What did they ask for?"
            value={form.message}
            aria-required
            aria-invalid={errors.message ? true : undefined}
            aria-describedby={described('message')}
            onChange={(event) => set('message')(event.target.value)}
          />,
          { required: true },
        )}
        <div className="lead-add__row">
          {field(
            'locale',
            'Language',
            <select
              id={id('locale')}
              value={form.locale}
              onChange={(event) => set('locale')(event.target.value === 'ar' ? 'ar' : 'en')}
            >
              <option value="en">English</option>
              <option value="ar">Arabic</option>
            </select>,
          )}
          {field(
            'channel',
            'How they reached us',
            <select
              id={id('channel')}
              value={form.channel}
              onChange={(event) => set('channel')(event.target.value)}
            >
              {MANUAL_LEAD_CHANNELS.map((channel) => (
                <option key={channel} value={channel}>
                  {CHANNEL_LABELS[channel]}
                </option>
              ))}
            </select>,
          )}
        </div>
      </form>
    </Drawer>
  );
}
