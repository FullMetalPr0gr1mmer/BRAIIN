// The edge half of page visibility (Admin v2 U14a; CLAUDE.md §3, Pillar 1).
//
// Who can see each page is authored in `page_visibility` (Admin + Developer). Every save
// rebuilds the tenant's whole snapshot and writes it to KV `site:visibility` (the redirects
// pattern, src/lib/admin/visibilitySync.ts); the middleware reads it before it renders, so a
// hidden page answers before any database read and before any cache the Worker could ever
// consult. Its own key, never folded into `site:maintenance`: two writers (the maintenance
// switch, the visibility save) would race a read-modify-write on one value with no
// compare-and-swap, while two keys each rebuilt whole from their own table cannot lose each
// other's update.
//
// Read through an ISOLATE MEMO: maintenance already costs one KV read on every public request
// (its kill switch must be immediate), and a second one per request would double the reads
// against the Free plan's daily quota as traffic grows. A minute's memo makes it about one
// read per isolate per minute; the isolate that writes refreshes its own memo at once.
//
// How soon a change is live everywhere else, at worst: the memo (60 s), over KV's own edge
// cache (`cacheTtl`, 60 s, KV's minimum), over KV's propagation between locations (up to
// about 60 s): about three minutes. The admin says "within a few minutes" (visibilityCopy.ts,
// the page-visibility guide, launch runbook §6j); tests/lib/visibilityScreen.spec.ts holds the
// copy to these constants.
//
// Dependency-free on purpose, like redirects.ts: src/middleware.ts imports it, and the route
// map it uses is pure.

import {
  HOME_SLUG,
  PAGE_PATHS,
  isVisibilityPageSlug,
  isVisibilityTemplate,
  type VisibilityPageSlug,
  type VisibilityTarget,
  type VisibilityTemplate,
} from '@/lib/visibility/routes';

export const VISIBILITY_KV_KEY = 'site:visibility';

/** How long an isolate serves the snapshot it last read (ms): one third of the bound above. */
export const VISIBILITY_MEMO_MS = 60_000;

/** The same minute, as KV's own edge cache takes it (seconds). */
export const VISIBILITY_KV_CACHE_TTL_S = 60;

export const VISIBILITY_MODES = ['public', 'hidden', 'link', 'password'] as const;
export type VisibilityMode = (typeof VISIBILITY_MODES)[number];

/** The line above the password box, in either language or both (never a secret). */
export interface VisibilityNote {
  en?: string;
  ar?: string;
}

/** One page's or template's setting, as the edge needs it. */
export interface VisibilityEntry {
  mode: VisibilityMode;
  /** A hidden page's redirect: another page's slug, or null for a 404. */
  target?: VisibilityPageSlug | null;
  /** The hidden window, [from, until): ISO instants, either end open. */
  from?: string;
  until?: string;
  /**
   * A password page only: the page's id, its password version, and the message to show.
   * NEVER the password and never its hash — the snapshot is a cache of who may see what,
   * not of the secret. The id names the cookie and is signed into it; the version is what
   * ends every cookie when the password changes (src/lib/visibility/access.ts).
   */
  id?: string;
  pv?: number;
  note?: VisibilityNote;
}

export interface VisibilitySnapshot {
  v: 1;
  /** When the snapshot was built (ISO): the admin's "the live site has the settings" line. */
  builtAt: string | null;
  /**
   * The tenant whose rows it was built from. Written by the save (the staff token's tenant,
   * under RLS) and by the daily cron (`resolveLaunchTenantId`), so it is the server-resolved
   * tenant, cached: the password paths name it rather than asking the database again, and a
   * snapshot that carries a password entry always carries it (the same put writes both).
   */
  tenant?: string;
  /**
   * Which rows it was built from, as `visibilityRevision` writes it: the admin compares it
   * with the rows it lists to say whether the live site has these settings. Absent on a
   * snapshot that does not carry one (it then never agrees). Never read by the gate.
   */
  rev?: string;
  pages: Partial<Record<VisibilityPageSlug, VisibilityEntry>>;
  templates: Partial<Record<VisibilityTemplate, VisibilityEntry>>;
}

/** No row anywhere: every page public. */
export const EMPTY_VISIBILITY: VisibilitySnapshot = Object.freeze({
  v: 1,
  builtAt: null,
  pages: Object.freeze({}),
  templates: Object.freeze({}),
}) as VisibilitySnapshot;

/** The longest revision a snapshot may carry (a row is a uuid, a colon and a version). */
const MAX_REV_LENGTH = 16_384;

/**
 * The revision of a set of rows: each row's `id:version`, sorted, joined with commas. Every
 * write to a row moves its version (the database's trigger), so two sets of rows read alike
 * exactly when they hold the same settings. Pure, so the snapshot's builder and the admin
 * screen compute it the same way.
 */
export function visibilityRevision(rows: readonly { id: string; version: number }[]): string {
  return rows
    .map((row) => `${row.id}:${row.version}`)
    .sort()
    .join(',');
}

/** Whether a snapshot hides or unlists anything at all (the readers' fast path). */
export function hasRestrictions(snapshot: VisibilitySnapshot | null | undefined): boolean {
  if (!snapshot) return false;
  return Object.keys(snapshot.pages).length > 0 || Object.keys(snapshot.templates).length > 0;
}

/** The id of a page or a tenant, as the snapshot writes it: a uuid, nothing else. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

/**
 * Markup and control characters, which no note may hold. Built from a string so the
 * source itself carries no control character (0061 refuses the same set in SQL).
 */
const NOTE_FORBIDDEN = new RegExp('[<>\u0000-\u001f\u007f-\u009f]');

/** One line of a note, as the gate will render it: short, plain, no markup. */
function parseNoteLine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const line = value.trim();
  if (line.length === 0 || line.length > 140) return undefined;
  return NOTE_FORBIDDEN.test(line) ? undefined : line;
}

function parseNote(raw: unknown): VisibilityNote | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const en = parseNoteLine(value['en']);
  const ar = parseNoteLine(value['ar']);
  if (en === undefined && ar === undefined) return undefined;
  return { ...(en === undefined ? {} : { en }), ...(ar === undefined ? {} : { ar }) };
}

/** One entry as stored, or null when it is not one (a bad value is no restriction). */
function parseEntry(raw: unknown, template: boolean): VisibilityEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const mode = entry['mode'];
  if (mode !== 'hidden' && mode !== 'link' && mode !== 'password') return null;
  if (template && mode !== 'hidden') return null;
  if (mode === 'password') {
    const id = entry['id'];
    const pv = entry['pv'];
    // A password entry whose id or version cannot be read cannot be unlocked either (the
    // cookie is signed over both), so it degrades to a 404 rather than to a public page: a
    // broken snapshot must not publish a page someone put behind a password. The next save
    // or the daily re-sync writes it again.
    if (
      typeof id !== 'string' ||
      !UUID.test(id) ||
      typeof pv !== 'number' ||
      !Number.isSafeInteger(pv) ||
      pv < 1
    ) {
      return { mode: 'hidden', target: null };
    }
    const note = parseNote(entry['note']);
    return { mode, id, pv, ...(note === undefined ? {} : { note }) };
  }
  const out: VisibilityEntry = { mode };
  if (mode === 'hidden') {
    const target = entry['target'];
    out.target = isVisibilityPageSlug(target) ? target : null;
    if (isInstant(entry['from'])) out.from = entry['from'];
    if (isInstant(entry['until'])) out.until = entry['until'];
  }
  return out;
}

/** The KV value → a snapshot, tolerating anything: a bad snapshot is every page public. */
export function parseVisibilitySnapshot(raw: string | null | undefined): VisibilitySnapshot {
  if (!raw) return EMPTY_VISIBILITY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY_VISIBILITY;
    const value = parsed as Record<string, unknown>;
    if (value['v'] !== 1) return EMPTY_VISIBILITY;
    const pages: VisibilitySnapshot['pages'] = {};
    const templates: VisibilitySnapshot['templates'] = {};
    const rawPages = value['pages'];
    if (rawPages && typeof rawPages === 'object' && !Array.isArray(rawPages)) {
      for (const [slug, entry] of Object.entries(rawPages)) {
        // The homepage is always public, whatever a snapshot says (the database refuses it too).
        if (!isVisibilityPageSlug(slug) || slug === HOME_SLUG) continue;
        const parsedEntry = parseEntry(entry, false);
        if (parsedEntry) pages[slug] = parsedEntry;
      }
    }
    const rawTemplates = value['templates'];
    if (rawTemplates && typeof rawTemplates === 'object' && !Array.isArray(rawTemplates)) {
      for (const [template, entry] of Object.entries(rawTemplates)) {
        if (!isVisibilityTemplate(template)) continue;
        const parsedEntry = parseEntry(entry, true);
        if (parsedEntry) templates[template] = parsedEntry;
      }
    }
    const rev = value['rev'];
    const tenant = value['tenant'];
    return {
      v: 1,
      builtAt: isInstant(value['builtAt']) ? value['builtAt'] : null,
      ...(typeof rev === 'string' && rev.length <= MAX_REV_LENGTH ? { rev } : {}),
      ...(typeof tenant === 'string' && UUID.test(tenant) ? { tenant } : {}),
      pages,
      templates,
    };
  } catch {
    return EMPTY_VISIBILITY;
  }
}

// ---- the isolate memo -----------------------------------------------------------------------

let memo: { value: VisibilitySnapshot; at: number } | null = null;

/** Forgets the memo: the next read goes to KV. For the tests, and nothing else. */
export function clearVisibilityMemo(): void {
  memo = null;
}

type KvEnv = { SESSION?: KVNamespace };

/**
 * The snapshot, as the middleware reads it: from the memo while it is under a minute old,
 * else from KV. FAILS OPEN (decision D6, as maintenance does): a KV error keeps the last good
 * snapshot this isolate read, or none, and the next try waits out the minute, so a failing
 * KV is not asked again on every request.
 */
export async function getVisibilitySnapshot(
  env: KvEnv,
  now: number = Date.now(),
): Promise<VisibilitySnapshot> {
  if (memo && now - memo.at < VISIBILITY_MEMO_MS && now >= memo.at) return memo.value;
  let value: VisibilitySnapshot;
  try {
    const raw = await env.SESSION?.get(VISIBILITY_KV_KEY, { cacheTtl: VISIBILITY_KV_CACHE_TTL_S });
    value = parseVisibilitySnapshot(raw);
  } catch {
    value = memo?.value ?? EMPTY_VISIBILITY;
  }
  memo = { value, at: now };
  return value;
}

/**
 * Writes the snapshot to KV and, on success, into this isolate's memo (write-through: the
 * admin's own next request sees its change at once; other isolates within the minute).
 * Never throws.
 */
export async function putVisibilitySnapshot(
  env: KvEnv,
  snapshot: VisibilitySnapshot,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    if (!env.SESSION) return false;
    await env.SESSION.put(VISIBILITY_KV_KEY, JSON.stringify(snapshot));
    memo = { value: snapshot, at: now };
    return true;
  } catch {
    return false;
  }
}

// ---- deciding --------------------------------------------------------------------------------

/**
 * The mode an entry has at `now`: hidden only inside its window, [from, until), either end
 * open; outside it, public. Link only has no window.
 */
export function effectiveMode(entry: VisibilityEntry | undefined, now: number): VisibilityMode {
  if (!entry) return 'public';
  // Only a hidden page has a window: link only and password have no dates (0057's CHECK).
  if (entry.mode !== 'hidden') return entry.mode;
  if (entry.from !== undefined && now < Date.parse(entry.from)) return 'public';
  if (entry.until !== undefined && now >= Date.parse(entry.until)) return 'public';
  return 'hidden';
}

function entryFor(
  snapshot: VisibilitySnapshot,
  target: VisibilityTarget,
): VisibilityEntry | undefined {
  if (target.kind === 'page') {
    if (target.slug === HOME_SLUG) return undefined;
    return Object.hasOwn(snapshot.pages, target.slug) ? snapshot.pages[target.slug] : undefined;
  }
  return Object.hasOwn(snapshot.templates, target.template)
    ? snapshot.templates[target.template]
    : undefined;
}

/** What a page or template is at `now`. The homepage is always public. */
export function modeOf(
  snapshot: VisibilitySnapshot,
  target: VisibilityTarget,
  now: number,
): VisibilityMode {
  return effectiveMode(entryFor(snapshot, target), now);
}

export type VisibilityGate =
  | { action: 'pass' }
  | { action: 'noindex' }
  | { action: 'hide'; to: VisibilityPageSlug | null }
  /** Behind a password: the entry carries the page's id, its version and the message. */
  | { action: 'password'; id: string; pv: number; note: VisibilityNote | null };

export const PASS: VisibilityGate = Object.freeze({ action: 'pass' }) as VisibilityGate;

/**
 * What the middleware does with a request for `target`: render it (`pass`), render it with
 * `X-Robots-Tag: noindex` (link only), or hide it: a 302 to another page, or the 404 page.
 * A redirect never chains: a target that is itself hidden at `now` (or the page itself, or a
 * page the route map does not know) is a 404 instead, so no request can loop.
 */
export function decide(
  snapshot: VisibilitySnapshot,
  target: VisibilityTarget,
  now: number,
): VisibilityGate {
  const entry = entryFor(snapshot, target);
  const mode = effectiveMode(entry, now);
  if (mode === 'public') return PASS;
  if (mode === 'link') return { action: 'noindex' };
  if (mode === 'password') {
    // parseEntry has already refused a password entry without both, so this is belt and
    // braces for a snapshot built in this isolate.
    return entry?.id !== undefined && entry.pv !== undefined
      ? { action: 'password', id: entry.id, pv: entry.pv, note: entry.note ?? null }
      : { action: 'hide', to: null };
  }
  const to = entry?.target ?? null;
  if (
    to === null ||
    !Object.hasOwn(PAGE_PATHS, to) ||
    (target.kind === 'page' && to === target.slug) ||
    modeOf(snapshot, { kind: 'page', slug: to }, now) === 'hidden'
  ) {
    return { action: 'hide', to: null };
  }
  return { action: 'hide', to };
}

/**
 * Whether a page or template is listed at `now`: in the menus, the sitemap, llms.txt and the
 * search results. Only a public one is: link only is unlisted, and hidden is gone.
 */
export function isListed(
  snapshot: VisibilitySnapshot | null | undefined,
  target: VisibilityTarget | null,
  now: number,
): boolean {
  if (!snapshot || target === null) return true;
  return modeOf(snapshot, target, now) === 'public';
}

/**
 * Every answer that hides a page: never cached anywhere, never indexed. A password gate and
 * the page behind it carry it too, so no cache in front of the Worker can ever hold either.
 */
export const HIDDEN_CACHE_CONTROL = 'private, no-store';
