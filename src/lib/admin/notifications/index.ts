import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { NOTIFICATION_KINDS, type NotificationKind } from '@schemas/adminPrefs';
import type { MaintenanceState } from '@/lib/http/maintenance';
import { readMyPrefs, type MyPrefs } from '../prefs';
import { applications } from './applications';
import { leads } from './leads';
import { maintenance } from './maintenance';
import { scheduled } from './scheduled';
import { MAX_ITEMS, type NotificationItem, type NotificationSource } from './types';

export type { NotificationItem, NotificationSource } from './types';

// The bell (Admin v2 F8, docs/admin-v2/ui.md §2.8): a derived feed, one module per kind of
// item in this directory, registered below. The releases slices register theirs ("changes
// waiting", "published") as a module, a kind in packages/schemas/adminPrefs.ts and one
// line here, as the counters do.
//
// One loader serves the shell's unread count (every admin render) and the drawer's list,
// so the dot and the list can never disagree. It runs a source only for a role the source
// is visible to (ROLE_CAPS decides), drops the kinds the person muted, and marks as unread
// what arrived after the person's watermark. A source that fails is left out and named,
// never an error screen: the bell is decoration around the page.

export const NOTIFICATION_SOURCES: Readonly<Record<NotificationKind, NotificationSource>> = {
  leads,
  applications,
  scheduled,
  maintenance,
};

export interface NotificationFeed {
  items: NotificationItem[];
  unread: number;
  /** The person's watermark, or null when they never marked the bell read. */
  seenAt: string | null;
  /** The kinds that could not be read this time. */
  failed: NotificationKind[];
  /**
   * The moment this list was read (ISO): what "Mark all as read" sends back, so it marks
   * what the person was shown and nothing that arrived after. The loader's now, or the
   * newest item's `since` when a clock (the database's, which stamps most of them) ran ahead.
   */
  asOf: string;
}

export interface LoadOptions {
  maintenance: () => Promise<MaintenanceState | null>;
  /** Readable labels (the drawer); the shell's count skips them. */
  labels?: boolean;
  now?: Date;
}

async function settle<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null;
  }
}

export async function loadNotifications(
  sb: SupabaseClient,
  auth: AuthContext,
  options: LoadOptions,
): Promise<NotificationFeed> {
  const now = options.now ?? new Date();
  const ctx = {
    sb,
    auth,
    now,
    maintenance: options.maintenance,
    labels: options.labels ?? false,
  };
  const sources = NOTIFICATION_KINDS.map((kind) => NOTIFICATION_SOURCES[kind]).filter((source) =>
    source.visible(auth.role),
  );

  const [prefs, ...lists] = await Promise.all([
    settle<MyPrefs>(() => readMyPrefs(sb, auth)),
    ...sources.map((source) => settle(() => source.load(ctx))),
  ]);

  const muted = new Set<NotificationKind>(prefs?.notifications.muted ?? []);
  const seenAt = prefs?.notificationsSeenAt ?? null;
  const seen = seenAt ? Date.parse(seenAt) : Number.NEGATIVE_INFINITY;
  const failed: NotificationKind[] = [];

  const listed = sources
    .flatMap((source, index) => {
      const list = lists[index];
      if (!list) {
        failed.push(source.kind);
        return [];
      }
      return muted.has(source.kind) ? [] : list;
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id))
    .slice(0, MAX_ITEMS);

  const newest = Math.max(
    now.getTime(),
    ...listed.map((item) => Date.parse(item.since)).filter(Number.isFinite),
  );
  const items = listed.map(({ since, ...item }) => ({ ...item, unread: Date.parse(since) > seen }));

  return {
    items,
    unread: items.filter((item) => item.unread).length,
    seenAt,
    failed,
    asOf: new Date(newest).toISOString(),
  };
}
