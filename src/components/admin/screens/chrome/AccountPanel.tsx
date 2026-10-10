import { useState, type FormEvent, type ReactNode } from 'react';
import { AdminApiError, adminFetch } from '@/lib/admin/client';
import type { AccountView } from '@/lib/admin/account';
import { initialsOf } from '@/lib/admin/initials';
import { CSRF_FIELD_NAME } from '@/lib/http/csrf';
import { DISPLAY_NAME_MAX, PASSWORD_MIN } from '@schemas/adminPrefs';
import Icon from '@/components/admin/kit/Icon';

// The account (Admin v2 F8, docs/admin-v2/ui.md §2.9, the prototype's "Your account"):
// who you are, your name, your password, your e-mail, what you can do, the admin's
// language, and Sign out.
//
// One component, two places. In the account DRAWER (hydrated, `mode="drawer"`) each form
// is sent with fetch and answers in place. On /admin/account (`mode="page"`, rendered on
// the server and never hydrated) the same forms post to the page itself with the
// double-submit token, so everything works without JS. `idPrefix` keeps the two apart
// when both are on one page.
//
// No capability map reaches the browser: "What you can do" arrives as plain lines.

export interface AccountFlash {
  form: 'name' | 'password';
  kind: 'ok' | 'error';
  text: string;
  /** The field an error belongs to. */
  field?: string | undefined;
}

export interface AccountPanelProps {
  view: AccountView;
  idPrefix: string;
  mode: 'page' | 'drawer';
  /** Page mode: the double-submit token for the no-JS forms. */
  csrfToken?: string | undefined;
  /** Page mode: the outcome of the form just posted. */
  flash?: AccountFlash | null | undefined;
}

type FieldErrors = Partial<Record<'display_name' | 'current' | 'next' | 'confirm', string>>;

/** Field errors from the API's error envelope: a mapped field, or Zod's issue paths. */
function fieldErrors(err: unknown, fallbackField: keyof FieldErrors): FieldErrors {
  if (!(err instanceof AdminApiError)) return { [fallbackField]: 'That did not work. Try again.' };
  const out: FieldErrors = {};
  for (const issue of err.info.issues ?? []) {
    const key = issue.path as keyof FieldErrors;
    if (!out[key]) out[key] = issue.message;
  }
  if (err.info.field && err.info.detail) out[err.info.field as keyof FieldErrors] = err.info.detail;
  if (Object.keys(out).length === 0) {
    out[fallbackField] =
      err.info.detail ??
      (err.info.error === 'csrf' || err.info.error === 'bad-origin'
        ? 'Your session expired. Reload the page and try again.'
        : 'That did not work. Try again.');
  }
  return out;
}

/** Writes a renamed person into the shell's server-rendered chip: text only. */
function syncChip(name: string | null, email: string): void {
  for (const el of document.querySelectorAll('[data-account-name]')) el.textContent = name ?? email;
  for (const el of document.querySelectorAll('[data-account-initials]')) {
    el.textContent = initialsOf(name, email);
  }
}

export default function AccountPanel({
  view,
  idPrefix,
  mode,
  csrfToken,
  flash,
}: AccountPanelProps) {
  const id = (name: string) => `${idPrefix}-${name}`;
  const drawer = mode === 'drawer';
  // Under the drawer's h2, or the page's h1.
  const Heading = drawer ? 'h3' : 'h2';
  const [name, setName] = useState(view.displayName);
  const [nameValue, setNameValue] = useState(view.displayName ?? '');
  const [errors, setErrors] = useState<FieldErrors>(
    flash?.kind === 'error' && flash.field ? { [flash.field]: flash.text } : {},
  );
  const [notes, setNotes] = useState<{ name: string; password: string }>({
    name: flash?.form === 'name' && flash.kind === 'ok' ? flash.text : '',
    password: flash?.form === 'password' && flash.kind === 'ok' ? flash.text : '',
  });
  const [busy, setBusy] = useState<'name' | 'password' | 'signout' | null>(null);

  async function saveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('name');
    setErrors({});
    try {
      const data = await adminFetch<{ display_name: string | null }>('/api/admin/me', {
        method: 'PATCH',
        body: { display_name: nameValue },
      });
      setName(data.display_name);
      setNameValue(data.display_name ?? '');
      syncChip(data.display_name, view.email);
      setNotes((current) => ({ ...current, name: 'Your name is saved.' }));
    } catch (err) {
      setErrors(fieldErrors(err, 'display_name'));
    } finally {
      setBusy(null);
    }
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy('password');
    setErrors({});
    setNotes((current) => ({ ...current, password: '' }));
    try {
      const result = await adminFetch<{ othersSignedOut: boolean }>('/api/admin/me/password', {
        method: 'POST',
        body: {
          current: String(data.get('current') ?? ''),
          next: String(data.get('next') ?? ''),
          confirm: String(data.get('confirm') ?? ''),
        },
      });
      form.reset();
      setNotes((current) => ({
        ...current,
        password: result.othersSignedOut
          ? 'Your password is changed. You are signed out on your other devices.'
          : 'Your password is changed. Sign out on your other devices yourself: they could not be signed out just now.',
      }));
    } catch (err) {
      setErrors(fieldErrors(err, 'current'));
    } finally {
      setBusy(null);
    }
  }

  async function signOut(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy('signout');
    try {
      await adminFetch('/api/admin/auth/logout', { method: 'POST' });
    } finally {
      // The server clears the cookie whatever happened; the sign-in page is where to go.
      window.location.href = '/admin/login';
    }
  }

  /** A field: its label, the control, its hint and its error, wired for assistive tech. */
  function field(key: keyof FieldErrors, label: string, control: ReactNode, hint?: string) {
    const error = errors[key];
    return (
      <div className="field">
        <label htmlFor={id(key)}>{label}</label>
        {control}
        {hint && (
          <p className="acct__hint" id={id(`${key}-hint`)}>
            {hint}
          </p>
        )}
        {error && (
          <p className="field-error" id={id(`${key}-error`)}>
            {error}
          </p>
        )}
      </div>
    );
  }

  const describedBy = (key: keyof FieldErrors, hint: boolean) =>
    [hint ? id(`${key}-hint`) : '', errors[key] ? id(`${key}-error`) : '']
      .filter(Boolean)
      .join(' ') || undefined;

  const hidden = (intent: string) => (
    <>
      {!drawer && <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken ?? ''} />}
      <input type="hidden" name="intent" value={intent} />
    </>
  );

  return (
    <div className="acct">
      <div className="acct__id">
        <span className="avatar acct__avatar" aria-hidden="true">
          {initialsOf(name, view.email)}
        </span>
        <div className="acct__who">
          <b>{name ?? view.email}</b>
          <span>{view.email}</span>
          <span className="badge" data-tone="klein">
            {view.role}
          </span>
        </div>
      </div>

      <section className="acct__sec" aria-labelledby={id('name-h')}>
        <Heading id={id('name-h')}>
          <Icon name="edit" size={16} />
          Your name
        </Heading>
        <form
          method="post"
          action="/admin/account"
          onSubmit={drawer ? (event) => void saveName(event) : undefined}
        >
          {hidden('name')}
          {field(
            'display_name',
            'Display name',
            <input
              id={id('display_name')}
              name="display_name"
              type="text"
              autoComplete="name"
              maxLength={DISPLAY_NAME_MAX}
              value={nameValue}
              onChange={(event) => setNameValue(event.target.value)}
              aria-invalid={errors.display_name ? 'true' : undefined}
              aria-describedby={describedBy('display_name', true)}
            />,
            'Shown in the sidebar and beside your changes. Leave it empty to show your email.',
          )}
          <button type="submit" data-variant="primary" disabled={busy === 'name'}>
            Save name
          </button>
          <p className="acct__note" role="status">
            {notes.name}
          </p>
        </form>
      </section>

      <section className="acct__sec" aria-labelledby={id('password-h')}>
        <Heading id={id('password-h')}>
          <Icon name="key" size={16} />
          Password
        </Heading>
        <form
          method="post"
          action="/admin/account"
          onSubmit={drawer ? (event) => void changePassword(event) : undefined}
        >
          {hidden('password')}
          {/* For password managers: the account this password belongs to. */}
          <input
            type="email"
            name="username"
            autoComplete="username"
            value={view.email}
            readOnly
            hidden
          />
          {field(
            'current',
            'Current password',
            <input
              id={id('current')}
              name="current"
              type="password"
              autoComplete="current-password"
              required
              maxLength={256}
              aria-invalid={errors.current ? 'true' : undefined}
              aria-describedby={describedBy('current', false)}
            />,
          )}
          {field(
            'next',
            'New password',
            <input
              id={id('next')}
              name="next"
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN}
              aria-invalid={errors.next ? 'true' : undefined}
              aria-describedby={describedBy('next', true)}
            />,
            `At least ${PASSWORD_MIN} characters. Changing it signs you out on your other devices.`,
          )}
          {field(
            'confirm',
            'Type the new password again',
            <input
              id={id('confirm')}
              name="confirm"
              type="password"
              autoComplete="new-password"
              required
              aria-invalid={errors.confirm ? 'true' : undefined}
              aria-describedby={describedBy('confirm', false)}
            />,
          )}
          <p className="acct__hint">
            Five wrong tries in 15 minutes lock your account for 15 minutes.
          </p>
          <button type="submit" data-variant="primary" disabled={busy === 'password'}>
            Change password
          </button>
          <p className="acct__note" role="status">
            {notes.password}
          </p>
        </form>
      </section>

      <ul className="list acct__rows">
        <li className="li">
          <span className="li__ico" aria-hidden="true">
            <Icon name="mail" />
          </span>
          <span className="li__main">
            <span className="li__t">Email</span>
            <span className="li__s">
              {view.email}. Changing it needs email delivery, which is not set up yet.
            </span>
          </span>
          <span className="badge" data-tone="warn">
            Not set up
          </span>
        </li>
        <li className="li">
          <span className="li__ico" aria-hidden="true">
            <Icon name="shield" />
          </span>
          {/* A div, not a span: it holds a list. */}
          <div className="li__main">
            <span className="li__t">What you can do</span>
            <ul className="acct__can">
              {view.can.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <span className="li__s">{view.accessNote}</span>
          </div>
        </li>
        <li className="li">
          <span className="li__ico" aria-hidden="true">
            <Icon name="globe" />
          </span>
          <span className="li__main">
            <span className="li__t">Admin language</span>
            <span className="li__s">English</span>
          </span>
        </li>
      </ul>

      <form
        method="post"
        action="/admin/account"
        onSubmit={drawer ? (event) => void signOut(event) : undefined}
      >
        {hidden('signout')}
        <button type="submit" data-variant="danger" disabled={busy === 'signout'}>
          <Icon name="logout" size={16} />
          Sign out
        </button>
      </form>
    </div>
  );
}
