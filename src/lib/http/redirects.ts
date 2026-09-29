// The edge half of the v1 redirects/canonical module (CLAUDE.md Pillar 3).
//
// Redirects are authored in the `redirects` table (Admin + SEO). Every save and delete
// rebuilds the tenant's whole map and snapshots it into KV `site:redirects` — the
// maintenance pattern (src/lib/http/maintenance.ts): the row for durability and audit,
// the key for the read path, because the middleware must never put Postgres on the
// critical path of a public request. Before Round 3 nothing wrote the key, so every
// authored rule was dead (design-port R3-1).
//
// Precedence (R3-d): live page > route-level code map (src/lib/services/retired.ts,
// services only) > this map > 404. The middleware consults the map ONLY when the render
// answered 404, so an authored rule can never shadow a page that exists — a restored
// service, a new post at an old URL — and a request that renders never pays a KV read.
//
// Dependency-free on purpose: src/middleware.ts imports this module, and the i18n
// helpers it uses are pure.

import { localeFromPath, localizedHref, toLogicalPath } from '@/lib/i18n';

export interface RedirectRule {
  to: string;
  status: 301 | 302 | 308;
}

/** Source pathname (normalised) → rule. A plain JSON object, so look it up with hasOwn. */
export type RedirectMap = Record<string, RedirectRule>;

export const REDIRECTS_KV_KEY = 'site:redirects';

/**
 * The lifetime of a PERMANENT redirect (301/308). Shared with the code-owned
 * retired-services map (retired.ts imports it) so both kinds of 30x carry the same
 * lifetime. NOT Tier A — never purged on publish — so a rule deleted in the admin stops
 * applying within a day at worst, and a browser that cached a 301 longer than that is
 * the visitor's cache, not ours.
 */
export const REDIRECT_CACHE_CONTROL = 'public, max-age=86400';

/**
 * A TEMPORARY redirect (302) is temporary because it may change or go away: it is never
 * cached, at the edge or in the browser, so an editor's change to it applies at once.
 */
export const TEMPORARY_REDIRECT_CACHE_CONTROL = 'no-cache';

/**
 * How long a Worker isolate may serve the map it last read (seconds). A save is visible
 * at the edge within this window; the design is this TTL, not a purge call (no Cloudflare
 * API dependency on the admin save path).
 */
export const REDIRECT_MAP_CACHE_TTL_S = 60;

/** The most rules one tenant's snapshot carries; the sync reports `truncated` beyond it. */
export const REDIRECT_MAP_LIMIT = 5000;

/**
 * Paths a rule may never claim: the CMS, its API, the health probe the synthetic monitors
 * hit, and the build's own asset routes. A source under any of these is refused at save
 * time (resources.ts) AND dropped while building the map — the map is what the edge
 * reads, so a row that reached the table by another path still cannot lock anyone out.
 */
export const RESERVED_REDIRECT_PREFIXES: readonly string[] = [
  '/admin',
  '/api/',
  '/healthz',
  '/_astro/',
  '/_image',
  '/media/',
  '/fonts/',
  '/styles/',
];

export function isReservedRedirectPath(pathname: string): boolean {
  const path = normalizeRedirectPath(pathname);
  return RESERVED_REDIRECT_PREFIXES.some((prefix) => {
    const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    return path === base || path.startsWith(`${base}/`);
  });
}

/** A throwaway base for canonicalising site-relative references; never leaves this file. */
const CANONICAL_BASE = 'https://x';

/**
 * The pathname a site-relative reference resolves to, or null when it is not one: not
 * starting with `/`, or resolving OFF the site — `//host/x`, and `/\host/x` too, because
 * the URL standard reads a backslash as a slash in an https URL, so a target that passed
 * a "starts with a single /" check could still send a visitor to another host.
 * Canonical means what the browser sends: percent-encoded (`/عن` and `/%D8%B9%D9%86` are
 * one path), dot segments resolved, query and fragment dropped.
 */
export function sitePathOf(reference: string): string | null {
  const raw = reference.trim();
  if (!raw.startsWith('/')) return null;
  try {
    const url = new URL(raw, CANONICAL_BASE);
    return url.origin === CANONICAL_BASE ? url.pathname : null;
  } catch {
    return null;
  }
}

/**
 * The one spelling of a source path the map is keyed by: canonicalised by the URL parser
 * (so a key authored as `/عن` matches the `/%D8%B9%D9%86` the request carries), one
 * trailing slash removed (`trailingSlash: 'ignore'` renders `/old` and `/old/` alike, so
 * a rule must match both), the root kept as `/`. Query and fragment never belong in a key
 * — the schema refuses them on write and the parser drops them here. A reference that is
 * not a site path is returned trimmed, for the callers that check that themselves.
 */
export function normalizeRedirectPath(raw: string): string {
  const path = sitePathOf(raw) ?? raw.trim();
  if (path === '/' || path === '') return '/';
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

/**
 * The normalised path part of a site-relative target (`/new?x#y` → `/new`); null for an
 * absolute target, and for one that only looks site-relative (`//host`, `/\host`).
 */
export function targetPathOf(target: string): string | null {
  const path = sitePathOf(target);
  return path === null ? null : normalizeRedirectPath(path);
}

function coerceStatus(status: unknown): RedirectRule['status'] {
  return status === 302 || status === 308 ? status : 301;
}

/**
 * Table rows → the map the edge reads. Keys are normalised, reserved sources are dropped,
 * a rule with no usable target is dropped — no target, or a "site-relative" one that
 * resolves off the site (`//host`, `/\host`): the schema refuses those on write, and the
 * map refuses them again because the map is what the edge serves — and on a duplicate
 * key (two rows that differ only by a trailing slash) the first row wins — rows arrive
 * ordered by source path, so the outcome is deterministic. Pure, so the sync and the
 * tests share it.
 */
export function buildRedirectMap(
  rows: readonly { source_path: unknown; target_path: unknown; status?: unknown }[],
): RedirectMap {
  const map: RedirectMap = {};
  for (const row of rows) {
    if (typeof row.source_path !== 'string' || typeof row.target_path !== 'string') continue;
    if (sitePathOf(row.source_path) === null) continue;
    const key = normalizeRedirectPath(row.source_path);
    const to = row.target_path.trim();
    if (to.length === 0 || (to.startsWith('/') && sitePathOf(to) === null)) continue;
    if (isReservedRedirectPath(key)) continue;
    if (Object.hasOwn(map, key)) continue;
    map[key] = { to, status: coerceStatus(row.status) };
  }
  return map;
}

/** The KV value → a map, tolerating anything: a bad snapshot is no redirects, never a 500. */
export function parseRedirectMap(raw: string | null | undefined): RedirectMap {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const map: RedirectMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!key.startsWith('/')) continue;
      const rule = value as Partial<RedirectRule> | null;
      if (!rule || typeof rule !== 'object' || typeof rule.to !== 'string') continue;
      map[key] = { to: rule.to, status: coerceStatus(rule.status) };
    }
    return map;
  } catch {
    return {};
  }
}

type KvEnv = { SESSION?: KVNamespace };

/**
 * The snapshot, as the middleware reads it. `cacheTtl` lets the isolate reuse the value
 * for a minute instead of a KV round-trip per 404. FAILS OPEN: a KV blip means "no
 * authored redirects", and the request goes on to the 404 it was already answering.
 */
export async function getRedirectMap(env: KvEnv): Promise<RedirectMap> {
  try {
    const raw = await env.SESSION?.get(REDIRECTS_KV_KEY, { cacheTtl: REDIRECT_MAP_CACHE_TTL_S });
    return parseRedirectMap(raw);
  } catch {
    return {};
  }
}

/**
 * The rule for a pathname, or null. An own-property lookup: `/constructor` must not find
 * Object.prototype. The `/ar` twin fallback (design-port R3-2): an Arabic URL with no
 * rule of its own falls back to the English rule for its logical path, and a
 * site-relative English target is re-localised (`/ar/old` → `/ar/new`). An explicit
 * `/ar/…` row wins over the fallback; an absolute target is left untouched.
 *
 * A rule whose target is the requested path itself is NO rule: the save path refuses
 * `/x → /x` and `/x → /ar/x` (the twin fallback would re-localise the latter onto
 * `/ar/x` = the request), but the map is a snapshot and this is the last line before a
 * Location header — a self-referential 30x is an infinite redirect, never served.
 */
export function lookupRedirect(pathname: string, map: RedirectMap): RedirectRule | null {
  const key = normalizeRedirectPath(pathname);
  const rule = resolveRule(key, map);
  if (!rule || targetPathOf(rule.to) === key) return null;
  return rule;
}

function resolveRule(key: string, map: RedirectMap): RedirectRule | null {
  if (Object.hasOwn(map, key)) return map[key] ?? null;
  if (localeFromPath(key) !== 'ar') return null;
  const logical = normalizeRedirectPath(toLogicalPath(key));
  if (logical === key || !Object.hasOwn(map, logical)) return null;
  const rule = map[logical];
  if (!rule) return null;
  const to = localeFromPath(rule.to) === 'ar' ? rule.to : localizedHref(rule.to, 'ar');
  return { to, status: rule.status };
}

/**
 * Where the visitor is sent: the target, plus the request's query string when the target
 * has none of its own (`/old?utm=x` → `/new?utm=x` — campaign links keep working after a
 * move); a target that already carries a query is authored deliberately and wins. The
 * query goes BEFORE the target's fragment (`/services#branding` + `?utm=x` →
 * `/services?utm=x#branding`): after it, it would be part of the fragment and never reach
 * the server.
 */
export function redirectLocation(rule: RedirectRule, search: string): string {
  if (!search) return rule.to;
  const hash = rule.to.indexOf('#');
  const base = hash === -1 ? rule.to : rule.to.slice(0, hash);
  const fragment = hash === -1 ? '' : rule.to.slice(hash);
  if (base.includes('?')) return rule.to;
  return `${base}${search}${fragment}`;
}

/**
 * The 30x itself. A permanent redirect (301/308) carries REDIRECT_CACHE_CONTROL; a
 * temporary one (302) is `no-cache` — it is temporary precisely because it may change.
 */
export function redirectResponse(rule: RedirectRule, url: URL): Response {
  return new Response(null, {
    status: rule.status,
    headers: {
      Location: redirectLocation(rule, url.search),
      'Cache-Control':
        rule.status === 302 ? TEMPORARY_REDIRECT_CACHE_CONTROL : REDIRECT_CACHE_CONTROL,
    },
  });
}

/** Snapshots the map into KV — what the middleware actually reads. Never throws. */
export async function putRedirectMap(env: KvEnv, map: RedirectMap): Promise<boolean> {
  try {
    if (!env.SESSION) return false;
    await env.SESSION.put(REDIRECTS_KV_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}
