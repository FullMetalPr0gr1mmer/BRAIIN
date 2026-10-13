import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext, Role } from '@/lib/auth/types';
import type { NotificationKind } from '@schemas/adminPrefs';
import type { MaintenanceState } from '@/lib/http/maintenance';
import type { IconName } from '../icons';

// The bell's shapes (Admin v2 F8, docs/admin-v2/ui.md §2.8). The feed is DERIVED: no event
// table, each source reads what the role may already read, through the caller's RLS-bound
// client, and names only what that role's own screens already show.

export interface NotificationItem {
  /** Stable across loads: `<kind>:<row id>`. */
  id: string;
  kind: NotificationKind;
  icon: IconName;
  text: string;
  /** A second line, or null. */
  detail: string | null;
  /** When it happened, or happens (ISO): what the drawer shows and sorts by. */
  at: string;
  /** Where the row leads, or null when this role has nowhere to go for it. */
  href: string | null;
  /** True when it arrived after the person last marked the bell read. */
  unread: boolean;
}

/** An item as a source makes it. `since` is when it counts as new (usually `at`). */
export interface SourceItem extends Omit<NotificationItem, 'unread'> {
  since: string;
}

export interface SourceContext {
  sb: SupabaseClient;
  auth: AuthContext;
  now: Date;
  /** The maintenance snapshot, read once per request by whoever asked for the feed. */
  maintenance: () => Promise<MaintenanceState | null>;
  /** Resolve readable labels (one more read): the drawer does, the bell's count does not. */
  labels: boolean;
}

/**
 * One kind of item: who may see it (from ROLE_CAPS, so CLAUDE.md §5 decides), and how to
 * read it. A source runs only for a role it is visible to, so a role never learns even
 * the count of items its screens would not show (CLAUDE.md §3: Content Creator and SEO
 * get no lead or application data); RLS then applies the same rule a second time.
 */
export interface NotificationSource {
  kind: NotificationKind;
  visible(role: Role): boolean;
  load(ctx: SourceContext): Promise<SourceItem[]>;
}

/** How far back a source looks, and how many items each may bring. */
export const WINDOW_DAYS = 14;
export const PER_SOURCE = 10;
/** The most items the bell lists. */
export const MAX_ITEMS = 30;

export function windowStart(now: Date): string {
  return new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}
