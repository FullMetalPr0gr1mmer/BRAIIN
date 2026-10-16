import { useEffect, useId, useState } from 'react';
import {
  isCustomItem,
  type DashboardLayout,
  type QuickItem,
  type WidgetId,
} from '@schemas/dashboard';
import type { Role } from '@/lib/auth/types';
import Modal from '@/components/admin/kit/Modal';
import { adminFetch, describeError } from '@/lib/admin/client';
import { readBoard } from './customize';
import type { RoleEntry } from './types';

// "Save as the default for a role" (Admin v2 U1, README U1 D1 to D3; Admin only): this
// layout and these quick actions become what people in the chosen role see until they
// arrange their own. Only what that role may have is sent: widgets it cannot see and library
// actions it cannot use are left out (the server refuses them anyway), and the person's own
// links never are sent (a preset carries library actions only, D3). "Reset that role" removes
// the preset: the role goes back to the standard layout.

export interface RoleDefaultsModalProps {
  open: boolean;
  onClose: () => void;
  roles: readonly RoleEntry[];
  board: HTMLElement | null;
  hidden: readonly WidgetId[];
  quick: readonly QuickItem[];
}

interface Preset {
  role: Role;
  version: number;
}

/** The layout and quick actions as they would be for `role`: what it may have, nothing else. */
export function presetFor(
  entry: RoleEntry,
  lists: Pick<DashboardLayout, 'top' | 'left' | 'right'>,
  hidden: readonly WidgetId[],
  quick: readonly QuickItem[],
): { dashboard: DashboardLayout; quickActions: { id: string }[] } {
  const may = new Set(entry.widgets);
  const keep = (ids: readonly WidgetId[]) => ids.filter((id) => may.has(id));
  const library = new Set(entry.library);
  return {
    dashboard: {
      top: keep(lists.top),
      left: keep(lists.left),
      right: keep(lists.right),
      hidden: keep(hidden),
    },
    quickActions: quick
      .filter((item) => !isCustomItem(item) && library.has(item.id))
      .map((item) => ({ id: item.id })),
  };
}

export default function RoleDefaultsModal(props: RoleDefaultsModalProps) {
  const { open, onClose, roles } = props;
  const [role, setRole] = useState<Role>(roles[1]?.role ?? 'admin');
  const [presets, setPresets] = useState<Preset[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const roleId = useId();

  useEffect(() => {
    if (!open) return;
    setMessage(null);
    setPresets(null);
    adminFetch<{ presets: Preset[] }>('/api/admin/dashboard/defaults')
      .then((data) => setPresets(data.presets))
      .catch((err) => setMessage({ kind: 'error', text: describeError(err) }));
  }, [open]);

  const entry = roles.find((r) => r.role === role);
  const version = presets?.find((p) => p.role === role)?.version ?? null;

  async function save() {
    if (!entry || version === null || !props.board) return;
    setBusy(true);
    try {
      const body = presetFor(entry, readBoard(props.board), props.hidden, props.quick);
      const saved = await adminFetch<Preset>(`/api/admin/dashboard/defaults/${role}`, {
        method: 'PUT',
        body: { version, ...body },
      });
      setPresets((list) => (list ?? []).map((p) => (p.role === role ? saved : p)));
      setMessage({
        kind: 'ok',
        text: `Saved. People in the ${entry.label} role who have not arranged their own dashboard now see it.`,
      });
    } catch (err) {
      setMessage({ kind: 'error', text: describeError(err) });
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!entry) return;
    setBusy(true);
    try {
      await adminFetch(`/api/admin/dashboard/defaults/${role}`, { method: 'DELETE' });
      setPresets((list) => (list ?? []).map((p) => (p.role === role ? { role, version: 0 } : p)));
      setMessage({ kind: 'ok', text: `The ${entry.label} role is back to the standard layout.` });
    } catch (err) {
      setMessage({ kind: 'error', text: describeError(err) });
    } finally {
      setBusy(false);
    }
  }

  const ready = presets !== null && !busy;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Save as the default for a role"
      sub="Library actions only: your own links stay yours."
      footer={
        <>
          <button type="button" data-autofocus="" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            aria-disabled={ready && version !== 0 ? undefined : 'true'}
            onClick={() => {
              if (ready && version !== 0) void reset();
            }}
          >
            Reset that role to the standard layout
          </button>
          <button
            type="button"
            data-variant="primary"
            aria-disabled={ready ? undefined : 'true'}
            onClick={() => {
              if (ready) void save();
            }}
          >
            Save for {entry?.label ?? 'this role'}
          </button>
        </>
      }
    >
      {/* A label beside the select (for/id), not around it, so its name is "Role" alone. */}
      <div className="field dash__select">
        <label htmlFor={roleId}>Role</label>
        <select
          id={roleId}
          value={role}
          onChange={(event) => {
            setRole(event.target.value as Role);
            setMessage(null);
          }}
        >
          {roles.map((r) => (
            <option key={r.role} value={r.role}>
              {r.label}
            </option>
          ))}
        </select>
      </div>
      <p className="admin-sub">
        Save this layout and your quick actions (library items only) as the default for{' '}
        {entry?.label ?? 'the role'}. Widgets and actions the role cannot use are left out.
      </p>
      {presets !== null && (
        <p className="admin-sub">
          {version
            ? `${entry?.label} has a saved default.`
            : `${entry?.label} uses the standard layout.`}
        </p>
      )}
      {message && (
        <p
          className="msg"
          data-kind={message.kind === 'error' ? 'error' : 'ok'}
          role={message.kind === 'error' ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      )}
    </Modal>
  );
}
