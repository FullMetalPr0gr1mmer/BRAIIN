import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '@/lib/auth/types';
import { toLogicalPath } from '@/lib/i18n';
import { normalizeRedirectPath } from '@/lib/http/redirects';

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
 * live (published, or scheduled — the cron publishes it without asking again). A
 * `/<slug>` source is checked against `pages`. Checked on the logical path, so `/ar/x`
 * is refused exactly when `/x` is. The read runs under the caller's RLS.
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

/** Which table a one-level-deep logical path would render from, and the slug it names. */
function slugTable(logical: string): { table: string; slug: string } | null {
  for (const route of DETAIL_ROUTES) {
    if (logical.startsWith(route.prefix)) {
      const slug = logical.slice(route.prefix.length);
      return slug && !slug.includes('/') ? { table: route.table, slug } : null;
    }
  }
  const slug = logical.slice(1);
  return slug && !slug.includes('/') ? { table: 'pages', slug } : null;
}

/** The path part of a site-relative target (`/new?x#y` → `/new`); null for an absolute one. */
export function targetPathOf(target: string): string | null {
  if (!target.startsWith('/') || target.startsWith('//')) return null;
  const cut = target.search(/[?#]/);
  return normalizeRedirectPath(cut === -1 ? target : target.slice(0, cut));
}

export interface RedirectRow {
  id?: string | undefined;
  source_path: string;
  target_path: string;
}

/**
 * Refuses a rule that would form a chain or a loop with the existing rows. Pure: the
 * resource passes the rows that could interact (those whose source is this target, or
 * whose target is this source — two indexed reads, never a PostgREST `.or()` string).
 *
 *   self-loop  source → source
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
  const others = existing.filter((row) => !merged.id || row.id !== merged.id);
  const next = target
    ? others.find((row) => normalizeRedirectPath(row.source_path) === target)
    : undefined;
  const previous = others.find((row) => targetPathOf(row.target_path) === source);

  if (next && targetPathOf(next.target_path) === source) {
    return {
      message: `${next.source_path} already redirects here — the two rules would loop`,
      field: 'targetPath',
    };
  }
  if (next) {
    return {
      message: `${next.source_path} is itself redirected to ${next.target_path} — point at that destination directly (no chains)`,
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
