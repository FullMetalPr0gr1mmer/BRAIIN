import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { getMaintenanceState } from '@/lib/http/maintenance';
import type { NavCount, NavGroup } from './nav';

// What the admin shell shows besides the menu (Admin v2 F2): the head counts beside
// sidebar links, the "Maintenance on" badge, and the signed-in person's name.
//
// Read on every admin render (Tier C, no-store), so every read is cheap and parallel:
// HEAD counts only (no rows leave the database), one KV read, one profile row. A count is
// computed only for a link the role can see — a Content Creator must not learn the lead
// volume from a badge when the whole leads area is closed to them — and every read goes
// through the RLS-bound client, so the database applies the same rule a second time.
// A failed read leaves its item out: the shell is decoration around the page, and a
// count or a badge is never worth an error screen.

export interface ShellState {
  displayName: string | null;
  maintenance: boolean;
  counts: Partial<Record<NavCount, number>>;
}

type Counter = (sb: SupabaseClient, tenantId: string) => PromiseLike<{ count: number | null }>;

const COUNTERS: Record<NavCount, Counter> = {
  // The same queries as the dashboard's cards, so a badge and a card never disagree.
  leads: (sb, tenantId) =>
    sb
      .from('leads')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('status', 'new'),
  applications: (sb, tenantId) =>
    sb
      .from('job_applications')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('status', 'new'),
};

async function settle<T>(work: () => PromiseLike<T>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null;
  }
}

export async function loadShellState(
  sb: SupabaseClient,
  auth: AuthContext,
  nav: readonly NavGroup[],
  env: { SESSION?: KVNamespace },
): Promise<ShellState> {
  const wanted = [
    ...new Set(
      nav.flatMap((group) => group.links.flatMap((link) => (link.count ? [link.count] : []))),
    ),
  ];

  const [profile, maintenance, ...counts] = await Promise.all([
    settle(() =>
      sb
        .from('profiles')
        .select('display_name')
        .eq('id', auth.userId)
        .maybeSingle<{ display_name: string | null }>(),
    ),
    settle(() => getMaintenanceState(env)),
    ...wanted.map((key) => settle(() => COUNTERS[key](sb, auth.tenantId))),
  ]);

  const state: ShellState = {
    displayName: profile?.data?.display_name?.trim() || null,
    maintenance: maintenance?.active === true,
    counts: {},
  };
  wanted.forEach((key, index) => {
    const count = counts[index]?.count;
    if (typeof count === 'number') state.counts[key] = count;
  });
  return state;
}

/** Two letters for the avatar: from the name when there is one, else the e-mail. */
export function initialsOf(displayName: string | null, email: string): string {
  const words = (displayName ?? '').split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return email.slice(0, 2).toUpperCase();
}
