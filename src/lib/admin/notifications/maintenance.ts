import { can } from '@/lib/authz/matrix';
import { WINDOW_DAYS, type NotificationSource } from './types';

// "Maintenance mode was turned on / off", for everyone: whether visitors can reach the
// site is something every person editing it should know. From the maintenance snapshot
// the shell already reads (KV, `changedAt`, stamped by the maintenance switch since F8),
// so it costs no extra read. A switch older than the window, or one recorded before F8,
// has no item; the topbar's "Maintenance on" badge still says so while it is on.

const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

export const maintenance: NotificationSource = {
  kind: 'maintenance',
  visible: () => true,
  async load({ auth, now, maintenance: read }) {
    const state = await read();
    const at = state?.changedAt;
    if (!state || !at) return [];
    const age = now.getTime() - Date.parse(at);
    if (!(age >= 0 && age <= WINDOW_MS)) return [];
    return [
      {
        id: `maintenance:${at}`,
        kind: 'maintenance' as const,
        icon: 'warn' as const,
        text: state.active ? 'Maintenance mode was turned on' : 'Maintenance mode was turned off',
        detail: state.active
          ? 'Visitors see the maintenance page.'
          : 'Visitors can reach the site again.',
        at,
        since: at,
        href: can(auth.role, 'maintenance.manage') === 'full' ? '/admin/maintenance' : null,
      },
    ];
  },
};
