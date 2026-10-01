import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { localeFromPath, toLogicalPath } from '@/lib/i18n';
import { normalizeRedirectPath, targetPathOf } from '@/lib/http/redirects';

export { targetPathOf };

// The domain rules of a redirect rule, judged on the MERGED row (stored + patch) by
// `redirectResource.assertWritable`. Pure where they can be (chains), one indexed read
// where they cannot (a live slug). Architecture §7: "no chains > 1, no loops, can't
// redirect a live slug".

export interface RedirectRefusal {
  message: string;
  field: 'sourcePath' | 'targetPath';
}

/**
 * The site's non-dynamic public routes, as logical (locale-free) paths. A rule whose
 * source is one of these would never apply — the page renders, and the middleware
 * consults the table only after a 404 — so it is refused at save time instead of
 * sitting in the table looking like it works. A unit test walks src/pages and fails
 * when this list and the route files disagree.
 */
export const STATIC_PUBLIC_ROUTES: readonly string[] = [
  '/',
  '/404',
  '/about',
  '/contact',
  '/cookie-policy',
  '/creative-knowledge',
  '/creative-knowledge/rss.xml',
  '/healthz',
  '/join',
  '/llms.txt',
  '/portfolio',
  '/portfolio/all',
  '/privacy',
  '/robots.txt',
  '/search',
  '/services',
  '/sitemap.xml',
  '/terms',
];

/** The dynamic detail routes and the table each one renders from. */
const DETAIL_ROUTES: readonly { prefix: string; table: string }[] = [
  { prefix: '/services/', table: 'services' },
  { prefix: '/portfolio/', table: 'portfolio' },
  { prefix: '/creative-knowledge/', table: 'blog_posts' },
];

const LIVE_STATUSES = ['published', 'scheduled'];

const LIVE_MESSAGE = 'this path renders a page; a redirect from it would never apply';

/**
 * Refuses a source that a page answers: a static route, or a detail slug whose row is
 * live (published, or scheduled — the cron publishes it without asking again). A bare
 * `/<slug>` consults no table: no route renders `pages` by slug (its rows — `home`,
 * `join`, `portfolio-all` — are the section containers of the static routes), so only
 * STATIC_PUBLIC_ROUTES applies there. Checked on the logical path, so `/ar/x` is refused
 * exactly when `/x` is. The read runs under the caller's RLS.
 */
export async function liveRouteRefusal(
  sourcePath: string,
  sb: SupabaseClient,
  auth: AuthContext,
): Promise<RedirectRefusal | null> {
  const logical = normalizeRedirectPath(toLogicalPath(normalizeRedirectPath(sourcePath)));
  if (STATIC_PUBLIC_ROUTES.includes(logical)) {
    return { message: LIVE_MESSAGE, field: 'sourcePath' };
  }
  const target = slugTable(logical);
  if (!target) return null;

  const { data, error } = await sb
    .from(target.table)
    .select('id')
    .eq('tenant_id', auth.tenantId)
    .eq('slug', target.slug)
    .in('status', LIVE_STATUSES)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`check ${target.table}: ${error.message}`);
  return data ? { message: LIVE_MESSAGE, field: 'sourcePath' } : null;
}

/** Which table a detail-route logical path would render from, and the slug it names. */
function slugTable(logical: string): { table: string; slug: string } | null {
  for (const route of DETAIL_ROUTES) {
    if (logical.startsWith(route.prefix)) {
      const slug = logical.slice(route.prefix.length);
      return slug && !slug.includes('/') ? { table: route.table, slug } : null;
    }
  }
  return null;
}

export interface RedirectRow {
  id?: string | undefined;
  source_path: string;
  target_path: string;
}

/** The locale-free spelling of a normalised path (`/ar/x` and `/x` → `/x`). */
const logicalOf = (path: string): string => normalizeRedirectPath(toLogicalPath(path));

/**
 * Refuses a rule that would form a chain or a loop with the existing rows. Pure: the
 * resource passes the tenant's rows (one read, bounded like the edge snapshot) and this
 * decides. Every comparison also follows the `/ar` twin fallback (design-port R3-2): a
 * request to `/ar/old` with no row of its own answers the `/old` rule, so a target of
 * `/ar/old` hops again whenever `/old` is redirected, and a new rule for `/old` adds a
 * hop to every rule that already points at `/ar/old`.
 *
 *   self-loop  source → source, or source → its own language twin (`/x → /ar/x`: the
 *              fallback would re-localise that target onto the request itself)
 *   chain      source → X where X is itself redirected (point at X's destination)
 *   chain      Y → source already exists (Y would now hop twice)
 *   loop       both of the above between the same two rows
 *
 * A merged row's own stored version is excluded by id so an update does not "chain"
 * with itself. Absolute targets cannot chain within this site.
 */
export function chainRefusal(
  merged: RedirectRow,
  existing: readonly RedirectRow[],
): RedirectRefusal | null {
  const source = normalizeRedirectPath(merged.source_path);
  const target = targetPathOf(merged.target_path);
  if (target === source) {
    return { message: 'a redirect cannot point at itself', field: 'targetPath' };
  }
  if (target !== null && logicalOf(target) === logicalOf(source)) {
    return {
      message:
        'a redirect cannot point at its own /ar twin — the two URLs are one page in two languages',
      field: 'targetPath',
    };
  }
  const others = existing.filter((row) => !merged.id || row.id !== merged.id);
  const sourceOf = (row: RedirectRow) => normalizeRedirectPath(row.source_path);

  // The rule a request to `path` answers: its own, else — for an /ar URL — the English
  // rule for its logical path.
  const ruleFor = (path: string): RedirectRow | undefined =>
    others.find((row) => sourceOf(row) === path) ??
    (localeFromPath(path) === 'ar'
      ? others.find((row) => sourceOf(row) === logicalOf(path))
      : undefined);
  // Whether a target lands on this source: exactly, or on its /ar twin when the source is
  // English — the twin has no row of its own, so it answers this one.
  const landsHere = (path: string | null): boolean =>
    path !== null &&
    (path === source ||
      (localeFromPath(source) !== 'ar' &&
        localeFromPath(path) === 'ar' &&
        logicalOf(path) === source));

  const next = target === null ? undefined : ruleFor(target);
  const previous = others.find((row) => landsHere(targetPathOf(row.target_path)));

  if (next && landsHere(targetPathOf(next.target_path))) {
    return {
      message: `${next.source_path} already redirects here — the two rules would loop`,
      field: 'targetPath',
    };
  }
  if (next) {
    const viaTwin =
      sourceOf(next) === target ? '' : ` (${merged.target_path} follows that English rule)`;
    return {
      message: `${next.source_path} is itself redirected to ${next.target_path}${viaTwin} — point at that destination directly (no chains)`,
      field: 'targetPath',
    };
  }
  if (previous) {
    return {
      message: `${previous.source_path} already redirects to this source — a visitor would hop twice; change that rule's target instead (no chains)`,
      field: 'sourcePath',
    };
  }
  return null;
}
