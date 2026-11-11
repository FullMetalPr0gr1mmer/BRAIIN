import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import Drawer from '@/components/admin/kit/Drawer';
import ErrorSummary, { type FieldError } from '@/components/admin/kit/ErrorSummary';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { confirmDialog } from '@/lib/admin/confirm';
import {
  COMPANY_SIZES,
  COMPANY_STAGES,
  MAX_COMPANY_CITY,
  MAX_COMPANY_NAME,
  MAX_COMPANY_NOTES,
  MAX_COMPANY_WEBSITE,
} from '@schemas/crmCompanies';
import type { CompanyContact, CompanyRow } from '@/lib/crm/companies';
import { CONTACT_STAGE_LABELS } from '@/lib/crm/contactView';
import { CONFLICT, COMPANY_SIZE_LABELS, companyName, type CompanyChoices } from './companyShared';

// The company drawer (Admin v2 C11, crm.md §11: "The company drawer saves explicitly with a
// version"). Loaded with import() on first use, so neither this form nor the kit pieces it
// draws with ride on the Companies tab's first load. A new company is one POST; a change one
// PATCH at the version read; a 409 reads the company again and puts it in the form, so
// "Someone else changed this. Refreshed." is true and the next Save carries the new version.
// Removal asks first and carries the version too; the contacts stay, with the name as text.
// The client select links the public clients row only: it publishes nothing (the logo's
// visibility stays the portfolio's switch), and the drawer says so under it.
// (C11 review, C11-SEC-1) A company that learnt an e-mail domain from an inquiry says so
// (never which: staff never read the index), and an Admin (crm.settings) can forget it.

export interface CompanyDrawerProps {
  open: boolean;
  onClose: () => void;
  /** The company to edit; null for a new one. */
  companyId: string | null;
  choices: CompanyChoices;
  me: string;
  /** Whether the viewer may forget a learnt domain (crm.settings: Admin's). */
  canForgetDomain: boolean;
  /** After a save (the company as the server answered, and whether it was new) or a conflict. */
  onSaved: (company: CompanyRow | null, created: boolean) => void;
  onDeleted: () => void;
}

export interface CompanyForm {
  name: string;
  website: string;
  sectorId: string;
  clientId: string;
  size: string;
  city: string;
  stage: string;
  ownerId: string;
  notes: string;
}

type FieldKey = keyof CompanyForm;

const FIELD_LABELS: Readonly<Record<FieldKey, string>> = {
  name: 'Name',
  website: 'Website',
  sectorId: 'Sector',
  clientId: 'Client logo',
  size: 'Size',
  city: 'City',
  stage: 'Stage',
  ownerId: 'Owner',
  notes: 'Notes',
};

export function formOf(company: CompanyRow | null, me: string, canOwn: boolean): CompanyForm {
  return {
    name: company?.name ?? '',
    website: company?.website ?? '',
    sectorId: company?.sector_id ?? '',
    clientId: company?.client_id ?? '',
    size: company?.size ?? '',
    city: company?.city ?? '',
    stage: company?.stage ?? 'lead',
    ownerId: company ? (company.owner_id ?? '') : canOwn ? me : '',
    notes: company?.notes ?? '',
  };
}

/** What the form itself refuses before it asks the server. */
export function checkCompany(form: CompanyForm): Partial<Record<FieldKey, string>> {
  const errors: Partial<Record<FieldKey, string>> = {};
  if (!form.name.trim()) errors.name = 'Give the company a name.';
  const website = form.website.trim();
  if (website && !/^https:\/\/[^\s/?#@]+\.[^\s/?#@]+([/?#]\S*)?$/.test(website)) {
    errors.website = 'Use an address that starts with https://';
  }
  return errors;
}

/**
 * The request body: a new company sends what is filled in; a change sends only the fields
 * that differ from the company as read (an emptied box is null: cleared).
 */
export function companyRequest(
  form: CompanyForm,
  before: CompanyRow | null,
): Record<string, string | null> {
  const value = (text: string): string | null => (text.trim() ? text.trim() : null);
  const next: Record<FieldKey, string | null> = {
    name: form.name.trim(),
    website: value(form.website),
    sectorId: value(form.sectorId),
    clientId: value(form.clientId),
    size: value(form.size),
    city: value(form.city),
    stage: form.stage || 'lead',
    ownerId: value(form.ownerId),
    notes: form.notes.trim() ? form.notes : null,
  };
  if (!before) {
    return Object.fromEntries(
      Object.entries(next).filter(([key, v]) => v !== null || key === 'name'),
    );
  }
  const was: Record<FieldKey, string | null> = {
    name: before.name,
    website: before.website,
    sectorId: before.sector_id,
    clientId: before.client_id,
    size: before.size,
    city: before.city,
    stage: before.stage,
    ownerId: before.owner_id,
    notes: before.notes,
  };
  return Object.fromEntries(
    (Object.keys(next) as FieldKey[]).filter((k) => next[k] !== was[k]).map((k) => [k, next[k]]),
  );
}

/** What the drawer says about a learnt domain (it never knows which domain it is). */
export function domainWords(state: 'learnt' | 'joins'): string {
  return state === 'joins'
    ? 'This company learnt an e-mail domain from an inquiry. New inquiries from that domain that name no company join it.'
    : 'This company learnt an e-mail domain from an inquiry. Once someone edits the company, new inquiries from that domain that name no company join it.';
}

export default function CompanyDrawer({
  open,
  onClose,
  companyId,
  choices,
  me,
  canForgetDomain,
  onSaved,
  onDeleted,
}: CompanyDrawerProps) {
  const prefix = useId();
  const id = (key: FieldKey) => `${prefix}-${key}`;
  const canOwnMe = choices.people.some((p) => p.id === me && p.canOwn);
  const [company, setCompany] = useState<CompanyRow | null>(null);
  const [contacts, setContacts] = useState<CompanyContact[]>([]);
  const [more, setMore] = useState(false);
  const [form, setForm] = useState<CompanyForm>(() => formOf(null, me, canOwnMe));
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [summary, setSummary] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  async function read(target: string, conflict = false): Promise<boolean> {
    setLoading(true);
    try {
      const answer = await adminFetch<{
        company: CompanyRow;
        contacts: CompanyContact[];
        more: boolean;
      }>(`/api/admin/crm/companies/${target}`);
      setCompany(answer.company);
      setContacts(answer.contacts);
      setMore(answer.more);
      setForm(formOf(answer.company, me, canOwnMe));
      // After a 409 the form now holds the company as someone else left it (C8-UX-1's rule).
      setFailure(conflict ? CONFLICT : '');
      return true;
    } catch (err) {
      setFailure(
        err instanceof AdminApiError && err.info.status === 404
          ? 'This company is not there any more.'
          : describeError(err),
      );
      return false;
    } finally {
      setLoading(false);
    }
  }

  // Each opening starts from the company as it is now (or a blank form for a new one).
  useEffect(() => {
    if (!open) return;
    setErrors({});
    setSummary([]);
    setFailure('');
    setNotice('');
    if (companyId) {
      void read(companyId);
    } else {
      setCompany(null);
      setContacts([]);
      setMore(false);
      setForm(formOf(null, me, canOwnMe));
    }
  }, [open, companyId]);

  const set = (key: FieldKey) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  function show(found: Partial<Record<FieldKey, string>>) {
    setErrors(found);
    setSummary(
      (Object.entries(found) as [FieldKey, string][]).map(([key, message]) => ({
        id: id(key),
        message: `${FIELD_LABELS[key]}: ${message}`,
      })),
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure('');
    setNotice('');
    const local = checkCompany(form);
    if (Object.keys(local).length > 0) return show(local);
    show({});
    const body = companyRequest(form, company);
    if (company && Object.keys(body).length === 0) {
      setNotice('Nothing to save.');
      return;
    }
    setBusy(true);
    try {
      const answer = company
        ? await adminFetch<CompanyRow>(`/api/admin/crm/companies/${company.id}`, {
            method: 'PATCH',
            body: { ...body, version: company.version },
          })
        : await adminFetch<CompanyRow>('/api/admin/crm/companies', { method: 'POST', body });
      onSaved(answer, !company);
      if (!company) {
        onClose();
        return;
      }
      setCompany(answer);
      setForm(formOf(answer, me, canOwnMe));
      setNotice('Saved.');
    } catch (err) {
      if (err instanceof AdminApiError && err.info.status === 409 && company) {
        onSaved(null, false);
        await read(company.id, true);
        return;
      }
      if (err instanceof AdminApiError && err.info.status === 422) {
        const mapped: Partial<Record<FieldKey, string>> = {};
        for (const issue of err.info.issues ?? []) {
          const key = issue.path.split('.')[0] as FieldKey;
          if (key in FIELD_LABELS) mapped[key] ??= issue.message;
        }
        if (err.info.field && err.info.field in FIELD_LABELS && err.info.detail) {
          mapped[err.info.field as FieldKey] ??= err.info.detail;
        }
        if (Object.keys(mapped).length > 0) return show(mapped);
      }
      setFailure(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!company) return;
    const sure = await confirmDialog({
      message:
        company.contacts > 0
          ? `Remove ${companyName(company)}? Its ${company.contacts} ${company.contacts === 1 ? 'contact stays' : 'contacts stay'}, with the company name kept as text.`
          : `Remove ${companyName(company)}?`,
      confirmLabel: 'Remove company',
    });
    if (!sure) return;
    setBusy(true);
    setFailure('');
    try {
      await adminFetch(`/api/admin/crm/companies/${company.id}`, {
        method: 'DELETE',
        body: { version: company.version },
      });
      onDeleted();
      onClose();
    } catch (err) {
      if (err instanceof AdminApiError && err.info.status === 409) {
        await read(company.id, true);
        return;
      }
      setFailure(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  /** Forgets the learnt domain at the version read; the form keeps what is typed in it. */
  async function forget() {
    if (!company) return;
    setBusy(true);
    setFailure('');
    setNotice('');
    try {
      const answer = await adminFetch<{ company: CompanyRow; forgot: boolean }>(
        `/api/admin/crm/companies/${company.id}/domain`,
        { method: 'DELETE', body: { version: company.version } },
      );
      setCompany(answer.company);
      onSaved(null, false);
      setNotice('Domain forgotten. Inquiries from it no longer join this company.');
    } catch (err) {
      if (err instanceof AdminApiError && err.info.status === 409) {
        await read(company.id, true);
        return;
      }
      setFailure(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  const described = (key: FieldKey, hint = false) =>
    [errors[key] ? `${id(key)}-error` : '', hint ? `${id(key)}-hint` : '']
      .filter(Boolean)
      .join(' ') || undefined;
  const field = (
    key: FieldKey,
    control: ReactNode,
    options: { required?: boolean; hint?: string } = {},
  ) => (
    <div className="f">
      <label className="f__l" htmlFor={id(key)}>
        <span>
          {FIELD_LABELS[key]}
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
  const owners = choices.people.filter((p) => p.canOwn);
  const ownerGone = form.ownerId !== '' && !owners.some((p) => p.id === form.ownerId);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={company ? <span dir="auto">{companyName(company)}</span> : 'New company'}
      dismissible={false}
      footer={
        <>
          {company && (
            <button
              type="button"
              data-variant="danger"
              onClick={() => void remove()}
              disabled={busy}
            >
              Remove
            </button>
          )}
          <button type="button" onClick={onClose} disabled={busy}>
            {company ? 'Close' : 'Cancel'}
          </button>
          <button
            type="submit"
            form={`${prefix}-form`}
            data-variant="primary"
            disabled={busy || loading}
          >
            {company ? 'Save' : 'Add company'}
          </button>
        </>
      }
    >
      <form id={`${prefix}-form`} className="lead-add" onSubmit={(e) => void submit(e)} noValidate>
        <ErrorSummary errors={summary} />
        {failure && (
          <p className="msg" data-kind="error" role="alert">
            {failure}
          </p>
        )}
        {notice && (
          <p className="msg" data-kind="ok" role="status">
            {notice}
          </p>
        )}
        {field(
          'name',
          <input
            id={id('name')}
            value={form.name}
            maxLength={MAX_COMPANY_NAME}
            dir="auto"
            autoComplete="off"
            aria-required
            aria-invalid={errors.name ? true : undefined}
            aria-describedby={described('name', Boolean(company && company.contacts > 0))}
            onChange={(event) => set('name')(event.target.value)}
          />,
          {
            required: true,
            ...(company && company.contacts > 0
              ? { hint: 'A new name shows on its contacts too.' }
              : {}),
          },
        )}
        {field(
          'website',
          <input
            id={id('website')}
            type="url"
            inputMode="url"
            dir="ltr"
            value={form.website}
            maxLength={MAX_COMPANY_WEBSITE}
            autoComplete="off"
            placeholder="https://"
            aria-invalid={errors.website ? true : undefined}
            aria-describedby={described('website')}
            onChange={(event) => set('website')(event.target.value)}
          />,
        )}
        <div className="lead-add__row">
          {field(
            'sectorId',
            <select
              id={id('sectorId')}
              value={form.sectorId}
              aria-describedby={described('sectorId')}
              onChange={(event) => set('sectorId')(event.target.value)}
            >
              <option value="">Not given</option>
              {choices.sectors.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
              {form.sectorId && !choices.sectors.some((s) => s.id === form.sectorId) && (
                <option value={form.sectorId}>{company?.sector_name ?? 'A sector'}</option>
              )}
            </select>,
          )}
          {field(
            'size',
            <select
              id={id('size')}
              value={form.size}
              onChange={(event) => set('size')(event.target.value)}
            >
              <option value="">Not given</option>
              {COMPANY_SIZES.map((size) => (
                <option key={size} value={size}>
                  {COMPANY_SIZE_LABELS[size]}
                </option>
              ))}
            </select>,
          )}
        </div>
        <div className="lead-add__row">
          {field(
            'city',
            <input
              id={id('city')}
              value={form.city}
              maxLength={MAX_COMPANY_CITY}
              dir="auto"
              autoComplete="off"
              aria-describedby={described('city')}
              onChange={(event) => set('city')(event.target.value)}
            />,
          )}
          {field(
            'stage',
            <select
              id={id('stage')}
              value={form.stage}
              onChange={(event) => set('stage')(event.target.value)}
            >
              {COMPANY_STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {CONTACT_STAGE_LABELS[stage]}
                </option>
              ))}
            </select>,
          )}
        </div>
        {field(
          'ownerId',
          <select
            id={id('ownerId')}
            value={form.ownerId}
            aria-describedby={described('ownerId')}
            onChange={(event) => set('ownerId')(event.target.value)}
          >
            <option value="">No owner</option>
            {owners.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {ownerGone && <option value={form.ownerId}>Someone no longer on the team</option>}
          </select>,
        )}
        {field(
          'clientId',
          <select
            id={id('clientId')}
            value={form.clientId}
            aria-describedby={described('clientId', true)}
            onChange={(event) => set('clientId')(event.target.value)}
          >
            <option value="">None</option>
            {choices.clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            {form.clientId && !choices.clients.some((c) => c.id === form.clientId) && (
              <option value={form.clientId}>{company?.client_name ?? 'A client'}</option>
            )}
          </select>,
          {
            hint: 'Links this company to its logo on the site’s client list. Linking publishes nothing: whether the logo shows is set under Clients.',
          },
        )}
        {field(
          'notes',
          <textarea
            id={id('notes')}
            value={form.notes}
            rows={4}
            maxLength={MAX_COMPANY_NOTES}
            dir="auto"
            aria-describedby={described('notes', true)}
            onChange={(event) => set('notes')(event.target.value)}
          />,
          { hint: 'Only your team sees these. Write about the company, not about a person.' },
        )}
      </form>
      {company?.domain && (
        <section aria-labelledby={`${prefix}-domain`}>
          <h3 id={`${prefix}-domain`} className="card-title">
            E-mail domain
          </h3>
          <p className="f__hint">{domainWords(company.domain)}</p>
          {canForgetDomain && (
            <p>
              <button type="button" data-size="sm" disabled={busy} onClick={() => void forget()}>
                Forget the domain
              </button>
            </p>
          )}
        </section>
      )}
      {company && (
        <section aria-labelledby={`${prefix}-people`}>
          <h3 id={`${prefix}-people`} className="card-title">
            Contacts
          </h3>
          {contacts.length === 0 ? (
            <p className="f__hint">Nobody is linked to this company yet.</p>
          ) : (
            <ul className="ct-leads">
              {contacts.map((c) => (
                <li key={c.id} className="ct-leads__i">
                  <a href={`/admin/contacts/${c.id}`} dir="auto">
                    {c.display_name}
                  </a>
                  {c.title && (
                    <span className="lead-sub" dir="auto">
                      {c.title}
                    </span>
                  )}
                  <span className="lead-sub">
                    {CONTACT_STAGE_LABELS[c.stage as keyof typeof CONTACT_STAGE_LABELS] ?? ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {more && <p className="f__hint">Showing the 50 most recently active.</p>}
        </section>
      )}
    </Drawer>
  );
}
