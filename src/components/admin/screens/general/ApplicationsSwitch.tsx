import { useId, useState } from 'react';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';

// The job-applications switch on the General screen (Admin v2 U9): opens or closes the public
// application form on /join AT ONCE, through R3b's `PATCH /api/admin/site-profile/intake`
// (never staged, P-3; Admin only in both server layers: applications.manage in the Worker,
// the 0019 guard trigger in the database). A Developer, who edits the rest of the identity,
// sees it disabled with the reason; the server would refuse them anyway.

export const LOCKED_NOTE = 'Only an admin can open or close job applications.';

interface Props {
  /** What the identity row says (null until it has been read). */
  open: boolean | null;
  canChange: boolean;
  onChanged: (open: boolean, version: number) => void;
}

export default function ApplicationsSwitch({ open, canChange, onChanged }: Props) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const on = open === true;

  async function toggle() {
    if (!canChange || open === null || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const answer = await adminFetch<{ acceptingApplications: boolean; version: number }>(
        '/api/admin/site-profile/intake',
        { method: 'PATCH', body: { acceptingApplications: !on } },
      );
      onChanged(answer.acceptingApplications === true, Number(answer.version));
      setMessage({
        kind: 'ok',
        text: answer.acceptingApplications
          ? 'Job applications are open.'
          : 'Job applications are closed.',
      });
    } catch (err) {
      setMessage({
        kind: 'error',
        text:
          err instanceof AdminApiError && err.info.status === 403
            ? LOCKED_NOTE
            : describeError(err),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card general__apps" aria-labelledby={`${id}-h`}>
      <h2 className="card-title" id={`${id}-h`}>
        Job applications
      </h2>
      <div className="f f--inline">
        <div className="f__l">
          <label id={`${id}-label`} htmlFor={`${id}-switch`}>
            Accepting job applications
          </label>
        </div>
        <button
          type="button"
          role="switch"
          id={`${id}-switch`}
          aria-checked={on}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-hint`}
          disabled={!canChange || open === null || busy}
          onClick={() => void toggle()}
        />
      </div>
      <p className="admin-sub" id={`${id}-hint`}>
        {canChange
          ? 'Opens or closes the application form on the Join page. It changes at once.'
          : LOCKED_NOTE}
      </p>
      {/* A live region from the first render, so each answer is announced. */}
      <p
        className={message ? 'msg general__apps-msg' : 'general__apps-msg'}
        data-kind={message?.kind === 'error' ? 'error' : 'ok'}
        role="status"
      >
        {message?.text ?? ''}
      </p>
    </section>
  );
}
