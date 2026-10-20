import {
  MAINTENANCE_DEFAULTS,
  MAINTENANCE_MAX_DAYS_AHEAD,
  maintenanceInForce,
  readMaintenance,
  toMaintenanceForm,
  type MaintenanceContact,
  type MaintenanceForm,
  type MaintenanceInput,
  type MaintenanceSnapshot,
} from '@schemas/maintenance';
import { addDays, todayIn, zonedDayStart } from '@/lib/time/zone';
import { ValidationError } from './errors';

// Maintenance v2's save, without I/O (Admin v2 U9b): what the stored value becomes when the
// admin saves the form or flips the switch. The route (src/pages/api/admin/settings/
// maintenance.ts) reads the row, the contact and the zone, calls this, writes the row, then
// KV. Pure, so the rules are unit-tested (tests/lib/maintenanceRoute.spec.ts).

export const UNTIL_PAST = 'Pick a day after today, or clear the date.';
export const UNTIL_TOO_FAR = `Pick a day within ${MAINTENANCE_MAX_DAYS_AHEAD} days, or clear the date.`;

/** True for a stored value maintenance v2 wrote (`v: 2`). */
export function isV2(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && (raw as Record<string, unknown>)['v'] === 2;
}

/**
 * What the admin edits from a stored value. A value v2 never wrote that is OFF starts with the
 * staff bypass ON (decision D14, the prototype's default): it is a new value as far as the
 * switch is concerned. One that is ON keeps the edge's reading, OFF (fail-closed, what the
 * pre-cache check does with it), so the form never claims a bypass the site does not give.
 */
export function storedForEditing(raw: unknown, now: number): MaintenanceSnapshot {
  const read = raw === null || raw === undefined ? MAINTENANCE_DEFAULTS : readMaintenance(raw);
  const base = !isV2(raw) && !read.active ? { ...read, staffBypass: true } : read;
  // A "Back on" day that has come ended maintenance at that instant: the switch is OFF as
  // visitors see it, and so for the form (a save of other fields must never turn it back on),
  // with no date, and changed when it ended (the reconcile writes the same to the row).
  if (base.untilAt && Date.parse(base.untilAt) <= now) {
    const ended = base.active ? { active: false, changedAt: base.untilAt } : {};
    return { ...base, ...ended, until: null, untilAt: null };
  }
  return base;
}

/** The form's flat shape for a stored value, with what is in force now. */
export function formOf(raw: unknown, now: number) {
  const stored = raw === null || raw === undefined ? MAINTENANCE_DEFAULTS : readMaintenance(raw);
  const form: MaintenanceForm = toMaintenanceForm(storedForEditing(raw, now));
  const active = maintenanceInForce(stored, now);
  return {
    ...form,
    effective: { active, endedByDate: stored.active && !active },
  };
}

export interface SavePlan {
  next: MaintenanceSnapshot;
  /** Whether the save turns maintenance on or off as visitors see it (the audit's action). */
  flipped: boolean;
  /** The form's fields the save changed (the audit's detail; names, never values). */
  fields: string[];
}

const FIELD_OF: Record<string, (s: MaintenanceSnapshot) => unknown> = {
  active: (s) => s.active,
  allowlist: (s) => s.allowlist.join(','),
  staffBypass: (s) => s.staffBypass,
  until: (s) => s.until,
  showDate: (s) => s.showDate,
  background: (s) => s.background,
  showContact: (s) => s.showContact,
  title: (s) => JSON.stringify(s.copy.title),
  message: (s) => JSON.stringify(s.copy.message),
};

/**
 * The stored value a save leaves. `until` becomes its instant: 00:00 of that day in the
 * studio's zone (`tz`), the instant the site comes back; a day that is not after today, or more
 * than 30 days ahead, is a 422 on `until` (decision D10). The contact snapshot is the identity
 * as it is now (the buttons the page shows). `changedAt` moves only when the switch flips as
 * visitors see it.
 */
export function planMaintenanceSave(
  raw: unknown,
  input: MaintenanceInput,
  ctx: { now: number; tz: string; contact: MaintenanceContact | null },
): SavePlan {
  const { now, tz } = ctx;
  const stored = storedForEditing(raw, now);
  let until = stored.until;
  let untilAt = stored.untilAt;
  if (input.until !== undefined) {
    if (input.until === null) {
      until = null;
      untilAt = null;
    } else {
      const today = todayIn(tz, now);
      if (input.until <= today) throw new ValidationError(UNTIL_PAST, 'until');
      if (input.until > addDays(today, MAINTENANCE_MAX_DAYS_AHEAD)) {
        throw new ValidationError(UNTIL_TOO_FAR, 'until');
      }
      until = input.until;
      untilAt = zonedDayStart(input.until, tz).toISOString();
    }
  }
  const draft: MaintenanceSnapshot = {
    v: 2,
    active: input.active ?? stored.active,
    allowlist: input.allowlist ?? stored.allowlist,
    staffBypass: input.staffBypass ?? stored.staffBypass,
    until,
    untilAt,
    showDate: input.showDate ?? stored.showDate,
    background: input.background ?? stored.background,
    showContact: input.showContact ?? stored.showContact,
    copy: {
      title: input.title !== undefined ? input.title : stored.copy.title,
      message: input.message !== undefined ? input.message : stored.copy.message,
    },
    contact: ctx.contact ?? stored.contact,
  };
  const before = maintenanceInForce(stored, now);
  const after = maintenanceInForce(draft, now);
  const flipped = before !== after;
  const changedAt = flipped ? new Date(now).toISOString() : stored.changedAt;
  const next: MaintenanceSnapshot = { ...draft, ...(changedAt ? { changedAt } : {}) };
  if (!changedAt) delete (next as { changedAt?: string }).changedAt;
  const fields = Object.entries(FIELD_OF)
    .filter(([, read]) => read(stored) !== read(next))
    .map(([name]) => name);
  return { next, flipped, fields };
}
