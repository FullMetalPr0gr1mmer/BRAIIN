import { useState } from 'react';
import Modal from '@/components/admin/kit/Modal';
import Segmented from '@/components/admin/kit/Segmented';
import { adminFetch, describeError } from '@/lib/admin/client';

// Clear logs (Admin v2 U2): the one island on the site health screen, rendered there for
// `logs.clear` holders only (Admin; Developer reads the log but cannot erase it). A button,
// then the kit's Modal to confirm, with how much to clear: entries older than 7 days, older
// than 30 (the default, the nightly purge's own horizon) or all of them. The server's
// DELETE /api/admin/logs decides and audits (`logs.clear` again, and a `logs.clear` row in
// the activity log); the page then reloads to show what is left.

export type ClearScope = '7' | '30' | 'all';

const OPTIONS = [
  { value: '7', label: 'Older than 7 days' },
  { value: '30', label: 'Older than 30 days' },
  { value: 'all', label: 'All entries' },
] as const;

/** The request a scope sends: a bounded clear unless "all" is asked for by name. */
export function clearUrl(scope: ClearScope): string {
  return scope === 'all' ? '/api/admin/logs?all=1' : `/api/admin/logs?olderThanDays=${scope}`;
}

/** The dialog's question for a scope. */
export function clearTitle(scope: ClearScope): string {
  return scope === 'all' ? 'Clear every log entry?' : `Clear logs older than ${scope} days?`;
}

export default function ClearLogs() {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<ClearScope>('30');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function clear() {
    setBusy(true);
    setError(null);
    try {
      await adminFetch(clearUrl(scope), { method: 'DELETE' });
      window.location.reload();
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" data-variant="danger" onClick={() => setOpen(true)}>
        Clear logs
      </button>
      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
          setError(null);
        }}
        title={clearTitle(scope)}
        sub="The clearing itself is recorded in the activity log. Entries older than 30 days are deleted every night anyway."
        dismissible={false}
        footer={
          <>
            <button type="button" data-autofocus="" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              data-variant="danger"
              aria-disabled={busy ? 'true' : undefined}
              onClick={() => {
                if (!busy) void clear();
              }}
            >
              {busy ? 'Clearing…' : 'Clear logs'}
            </button>
          </>
        }
      >
        <Segmented label="What to clear" options={OPTIONS} value={scope} onChange={setScope} />
        {error && (
          <p className="msg" data-kind="error" role="alert">
            {error}
          </p>
        )}
      </Modal>
    </>
  );
}
