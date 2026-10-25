import { NOTIFICATION_KINDS, type NotificationKind } from '@schemas/adminPrefs';
import type {
  NotificationSettings,
  NotificationSettingsPatch,
} from '@schemas/notificationSettings';
import type { Role } from '@/lib/auth/types';
import { ValidationError } from './errors';
import type { MyPrefs } from './prefs';
import { NOTIFICATION_SOURCES } from './notifications';
import { NOTIFICATION_KIND_LABELS } from './notifications/kinds';

// The bell's settings (Admin v2 U11): a switch per kind of item the role's bell shows, over
// F8's stored mutes (admin_user_prefs.notifications.muted). Pure: the route reads and saves,
// this maps. A preference can quiet the bell, never widen it: the kinds a role may switch are
// exactly those whose source is visible to it (ROLE_CAPS decides, through each source), and
// naming another is refused (422). A stored mute of a kind the role cannot see (one muted
// under an earlier role) is kept as it is: it changes nothing the role sees, and it is the
// person's own choice should the role come back.

/** The kinds this role's bell shows, in the bell's order. */
export function visibleKinds(role: Role): NotificationKind[] {
  return NOTIFICATION_KINDS.filter((kind) => NOTIFICATION_SOURCES[kind].visible(role));
}

/** One switch on the settings screen: the kind, its name and its line. */
export interface NotificationSwitch {
  kind: NotificationKind;
  label: string;
  hint: string;
}

/** The switches the settings screen draws for this role (the server hands them to the island). */
export function notificationSwitches(role: Role): NotificationSwitch[] {
  return visibleKinds(role).map((kind) => ({ kind, ...NOTIFICATION_KIND_LABELS[kind] }));
}

/** The stored preferences as the screen reads them: on (true) or off, per visible kind. */
export function settingsOf(prefs: MyPrefs, role: Role): NotificationSettings {
  const muted = new Set(prefs.notifications.muted);
  const out: NotificationSettings = { version: prefs.version };
  for (const kind of visibleKinds(role)) out[kind] = !muted.has(kind);
  return out;
}

/**
 * The muted kinds after a save: a kind sent `false` is muted, one sent `true` is not, one
 * left out keeps what it had, and so does every kind the role cannot see. Throws a 422 naming
 * any kind the role's bell does not show.
 */
export function mutedAfter(
  stored: readonly NotificationKind[],
  patch: NotificationSettingsPatch,
  role: Role,
): NotificationKind[] {
  const visible = new Set(visibleKinds(role));
  const refused = NOTIFICATION_KINDS.filter(
    (kind) => patch[kind] !== undefined && !visible.has(kind),
  );
  if (refused.length > 0) {
    throw new ValidationError(`Not part of your bell: ${refused.join(', ')}`, refused[0]);
  }
  const muted = new Set(stored);
  for (const kind of visible) {
    if (patch[kind] === true) muted.delete(kind);
    if (patch[kind] === false) muted.add(kind);
  }
  return NOTIFICATION_KINDS.filter((kind) => muted.has(kind));
}
