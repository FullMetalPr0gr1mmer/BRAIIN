import type { SupabaseClient } from '@supabase/supabase-js';
// Worker bindings come from the runtime module (Astro 6+ removed `locals.runtime.env`),
// exactly as src/lib/admin/redirectSync.ts reaches KV.
import { env } from 'cloudflare:workers';
import type { AuthContext } from '@/lib/auth/types';
import {
  VISIBILITY_KV_KEY,
  parseVisibilitySnapshot,
  putVisibilitySnapshot,
  visibilityRevision,
  type VisibilityEntry,
  type VisibilityNote,
  type VisibilitySnapshot,
} from '@/lib/http/visibility';
import {
  HOME_SLUG,
  isVisibilityPageSlug,
  isVisibilityTemplate,
  type VisibilityPageSlug,
  type VisibilityTemplate,
} from '@/lib/visibility/routes';
import { writeSystemLog } from '@/lib/data/systemLog';

// Snapshot on write (Admin v2 U14a, the redirects pattern of design-port R3-1): every save
// rebuilds the tenant's WHOLE visibility snapshot from `page_visibility` and writes it to KV
// `site:visibility`, which the middleware reads. Rebuilding rather than patching one entry
// keeps the snapshot a pure function of the table, so "Sync to edge" and the daily cron are
// the same function run again.

/** The columns a snapshot is built from, the page and the redirect target named by slug. */
export const VISIBILITY_SNAPSHOT_SELECT =
  'id,version,mode,template,page_id,note,password_version,hide_from,show_on,page:pages!page_visibility_page_fk(slug),redirect:pages!page_visibility_redirect_fk(slug)';

/**
 * The most rows one snapshot read takes. Only the rows that are not public are read (a public
 * row and no row mean the same), one per page or template at most, so a tenant reaches this
 * only with 200 restricted pages. A read that reaches it is refused rather than snapshotted:
 * an arbitrary cut could leave out a hidden page, which would then fail open.
 */
export const VISIBILITY_ROW_LIMIT = 200;

/** A `page_visibility` row as the snapshot query returns it. */
export interface VisibilitySourceRow {
  id?: unknown;
  version?: unknown;
  mode: unknown;
  template: unknown;
  /** The page the row is about: what names the unlock cookie of a password page. */
  page_id?: unknown;
  /** A password page's message, and the version every password change moves. */
  note?: unknown;
  password_version?: unknown;
  hide_from: unknown;
  show_on: unknown;
  page: { slug?: unknown } | null | unknown;
  redirect: { slug?: unknown } | null | unknown;
}

const slugOf = (value: unknown): string | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const slug = (value as { slug?: unknown }).slug;
  return typeof slug === 'string' ? slug.toLowerCase() : null;
};

/** The password gate's message as stored: {en, ar}, either side absent, plain text only. */
const noteOf = (value: unknown): VisibilityNote | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const out: VisibilityNote = {};
  for (const lang of ['en', 'ar'] as const) {
    const line = raw[lang];
    if (typeof line === 'string' && line.trim().length > 0) out[lang] = line.trim();
  }
  return out.en === undefined && out.ar === undefined ? null : out;
};

const instantOf = (value: unknown): string | undefined =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : undefined;

/**
 * Table rows → the snapshot the edge reads. Only what is not public is kept (no row and a
 * public row mean the same), a page the route map does not know is dropped (it has no route
 * to gate), the homepage is never restricted, and a redirect names its target by slug (or
 * null, a 404, when the target is not a page the map knows). Pure, so the save, "Sync to
 * edge", the daily cron and the tests share it.
 */
export function buildVisibilitySnapshot(
  rows: readonly VisibilitySourceRow[],
  tenantId: string,
  builtAt: Date = new Date(),
): VisibilitySnapshot {
  const pages: VisibilitySnapshot['pages'] = {};
  const templates: VisibilitySnapshot['templates'] = {};
  // The rows that made an entry, for the revision the admin compares with its list.
  const used: { id: string; version: number }[] = [];
  const use = (row: VisibilitySourceRow) => {
    if (typeof row.id === 'string' && typeof row.version === 'number') {
      used.push({ id: row.id, version: row.version });
    }
  };
  for (const row of rows) {
    if (row.mode !== 'hidden' && row.mode !== 'link' && row.mode !== 'password') continue;
    const entry: VisibilityEntry = { mode: row.mode };
    if (row.mode === 'password') {
      // The page's id and the current password version: what the unlock cookie is signed
      // over. NEVER the password or its hash — the snapshot is who may see what, not the
      // secret, and page_passwords is unreadable by every API role (0061).
      const pageId = typeof row.page_id === 'string' ? row.page_id : null;
      const pv = typeof row.password_version === 'number' ? row.password_version : 0;
      if (pageId === null || !Number.isSafeInteger(pv) || pv < 1) continue;
      entry.id = pageId;
      entry.pv = pv;
      const note = noteOf(row.note);
      if (note) entry.note = note;
    }
    if (row.mode === 'hidden') {
      const to = slugOf(row.redirect);
      entry.target = isVisibilityPageSlug(to) ? to : null;
      const from = instantOf(row.hide_from);
      const until = instantOf(row.show_on);
      if (from) entry.from = from;
      if (until) entry.until = until;
    }
    if (isVisibilityTemplate(row.template)) {
      if (entry.mode === 'hidden') {
        templates[row.template] = entry;
        use(row);
      }
      continue;
    }
    const slug = slugOf(row.page);
    if (!isVisibilityPageSlug(slug) || slug === HOME_SLUG) continue;
    pages[slug] = entry;
    use(row);
  }
  return {
    v: 1,
    builtAt: builtAt.toISOString(),
    tenant: tenantId,
    rev: visibilityRevision(used),
    pages,
    templates,
  };
}

/** How many pages and templates a snapshot restricts. */
export function restrictedCount(snapshot: VisibilitySnapshot): number {
  return Object.keys(snapshot.pages).length + Object.keys(snapshot.templates).length;
}

export interface VisibilitySyncResult {
  /** Whether KV took the snapshot. False means: saved to the database, edge unchanged. */
  kvSynced: boolean;
  /** Pages and templates the snapshot restricts (hidden or link only). */
  count: number;
}

/**
 * Reads one tenant's rows that are not public, in a fixed order (the caller's client: RLS for
 * staff, the cron's service role). Throws when the read reaches VISIBILITY_ROW_LIMIT, so the
 * edge keeps the snapshot it has instead of one that may be missing a hidden page.
 */
export async function readVisibilityRows(
  sb: SupabaseClient,
  tenantId: string,
): Promise<VisibilitySourceRow[]> {
  const { data, error } = await sb
    .from('page_visibility')
    .select(VISIBILITY_SNAPSHOT_SELECT)
    .eq('tenant_id', tenantId)
    .neq('mode', 'public')
    .order('id', { ascending: true })
    .limit(VISIBILITY_ROW_LIMIT);
  if (error) throw new Error(`read page_visibility: ${error.message}`);
  const rows = (data ?? []) as VisibilitySourceRow[];
  if (rows.length >= VISIBILITY_ROW_LIMIT) {
    throw new Error(
      `read page_visibility: ${VISIBILITY_ROW_LIMIT} or more restricted rows, snapshot not rebuilt`,
    );
  }
  return rows;
}

/**
 * Reads the tenant's rows, builds the snapshot and writes it, then reads the rows once more
 * and writes again if they moved. KV has no compare-and-swap, so two saves at once each do a
 * blind put of what they read, and the one that read first can land last: without the second
 * read the edge would keep the older settings (a page just hidden still public) until the
 * next save or the daily cron. The second read follows this writer's own put, so it sees
 * every save whose put this one could have overwritten. The window left is a third save
 * landing between that read and the second put; its own second read covers most of it and
 * the daily cron the rest. One read and at most one put more, only when the rows moved.
 */
export async function rebuildVisibilitySnapshot(
  sb: SupabaseClient,
  tenantId: string,
): Promise<{ snapshot: VisibilitySnapshot; kvSynced: boolean }> {
  let snapshot = buildVisibilitySnapshot(await readVisibilityRows(sb, tenantId), tenantId);
  let kvSynced = await putVisibilitySnapshot(env, snapshot);
  if (!kvSynced) return { snapshot, kvSynced };
  const again = buildVisibilitySnapshot(await readVisibilityRows(sb, tenantId), tenantId);
  if (again.rev !== snapshot.rev) {
    snapshot = again;
    kvSynced = await putVisibilitySnapshot(env, snapshot);
  }
  return { snapshot, kvSynced };
}

/**
 * Rebuilds the tenant's snapshot under the caller's RLS-bound client (never the service role:
 * a caller who may not read the table may not snapshot it either). NEVER throws: it runs
 * after a committed write, where a throw would report a failed save of a row that is already
 * saved.
 */
export async function syncVisibilityToEdge(
  sb: SupabaseClient,
  auth: AuthContext,
): Promise<VisibilitySyncResult> {
  try {
    const { snapshot, kvSynced } = await rebuildVisibilitySnapshot(sb, auth.tenantId);
    return { kvSynced, count: restrictedCount(snapshot) };
  } catch (err) {
    void writeSystemLog({
      level: 'error',
      source: 'admin:page_visibility.sync',
      message: err instanceof Error ? err.message : 'page visibility sync failed',
      detail: { tenantId: auth.tenantId },
    });
    return { kvSynced: false, count: 0 };
  }
}

export interface EdgeVisibilityStatus {
  /** Whether the live site holds a snapshot at all. */
  present: boolean;
  /** When the snapshot it holds was built (ISO), or null. */
  builtAt: string | null;
  /** Pages and templates it restricts. */
  count: number;
  /** The rows it was built from (`visibilityRevision`), or null when it carries none. */
  rev: string | null;
}

/**
 * What the edge holds, for the line beside "Sync to edge": read WITHOUT the memo, so the
 * operator sees what was just written, not a minute-old copy. `null` when KV is unbound or
 * unreadable.
 */
export async function edgeVisibilityStatus(): Promise<EdgeVisibilityStatus | null> {
  try {
    if (!env.SESSION) return null;
    const raw = await env.SESSION.get(VISIBILITY_KV_KEY);
    if (raw === null || raw === undefined) {
      return { present: false, builtAt: null, count: 0, rev: null };
    }
    const snapshot = parseVisibilitySnapshot(raw);
    return {
      present: true,
      builtAt: snapshot.builtAt,
      count: restrictedCount(snapshot),
      rev: snapshot.rev ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * The cache tags a change to one page's or template's visibility touches: what a purge must
 * clear once a cache sits in front of the Worker (L9; R7 wires these to the purge seam). A
 * page leaving public must leave every cached copy of itself, of the menus that link it, and
 * of the sitemap and llms.txt.
 */
export function visibilityPurgeTags(
  target:
    { kind: 'page'; slug: VisibilityPageSlug } | { kind: 'template'; template: VisibilityTemplate },
): string[] {
  const own =
    target.kind === 'page'
      ? `page:${target.slug}`
      : target.template === 'service'
        ? 'services:all'
        : 'portfolio:all';
  return [own, 'nav:all', 'route:sitemap', 'route:llms'];
}
