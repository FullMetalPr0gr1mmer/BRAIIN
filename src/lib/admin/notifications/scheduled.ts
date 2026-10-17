import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { can } from '@/lib/authz/matrix';
import { PER_SOURCE, type NotificationSource, type SourceItem } from './types';

// "<title> goes live today": the services and posts scheduled for today, for the roles that
// write that content. "Today" is the Riyadh day, because that is the day the copy names
// ("At 15:00, Riyadh time") and the day the people reading it live in; the database's
// current_date is UTC's, which put tomorrow's 00:00 to 03:00 items under "today" every
// evening. So the two tables are read directly, through the caller's RLS-bound client,
// between the Riyadh day's two midnights.
//
// An item counts as new from the later of that day's start and its own last change: the
// first look of the day shows it, "Mark all as read" clears it, and one scheduled (or moved
// to today) after the person last marked the bell read lights the bell again.

const TIME_ZONE = 'Asia/Riyadh';
const DAY_MS = 24 * 60 * 60 * 1000;

interface ScheduledRow {
  id: string;
  title: unknown;
  scheduled_for: string | null;
  updated_at: string | null;
}

const SCHEDULED = [
  { table: 'services', entity: 'service', editor: '/admin/services' },
  { table: 'blog_posts', entity: 'blog_post', editor: '/admin/blog' },
] as const;

/** The English title of a bilingual title, or a plain string. */
function titleOf(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (value && typeof value === 'object') {
    const en = (value as { en?: unknown }).en;
    if (typeof en === 'string' && en.trim()) return en.trim();
  }
  return null;
}

const RIYADH_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
});

const RIYADH_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** The Riyadh calendar day that holds `now`, as the UTC instants [start, end). */
export function riyadhDay(now: Date): { start: string; end: string } {
  const parts = RIYADH_PARTS.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const [year, month, day] = [part('year'), part('month'), part('day')];
  // The zone's offset at `now`: its wall clock read as if it were UTC, less the instant
  // (to the second, as the wall clock is).
  const wall = Date.UTC(year, month - 1, day, part('hour'), part('minute'), part('second'));
  const offset = wall - Math.floor(now.getTime() / 1000) * 1000;
  const start = Date.UTC(year, month - 1, day) - offset;
  return { start: new Date(start).toISOString(), end: new Date(start + DAY_MS).toISOString() };
}

const timeOf = (value: string | null): number => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

export interface GoingLive {
  entity: 'service' | 'blog_post';
  id: string;
  title: string | null;
  /** The editor that opens it. */
  href: string;
  /** When it goes live (ISO). */
  at: string;
  /** Its last change (ISO), or null. */
  updatedAt: string | null;
}

// One read per request, whoever asks first: the bell (in the shell, on every admin render)
// and the dashboard's "Going live today" (U1) want the same two reads, so the answer is kept
// per request client (one per request, src/middleware.ts) and Riyadh day.
const MEMO = new WeakMap<object, Map<string, Promise<GoingLive[]>>>();

/**
 * The services and posts scheduled for the Riyadh day that holds `now`, soonest first: at
 * most PER_SOURCE of each, through the caller's RLS-bound client. Throws when a read fails.
 */
export function goingLiveToday(
  sb: SupabaseClient,
  auth: Pick<AuthContext, 'tenantId'>,
  now: Date,
): Promise<GoingLive[]> {
  const { start, end } = riyadhDay(now);
  const key = `${auth.tenantId}:${start}`;
  const perClient = MEMO.get(sb) ?? new Map<string, Promise<GoingLive[]>>();
  MEMO.set(sb, perClient);
  const known = perClient.get(key);
  if (known) return known;
  const read = (async () => {
    const reads = await Promise.all(
      SCHEDULED.map(({ table }) =>
        sb
          .from(table)
          .select('id,title,scheduled_for,updated_at')
          .eq('tenant_id', auth.tenantId)
          .eq('status', 'scheduled')
          .gte('scheduled_for', start)
          .lt('scheduled_for', end)
          .order('scheduled_for', { ascending: true })
          .limit(PER_SOURCE),
      ),
    );
    const out: GoingLive[] = [];
    SCHEDULED.forEach(({ table, entity, editor }, index) => {
      const { data, error } = reads[index]!;
      if (error) throw new Error(`going live today (${table}): ${error.message}`);
      for (const row of (data ?? []) as ScheduledRow[]) {
        const at = timeOf(row.scheduled_for);
        if (!Number.isFinite(at)) continue;
        const changed = timeOf(row.updated_at);
        out.push({
          entity,
          id: row.id,
          title: titleOf(row.title),
          href: `${editor}/${row.id}`,
          at: new Date(at).toISOString(),
          updatedAt: Number.isFinite(changed) ? new Date(changed).toISOString() : null,
        });
      }
    });
    return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  })();
  perClient.set(key, read);
  // A failed read is not kept: the next caller asks again.
  read.catch(() => perClient.delete(key));
  return read;
}

export const scheduled: NotificationSource = {
  kind: 'scheduled',
  visible: (role) => can(role, 'services.write') === 'full' || can(role, 'blog.write') === 'full',
  async load({ sb, auth, now }) {
    const dayStart = Date.parse(riyadhDay(now).start);
    const items: SourceItem[] = (await goingLiveToday(sb, auth, now)).map((row) => {
      const at = Date.parse(row.at);
      const changed = row.updatedAt ? Date.parse(row.updatedAt) : Number.NaN;
      return {
        id: `scheduled:${row.entity}:${row.id}`,
        kind: 'scheduled',
        icon: 'cal',
        text: `${row.title ?? 'An item'} goes live today`,
        detail: `At ${RIYADH_TIME.format(at)}, Riyadh time`,
        at: row.at,
        since: new Date(
          Number.isFinite(changed) ? Math.max(dayStart, changed) : dayStart,
        ).toISOString(),
        href: row.href,
      };
    });
    return items.slice(0, PER_SOURCE);
  },
};
