import { useState } from 'react';
import Icon from '@/components/admin/kit/Icon';
import { AdminApiError, adminFetch, describeError } from '@/lib/admin/client';

// Check now (Admin v2 G2): the site health screen's second island, for every role that sees
// the screen (siteHealth.view). It asks the server to read the uptime monitor and the
// domain's registration record at once (POST /api/admin/site-health/check: rate-limited,
// six an hour per person), then reloads, so the page shows the new readings and "Uptime
// checked just now". Without JS the button is absent and the 10-minute schedule still reads
// (decision D12). Errors show beside the button; nothing is a toast.

/** What a refusal says here (the shared wording knows nothing of uptime). */
export function checkError(err: unknown): string {
  if (err instanceof AdminApiError && err.info.error === 'single-site') {
    return 'Uptime is set up for one site only, so there is nothing to check here.';
  }
  if (err instanceof AdminApiError && err.info.error === 'rate-limit') {
    return 'Checked often enough for now: up to 6 checks an hour. The readings still arrive every 10 minutes.';
  }
  return describeError(err);
}

export default function CheckNow() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setBusy(true);
    setError(null);
    try {
      await adminFetch('/api/admin/site-health/check', { method: 'POST' });
      window.location.reload();
    } catch (err) {
      setError(checkError(err));
      setBusy(false);
    }
  }

  return (
    <span className="hcheck">
      <button
        type="button"
        aria-disabled={busy ? 'true' : undefined}
        onClick={() => {
          if (!busy) void check();
        }}
      >
        <Icon name={busy ? 'loader' : 'refresh'} size={14} />
        {busy ? 'Checking…' : 'Check now'}
      </button>
      {error && (
        <span className="msg hcheck__msg" data-kind="error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
