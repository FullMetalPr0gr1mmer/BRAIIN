import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Drawer from '@/components/admin/kit/Drawer';
import ErrorSummary, { type FieldError } from '@/components/admin/kit/ErrorSummary';
import Icon from '@/components/admin/kit/Icon';
import {
  DEFAULT_TASK_TIME,
  MAX_TASK_NOTE,
  MAX_TASK_TITLE,
  TASK_TYPES,
  type TaskType,
} from '@schemas/crmTasks';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import {
  FORMER_MEMBER,
  TYPE_LABELS,
  failureText,
  icsHref,
  isConflict,
  type TaskContactRef,
  type TaskLeadRef,
  type TaskPerson,
  type TaskRow,
} from './shared';

// The task drawer (Admin v2 C8, crm.md §11 screen 10): what needs doing, its type, when (a date
// and a time, 10:00 by default, in the studio's zone: the server turns them into an instant,
// never the browser), whom it is about (a contact from the contacts picker; a lead when opened
// from a lead's page), who owns it (me by default) and a note. Loaded with import() on first
// use, so neither this form nor the kit pieces it draws with ride on a screen's first load.
//
// A new task is one POST; an edit one PATCH at the version read (a 409 says "Someone else
// changed this. Refreshed." and the list is read again). The explicit Save is the only write
// (P-5: no keystroke autosave). "Download .ics" shows once the task is saved.

export interface TaskDrawerProps {
  open: boolean;
  onClose: () => void;
  /** After a save (the task as the server answered) or a conflict (null): read the list again. */
  onSaved: (task: TaskRow | null) => void;
  /** The task to edit; none for a new one. */
  task?: TaskRow | null | undefined;
  /** Today's date in the studio's zone (YYYY-MM-DD): a new task's default due date. */
  today: string;
  owners: readonly TaskPerson[];
  me: TaskPerson;
  /** A new task about this lead or contact (a lead's or a contact's page). */
  lead?: TaskLeadRef | null | undefined;
  contact?: TaskContactRef | null | undefined;
}

interface Form {
  title: string;
  type: TaskType;
  dueDate: string;
  dueTime: string;
  ownerId: string;
  note: string;
}

type FieldKey = keyof Form | 'contactId' | 'leadId';

const FIELD_LABELS: Readonly<Record<FieldKey, string>> = {
  title: 'What needs doing',
  type: 'Type',
  dueDate: 'Due date',
  dueTime: 'Time',
  ownerId: 'Owner',
  note: 'Note',
  contactId: 'Contact',
  leadId: 'Lead',
};

function initialForm(
  task: TaskRow | null | undefined,
  today: string,
  me: TaskPerson,
  owners: readonly TaskPerson[],
): Form {
  if (task) {
    return {
      title: task.title,
      type: task.type,
      dueDate: task.due_date,
      dueTime: task.due_time,
      ownerId: task.owner_id ?? '',
      note: task.note ?? '',
    };
  }
  return {
    title: '',
    type: 'call',
    dueDate: today,
    dueTime: DEFAULT_TASK_TIME,
    ownerId: owners.some((o) => o.id === me.id) ? me.id : '',
    note: '',
  };
}

/** What the form itself refuses before it asks the server. */
export function checkTask(form: Form): Partial<Record<FieldKey, string>> {
  const errors: Partial<Record<FieldKey, string>> = {};
  if (!form.title.trim()) errors.title = 'Say what needs doing.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.dueDate)) errors.dueDate = 'Pick a date.';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(form.dueTime)) errors.dueTime = 'Pick a time.';
  return errors;
}

export default function TaskDrawer({
  open,
  onClose,
  onSaved,
  task,
  today,
  owners,
  me,
  lead,
  contact,
}: TaskDrawerProps) {
  const prefix = useId();
  const id = (key: FieldKey) => `${prefix}-${key}`;
  const [form, setForm] = useState<Form>(() => initialForm(task, today, me, owners));
  const [linkedContact, setLinkedContact] = useState<TaskContactRef | null>(() =>
    task?.contact_id
      ? { id: task.contact_id, name: task.contact_name, company: task.contact_company }
      : (contact ?? null),
  );
  const [linkedLead, setLinkedLead] = useState<TaskLeadRef | null>(() =>
    task?.lead_id
      ? { id: task.lead_id, number: task.lead_number, name: task.lead_name }
      : (lead ?? null),
  );
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [summary, setSummary] = useState<FieldError[]>([]);
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<TaskRow | null>(task ?? null);

  // The contacts picker: a search sent as a POST body (never in an address), names only.
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<TaskContactRef[] | null>(null);
  const [lookupError, setLookupError] = useState('');
  const lookup = useRef<AbortController | null>(null);
  useEffect(() => {
    const q = query.trim();
    lookup.current?.abort();
    if (q.length < 2) {
      setFound(null);
      return;
    }
    const controller = new AbortController();
    lookup.current = controller;
    const timer = window.setTimeout(() => {
      adminFetch<{
        contacts: { id: string; display_name: string | null; company_name: string | null }[];
      }>('/api/admin/crm/contacts/lookup', {
        method: 'POST',
        body: { q },
        signal: controller.signal,
      })
        .then((answer) => {
          if (controller.signal.aborted) return;
          setFound(
            answer.contacts.map((c) => ({
              id: c.id,
              name: c.display_name,
              company: c.company_name,
            })),
          );
          setLookupError('');
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setFound(null);
          setLookupError(
            err instanceof AdminApiError && err.info.status === 422
              ? 'Search by name or company. A whole e-mail or phone also works.'
              : describeError(err),
          );
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const set = (key: keyof Form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }) as Form);

  function show(found: Partial<Record<FieldKey, string>>) {
    setErrors(found);
    setSummary(
      (Object.entries(found) as [FieldKey, string][]).map(([key, message]) => ({
        id: id(key),
        message: `${FIELD_LABELS[key]}: ${message}`,
      })),
    );
  }

  function body(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      title: form.title.trim(),
      type: form.type,
      dueDate: form.dueDate,
      dueTime: form.dueTime,
      ownerId: form.ownerId || null,
      note: form.note.trim() ? form.note : null,
      contactId: linkedContact?.id ?? null,
      leadId: linkedLead?.id ?? null,
    };
    return out;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFailure('');
    const local = checkTask(form);
    if (Object.keys(local).length > 0) return show(local);
    show({});
    setBusy(true);
    try {
      const answer = saved
        ? await adminFetch<TaskRow>(`/api/admin/crm/tasks/${saved.id}`, {
            method: 'PATCH',
            body: { ...body(), version: saved.version },
          })
        : await adminFetch<TaskRow>('/api/admin/crm/tasks', { method: 'POST', body: body() });
      setSaved(answer);
      onSaved(answer);
      if (!task) onClose();
    } catch (err) {
      if (isConflict(err)) {
        setFailure(failureText(err));
        onSaved(null);
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

  const field = (
    key: FieldKey,
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
  const described = (key: FieldKey, hint = false) =>
    [errors[key] ? `${id(key)}-error` : '', hint ? `${id(key)}-hint` : '']
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={task ? 'Edit task' : 'New task'}
      dismissible={false}
      footer={
        <>
          {saved && (
            <a className="btn" href={icsHref(saved.id)} download>
              <Icon name="cal" size={16} />
              Download .ics
            </a>
          )}
          <button type="button" onClick={onClose} disabled={busy}>
            {task ? 'Close' : 'Cancel'}
          </button>
          <button type="submit" form={`${prefix}-form`} data-variant="primary" disabled={busy}>
            {task ? 'Save' : 'Create task'}
          </button>
        </>
      }
    >
      <form id={`${prefix}-form`} className="task-form" onSubmit={(e) => void submit(e)} noValidate>
        <ErrorSummary errors={summary} />
        {failure && (
          <p className="msg" data-kind="error" role="alert">
            {failure}
          </p>
        )}
        {field(
          'title',
          FIELD_LABELS.title,
          <input
            id={id('title')}
            value={form.title}
            maxLength={MAX_TASK_TITLE}
            dir="auto"
            autoComplete="off"
            aria-required
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={described('title')}
            onChange={(event) => set('title')(event.target.value)}
          />,
          { required: true },
        )}
        {field(
          'type',
          FIELD_LABELS.type,
          <select
            id={id('type')}
            value={form.type}
            onChange={(event) => set('type')(event.target.value)}
          >
            {TASK_TYPES.map((type) => (
              <option key={type} value={type}>
                {TYPE_LABELS[type]}
              </option>
            ))}
          </select>,
        )}
        <div className="task-form__row">
          {field(
            'dueDate',
            FIELD_LABELS.dueDate,
            <input
              id={id('dueDate')}
              type="date"
              value={form.dueDate}
              min="2000-01-01"
              max="2100-12-31"
              aria-required
              aria-invalid={errors.dueDate ? true : undefined}
              aria-describedby={described('dueDate')}
              onChange={(event) => set('dueDate')(event.target.value)}
            />,
            { required: true },
          )}
          {field(
            'dueTime',
            FIELD_LABELS.dueTime,
            <input
              id={id('dueTime')}
              type="time"
              value={form.dueTime}
              aria-required
              aria-invalid={errors.dueTime ? true : undefined}
              aria-describedby={described('dueTime', true)}
              onChange={(event) => set('dueTime')(event.target.value)}
            />,
            { required: true, hint: 'In the studio’s time zone.' },
          )}
        </div>
        <div className="f">
          <span className="f__l" id={id('contactId')}>
            {FIELD_LABELS.contactId}
          </span>
          {linkedContact ? (
            <p className="task-form__link">
              <span dir="auto">{linkedContact.name ?? 'A contact'}</span>
              {linkedContact.company && (
                <>
                  , <span dir="auto">{linkedContact.company}</span>
                </>
              )}
              <button
                type="button"
                data-size="sm"
                data-variant="ghost"
                onClick={() => setLinkedContact(null)}
              >
                Remove<span className="visually-hidden"> the contact</span>
              </button>
            </p>
          ) : (
            <>
              <input
                type="search"
                aria-labelledby={id('contactId')}
                aria-describedby={`${id('contactId')}-hint`}
                placeholder="Search by name or company"
                value={query}
                autoComplete="off"
                onChange={(event) => setQuery(event.target.value)}
              />
              <p id={`${id('contactId')}-hint`} className="f__hint">
                Optional. Type two letters or more.
              </p>
              {lookupError && (
                <p className="field-error f__err" role="alert">
                  {lookupError}
                </p>
              )}
              {found && (
                <ul className="task-form__found" aria-label="Contacts found">
                  {found.length === 0 && <li className="f__hint">Nobody matches.</li>}
                  {found.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        data-size="sm"
                        onClick={() => {
                          setLinkedContact(c);
                          setQuery('');
                          setFound(null);
                        }}
                      >
                        <span dir="auto">{c.name ?? 'A contact'}</span>
                        {c.company && (
                          <>
                            , <span dir="auto">{c.company}</span>
                          </>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {errors.contactId && <p className="field-error f__err">{errors.contactId}</p>}
        </div>
        {linkedLead && (
          <div className="f">
            <span className="f__l">{FIELD_LABELS.leadId}</span>
            <p className="task-form__link">
              {linkedLead.number === null ? 'A lead' : `Lead #${linkedLead.number}`}
              {linkedLead.name && (
                <>
                  , <span dir="auto">{linkedLead.name}</span>
                </>
              )}
              <button
                type="button"
                data-size="sm"
                data-variant="ghost"
                onClick={() => setLinkedLead(null)}
              >
                Remove<span className="visually-hidden"> the lead</span>
              </button>
            </p>
          </div>
        )}
        {field(
          'ownerId',
          FIELD_LABELS.ownerId,
          <select
            id={id('ownerId')}
            value={form.ownerId}
            aria-invalid={errors.ownerId ? true : undefined}
            aria-describedby={described('ownerId')}
            onChange={(event) => set('ownerId')(event.target.value)}
          >
            <option value="">Nobody</option>
            {/* An owner who no longer holds tasks stays chosen until someone changes it: a
                save that keeps them is not a change (app.tg_crm_task_row checks a new owner). */}
            {task?.owner_id && !owners.some((person) => person.id === task.owner_id) && (
              <option value={task.owner_id}>{FORMER_MEMBER}</option>
            )}
            {owners.map((person) => (
              <option key={person.id} value={person.id}>
                {person.id === me.id ? `${person.name} (you)` : person.name}
              </option>
            ))}
          </select>,
        )}
        {field(
          'note',
          FIELD_LABELS.note,
          <textarea
            id={id('note')}
            rows={3}
            maxLength={MAX_TASK_NOTE}
            dir="auto"
            value={form.note}
            aria-invalid={errors.note ? true : undefined}
            aria-describedby={described('note', true)}
            onChange={(event) => set('note')(event.target.value)}
          />,
          { hint: 'Only your team sees it. It is not in the calendar file.' },
        )}
      </form>
    </Drawer>
  );
}
