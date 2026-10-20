import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import type { DateRange } from './range';
import { count, list, readError, record } from './read';
import { ctaLabel, interestKey } from './labels';

// The Conversions tab's Events card (Admin v2 G1a): clicks on the public site's data-track
// links and interest shown in the /services explorer, read from rollup_daily_events through
// public.event_summary (migration 0071; an invoker, so analytics.read decides). The 20
// busiest keys of each kind, and each kind's total over every key. Interest is named with
// the discipline's or service's English name, looked up in the published taxonomy; a slug
// the site no longer has (renamed, unpublished) shows as itself.

const SOURCE = 'admin:stats';

export interface EventRow {
  key: string;
  /** What the row is called on the screen. */
  label: string;
  events: number;
  /** Distinct visits it came from. */
  visits: number;
}

export interface EventSummary {
  cta: EventRow[];
  interest: EventRow[];
  ctaTotal: number;
  interestTotal: number;
}

/** Rows of one kind, read leniently; the label filled in by `name`. */
function rowsOf(value: unknown, name: (key: string) => string): EventRow[] {
  return list(value).flatMap((row) =>
    typeof row['key'] === 'string'
      ? [
          {
            key: row['key'],
            label: name(row['key']),
            events: count(row['events']),
            visits: count(row['visits']),
          },
        ]
      : [],
  );
}

/** `{ "d:branding": "Branding", "s:logo": "Logo Design" }` for the slugs a summary names. */
async function interestNames(
  sb: SupabaseClient,
  auth: AuthContext,
  keys: readonly string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const parsed = keys.flatMap((key) => {
    const found = interestKey(key);
    return found ? [found] : [];
  });
  const disciplines = parsed.filter((k) => k.kind === 'discipline').map((k) => k.slug);
  const services = parsed.filter((k) => k.kind === 'service').map((k) => k.slug);
  const english = (value: unknown): string =>
    value && typeof value === 'object'
      ? String((value as Record<string, unknown>)['en'] ?? '').trim()
      : typeof value === 'string'
        ? value.trim()
        : '';
  // A name is a nicety: a refused read leaves the slugs as they are, never fails the tab.
  const [d, s] = await Promise.all([
    disciplines.length > 0
      ? sb
          .from('disciplines')
          .select('slug,name')
          .eq('tenant_id', auth.tenantId)
          .in('slug', disciplines)
      : null,
    services.length > 0
      ? sb.from('services').select('slug,title').eq('tenant_id', auth.tenantId).in('slug', services)
      : null,
  ]);
  for (const row of (d && !d.error ? (d.data ?? []) : []) as Record<string, unknown>[]) {
    const name = english(row['name']);
    if (typeof row['slug'] === 'string' && name) names.set(`d:${row['slug']}`, name);
  }
  for (const row of (s && !s.error ? (s.data ?? []) : []) as Record<string, unknown>[]) {
    const name = english(row['title']);
    if (typeof row['slug'] === 'string' && name) names.set(`s:${row['slug']}`, name);
  }
  return names;
}

/** What an interest key is called: the name, else its slug. */
function interestLabel(key: string, names: ReadonlyMap<string, string>): string {
  const known = names.get(key);
  if (known) return known;
  return interestKey(key)?.slug ?? key;
}

/** The range's events. */
export async function loadEventSummary(
  sb: SupabaseClient,
  auth: AuthContext,
  range: DateRange,
): Promise<EventSummary> {
  const { data, error } = await sb.rpc('event_summary', {
    p_tenant: auth.tenantId,
    p_from: range.from,
    p_to: range.to,
  });
  if (error) throw await readError(SOURCE, 'Events', error);
  const raw = record(data);
  const interestKeys = list(raw['interest']).flatMap((row) =>
    typeof row['key'] === 'string' ? [row['key']] : [],
  );
  const names = interestKeys.length > 0 ? await interestNames(sb, auth, interestKeys) : new Map();
  return {
    cta: rowsOf(raw['cta'], ctaLabel),
    interest: rowsOf(raw['interest'], (key) => interestLabel(key, names)),
    ctaTotal: count(raw['cta_total']),
    interestTotal: count(raw['interest_total']),
  };
}
