import type { NotificationKind } from '@schemas/adminPrefs';

// What each kind of bell item is called where a person chooses what the bell tells them
// (Admin v2 U11, /admin/settings/notifications). One entry per kind in NOTIFICATION_KINDS
// (tests/lib/notificationSettings.spec.ts holds the two equal), so a slice that adds a kind
// (the releases' "changes waiting" and "published") adds its words here too. P-12: plain,
// warm, no dashes.

export interface NotificationKindLabel {
  label: string;
  hint: string;
}

export const NOTIFICATION_KIND_LABELS: Readonly<Record<NotificationKind, NotificationKindLabel>> = {
  leads: { label: 'New inquiries', hint: 'When a new lead arrives.' },
  applications: {
    label: 'New job applications',
    hint: 'When someone applies on the Join page.',
  },
  scheduled: { label: 'Going live today', hint: 'Content scheduled to go live today.' },
  maintenance: {
    label: 'Maintenance mode',
    hint: 'When the site goes into or out of maintenance.',
  },
  health: {
    label: 'Site health',
    hint: 'When the site is down, or its domain or certificate is about to expire.',
  },
};
