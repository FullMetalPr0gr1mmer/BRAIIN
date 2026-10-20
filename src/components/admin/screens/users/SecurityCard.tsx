import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';
import { SECURITY_DEFAULTS, notSetUpSentence, type SecuritySettings } from '@/lib/admin/userModel';
import Segmented from '@/components/admin/kit/Segmented';
import SaveStatus, { type SaveState } from '@/components/admin/kit/SaveStatus';
import Note from '@/components/admin/kit/Note';
import Modal from '@/components/admin/kit/Modal';

// The Security card (Admin v2 U12a): how long a sign-in lasts before the person must sign in
// again (1 day or 7 days; the admin checks it on every request) and the one domain invites
// may go to. Saves at once (P-3: no release), versioned: a save that meets someone else's
// change is told so (409) rather than overwriting it.
//
// "Require 2FA for everyone" (Admin v2 U17), first, as in the prototype: turning it on asks
// first, with how many people have not set 2FA up yet, and is saved with the other two. The
// hint says what is true here (decision D6): people without it are asked at their next click,
// not at their next sign-in. The server refuses turning it on unless the saving Admin uses
// 2FA (D5); that refusal shows under the switch.

export interface SecurityCardProps {
  /** Active members without 2FA (the users list's count across the directory); null: unknown. */
  withoutTwoStep: number | null;
}

type Days = '1' | '7';

const LENGTHS = [
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
] as const;

export default function SecurityCard({ withoutTwoStep }: SecurityCardProps) {
  const [saved, setSaved] = useState<SecuritySettings>(SECURITY_DEFAULTS);
  const [days, setDays] = useState<Days>('7');
  const [domain, setDomain] = useState('');
  const [requireMfa, setRequireMfa] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [mfaError, setMfaError] = useState('');
  const [state, setState] = useState<SaveState>('idle');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const titleId = useId();
  const domainId = useId();
  const domainHintId = useId();
  const mfaId = useId();
  const mfaHintId = useId();
  const mfaErrorId = useId();

  const show = useCallback((settings: SecuritySettings) => {
    setSaved(settings);
    setDays(settings.sessionMaxDays === 1 ? '1' : '7');
    setDomain(settings.inviteDomain ?? '');
    setRequireMfa(settings.requireMfa === true);
  }, []);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const settings = await adminFetch<SecuritySettings>('/api/admin/users/security');
        if (live) show(settings);
      } catch (err) {
        if (live) setError(describeError(err));
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [show]);

  const dirty =
    Number(days) !== saved.sessionMaxDays ||
    domain.trim() !== (saved.inviteDomain ?? '') ||
    requireMfa !== saved.requireMfa;

  function setRequire(on: boolean) {
    setRequireMfa(on);
    setMfaError('');
    if (state === 'saved') setState('idle');
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setState('saving');
    setError('');
    setMfaError('');
    try {
      const settings = await adminFetch<SecuritySettings>('/api/admin/users/security', {
        method: 'PUT',
        body: {
          sessionMaxDays: Number(days),
          inviteDomain: domain.trim() === '' ? null : domain,
          requireMfa,
          version: saved.version,
        },
      });
      show(settings);
      setSavedAt(Date.now());
      setState('saved');
    } catch (err) {
      if (err instanceof AdminApiError && err.info.field === 'requireMfa') {
        setMfaError(describeError(err));
        setState('error');
        return;
      }
      const message =
        err instanceof AdminApiError && err.info.error === 'conflict'
          ? 'Someone else changed these settings. Reload the page to see their version.'
          : describeError(err);
      setError(message);
      setState('error');
    }
  }

  return (
    <section className="card" aria-labelledby={titleId}>
      <h2 className="card-title" id={titleId}>
        Security
      </h2>
      <form onSubmit={(event) => void save(event)} noValidate aria-busy={loading || undefined}>
        <div className="f f--inline">
          <label className="f__l" id={`${mfaId}-label`} htmlFor={mfaId}>
            Require 2FA for everyone
          </label>
          <button
            type="button"
            role="switch"
            id={mfaId}
            aria-checked={requireMfa}
            aria-labelledby={`${mfaId}-label`}
            aria-describedby={mfaError ? `${mfaHintId} ${mfaErrorId}` : mfaHintId}
            aria-invalid={mfaError ? true : undefined}
            disabled={loading}
            onClick={() => (requireMfa ? setRequire(false) : setConfirming(true))}
          />
          <p className="f__hint" id={mfaHintId}>
            People without it are asked to set it up at their next click.
          </p>
          {mfaError && (
            <p className="f__err" id={mfaErrorId} role="alert">
              {mfaError}
            </p>
          )}
        </div>
        <div className="field-group">
          {/* The visible label; the choice's own fieldset legend (visually hidden) names it
              for assistive technology, so this one is not read twice. */}
          <p className="field-legend" aria-hidden="true">
            Session length
          </p>
          <Segmented
            label="Session length"
            options={LENGTHS}
            value={days}
            onChange={(value) => {
              setDays(value);
              if (state === 'saved') setState('idle');
            }}
          />
          <p className="admin-sub">
            Someone who signed in longer ago than this is asked to sign in again at their next
            click.
          </p>
        </div>
        <div className="field">
          <label htmlFor={domainId}>Allowed email domain</label>
          <input
            id={domainId}
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            dir="ltr"
            placeholder="example.com"
            value={domain}
            aria-describedby={domainHintId}
            onChange={(event) => {
              setDomain(event.target.value);
              if (state === 'saved') setState('idle');
            }}
          />
        </div>
        <p className="admin-sub" id={domainHintId}>
          Only invites to this domain go through. Leave empty to allow any.
        </p>
        {error && (
          <Note tone="err" role="alert">
            {error}
          </Note>
        )}
        <div className="users-save">
          <button type="submit" data-variant="primary" disabled={loading || state === 'saving'}>
            Save
          </button>
          <SaveStatus
            state={state === 'idle' && dirty ? 'dirty' : state}
            savedAt={savedAt}
            error={state === 'error' ? 'Not saved' : undefined}
          />
        </div>
      </form>
      <Modal
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Require 2FA for everyone?"
        sub={`${notSetUpSentence(withoutTwoStep)} They are asked to at their next click.`}
        dismissible={false}
        footer={
          <>
            <button type="button" data-autofocus="" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              type="button"
              data-variant="primary"
              onClick={() => {
                setConfirming(false);
                setRequire(true);
              }}
            >
              Require 2FA
            </button>
          </>
        }
      >
        <p>
          You need 2FA on your own account first. Nothing changes until you save. Lost phones are
          reset from this screen by an Admin.
        </p>
      </Modal>
    </section>
  );
}
