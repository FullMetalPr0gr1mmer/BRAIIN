import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { adminFetch, describeError } from '@/lib/admin/client';

// Maintenance mode — `maintenance.manage` (Admin + Developer).
//
// Two things this screen must be honest about, because both are ways to lock yourself
// out of your own site:
//
//   1. `kvSynced: false` means the flag was stored but the EDGE did not get it. The
//      middleware reads KV before the cache lookup, so an unsynced flag is a
//      maintenance window that never started. Reported, never swallowed.
//   2. The allowlist is how you keep working during the window. Turning maintenance on
//      with an empty allowlist locks out everyone including you — /admin stays
//      reachable (it is exempt), but the site you are trying to fix does not.

interface MaintenanceState {
  maintenance?: { active: boolean; allowlist: string[] };
  active?: boolean;
  allowlist?: string[];
  version: number;
  kvSynced?: boolean;
}

export default function MaintenancePanel() {
  const [active, setActive] = useState(false);
  const [allowlist, setAllowlist] = useState('');
  const [version, setVersion] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(true);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const data = await adminFetch<MaintenanceState>('/api/admin/settings/maintenance');
      const state = data.maintenance ?? {
        active: data.active ?? false,
        allowlist: data.allowlist ?? [],
      };
      setActive(state.active);
      setAllowlist(state.allowlist.join('\n'));
      setVersion(Number(data.version ?? 0));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setError('');
    setNotice('');
    const list = allowlist
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean);

    if (active && list.length === 0) {
      const proceed = window.confirm(
        'The allowlist is empty. Every visitor — including you — will see the maintenance page. Continue?',
      );
      if (!proceed) return;
    }

    try {
      const result = await adminFetch<{ active: boolean; kvSynced: boolean }>(
        '/api/admin/settings/maintenance',
        { method: 'PATCH', body: { active, allowlist: list, version } },
      );
      await load();
      setNotice(
        result.kvSynced
          ? `Maintenance mode is ${result.active ? 'ON' : 'OFF'} and live at the edge.`
          : 'Saved to the database, but the edge did not pick it up. The site is still serving normally — retry before relying on this.',
      );
    } catch (err) {
      setError(describeError(err));
    }
  }

  if (busy) return <p>Loading…</p>;

  return (
    <form onSubmit={(event) => void save(event)}>
      {error && (
        <p className="msg" data-kind="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="msg" data-kind="ok" role="status">
          {notice}
        </p>
      )}

      <div className="card">
        <label className="field field-inline">
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
          />
          <span>Maintenance mode is on</span>
        </label>

        <label className="field">
          <span>IP allowlist (one per line)</span>
          <textarea
            value={allowlist}
            onChange={(event) => setAllowlist(event.target.value)}
            spellCheck={false}
          />
          <span>
            IPv4 or IPv6 literals. These addresses continue to see the live site while maintenance
            is on. /admin is always reachable.
          </span>
        </label>
      </div>

      <div className="toolbar form-actions">
        <button type="submit" data-variant="primary">
          Save maintenance settings
        </button>
        <span className="admin-sub">{version === 0 ? 'Not saved yet' : `Version ${version}`}</span>
      </div>
    </form>
  );
}
