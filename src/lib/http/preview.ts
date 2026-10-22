import type { SystemLogEntry } from '@schemas/systemLog';
import type { AuthContext } from '@/lib/auth/types';
import { AuthorizationError } from '@/lib/authz/errors';
import { assertAnyCap } from '@/lib/authz/matrix';
import { withContentSource } from '@/lib/data/source';
import { decide, PASS, type VisibilityGate, type VisibilitySnapshot } from '@/lib/http/visibility';
import { pageAccessGate } from '@/lib/visibility/gate';
import { localizedPagePath, targetForPath } from '@/lib/visibility/routes';
import { pageAccess } from '@/lib/visibility/scope';
import { PREVIEW_PREFIX, READ_ONLY_ENDPOINTS, toPreviewPath } from '@/lib/admin/preview/paths';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  canPreview,
  createPreviewSource,
  PREVIEW_READ_CAPS,
  type VersionPreview,
} from '@/lib/preview/dataset';
import { AS_OF_PREVIEW_MAX } from '@schemas/release';
import { asOfChanges, asOfTargets, readAsOf } from '@/lib/release/asOf';
import { assessPreview, previewLogFields } from '@/lib/preview/report';
import { injectRibbon, renderRibbon, type RibbonVerdict } from '@/lib/preview/ribbon';
import { previewTarget, twinPath } from '@/lib/preview/routes';

// The `/admin/preview/**` branch of src/middleware.ts (Admin v2 R9; releases.md §6.3 item 6).
// The middleware calls it after its session gate (a request with no session never gets
// here) and secures what it returns like any admin response; this decides what renders.
//
//   1. GET and HEAD only: a preview changes nothing.
//   2. The door: one of PREVIEW_READ_CAPS at full, view or meta (R8: the same answer as
//      `canPreview` for every role). Sales, an inactive or a missing session: 403.
//   3. Never inside a page-access scope (U14b): there two loaders read that page's LIVE
//      sections with the service role, past the content seam, and the verdict could not
//      see it. The middleware never opens one on an admin path; this refuses if one is open.
//   4. The path must be a Tier A page (src/lib/preview/routes.ts). Anything else falls
//      through to the preview's own 404 page (src/pages/admin/preview/[...path].astro).
//   5. The person's own source (R8's dataset: their client, their role's areas), and the
//      PUBLIC route rendered through Astro's rewrite inside `withContentSource`, which
//      buffers the response inside the scope (R8). The page code is the public page's.
//   6. The verdict, read only now that the render is over; an untrusted render is logged
//      to system_logs (counts and names, never a row), then the ribbon is spliced in.
//
// A version (`?v=N`, Admin v2 R10; releases.md slice R10): before step 5, the state at version
// N, read from the ledger under the person's own RLS in one call (`release_as_of`, 0104: CMS
// staff only); no such version (releases off, a number never published, another tenant's) is
// a 404 that renders nothing. The page is then rendered with the changes back to N in place of
// the pending changes, and the ribbon says which version it shows. An old version's content is
// shown with today's code, design and pictures (releases.md, slice R10's risks).
//
// Page visibility (U14a, U14b) follows the LIVE snapshot, as R8 decided for pending
// visibility changes: a hidden or link-only page renders (staff preview it) with a ribbon
// line saying what visitors get, and a page behind a password shows visitors' password
// prompt, because the content seam reads its sections as a visitor does (0061's fence)
// and the page behind it would be the built-in composition, not the page.

export interface PreviewLocals {
  /** The page's language. */
  locale: 'en' | 'ar';
  /** This preview's path (the bridge reports it to the parent). */
  path: string;
}

export interface PreviewContext {
  request: Request;
  url: URL;
  nonce: string;
  locals: {
    session: AuthContext | null;
    supabase?: SupabaseClient;
    visibility?: VisibilitySnapshot;
    preview?: PreviewLocals;
  };
}

export interface PreviewDeps {
  /** Astro's rewrite: renders the public path (the middleware's `next(path)`). */
  render(publicPath: string): Promise<Response>;
  /** The route Astro matched, unrewritten (the preview's 404 page). */
  fallthrough(): Promise<Response>;
  /** The live page-visibility snapshot (src/lib/http/visibility.ts). */
  snapshot(): Promise<VisibilitySnapshot>;
  /** system_logs. */
  log(entry: SystemLogEntry): Promise<unknown>;
  now?: () => number;
}

export interface PreviewOutcome {
  response: Response;
  /** True when a public page rendered in the preview (its CSP then sends no form). */
  rendered: boolean;
}

const PRIVATE = 'private, no-store, max-age=0, must-revalidate';

/**
 * A preview render's `connect-src` (the middleware passes it to the CSP): exactly the API
 * endpoints that write nothing, at this origin. The bridge refuses every other request too,
 * but only once it runs; this holds from the first byte, so a page script that asks at
 * start-up (the search page's `?q=`) is refused by the browser, and no row is written.
 */
export function previewConnectSources(origin: string): string[] {
  return READ_ONLY_ENDPOINTS.map((path) => `${origin}${path}`);
}

/** A short plain answer for the cases that render no page. */
function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
  const html =
    '<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8">' +
    '<meta name="robots" content="noindex,nofollow"><title>Preview</title></head>' +
    `<body><main><p>${text}</p><p><a href="/admin">Back to the admin</a></p></main></body></html>`;
  return new Response(html, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': PRIVATE, ...extra },
  });
}

/** The preview's own parameters a link inside it keeps (`only`, or `v`). */
function keepParams(target: URL, only: readonly string[] | undefined, version: number | undefined) {
  if (only) target.searchParams.set('only', only.join(','));
  if (version !== undefined) target.searchParams.set('v', String(version));
}

/** A redirect the public page answered, kept inside the preview when it can be. */
function keepInPreview(
  response: Response,
  url: URL,
  only: readonly string[] | undefined,
  version: number | undefined,
) {
  const location = response.headers.get('location');
  if (response.status < 300 || response.status > 399 || !location) return response;
  let to: URL;
  try {
    to = new URL(location, url);
  } catch {
    return response;
  }
  if (to.origin !== url.origin) return response;
  const inside = toPreviewPath(`${to.pathname}${to.search}`);
  if (!inside) return response;
  const target = new URL(inside, url);
  keepParams(target, only, version);
  const out = new Response(null, { status: response.status, headers: response.headers });
  out.headers.set('location', `${target.pathname}${target.search}${to.hash}`);
  return out;
}

export async function handlePreview(
  ctx: PreviewContext,
  deps: PreviewDeps,
): Promise<PreviewOutcome> {
  const { request, url, locals, nonce } = ctx;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return {
      response: plain(405, 'A preview can only be opened.', { allow: 'GET, HEAD' }),
      rendered: false,
    };
  }
  // `canPreview` first: it reads a role the matrix does not know (a future Sales token) as
  // holding nothing, where assertAnyCap would index the matrix with it.
  const who = locals.session;
  if (!who || !who.isActive || !canPreview(who.role)) {
    return { response: plain(403, "Your role can't preview the site."), rendered: false };
  }
  try {
    assertAnyCap(who, PREVIEW_READ_CAPS, ['full', 'view', 'meta']);
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { response: plain(403, "Your role can't preview the site."), rendered: false };
    }
    throw err;
  }
  if (pageAccess() !== undefined) {
    return { response: plain(403, "This preview can't open here."), rendered: false };
  }

  const resolved = previewTarget(url);
  if (!resolved.ok) {
    if (resolved.reason === 'bad-selection') {
      return {
        response: plain(400, "That selection of changes can't be previewed."),
        rendered: false,
      };
    }
    if (resolved.reason === 'bad-version') {
      return { response: plain(400, "That version can't be previewed."), rendered: false };
    }
    return { response: await deps.fallthrough(), rendered: false };
  }
  const { target } = resolved;
  if (!locals.supabase) {
    return { response: plain(403, "Your role can't preview the site."), rendered: false };
  }

  // A version: the state at it, from the ledger, under the person's own RLS (R10).
  let asOf: VersionPreview | undefined;
  if (target.version !== undefined) {
    let state;
    try {
      state = await readAsOf(locals.supabase, who, target.version, { limit: AS_OF_PREVIEW_MAX });
    } catch {
      // The ledger could not be read (a dropped connection, a shape the Worker does not know):
      // said plainly and logged with the route only, never a half-read version.
      await deps.log({
        level: 'error',
        source: 'preview',
        message: 'A version could not be read for its preview.',
        detail: { route: target.route },
      });
      return {
        response: plain(503, "This version couldn't be read just now. Reload to try again."),
        rendered: false,
      };
    }
    if (!state) return { response: plain(404, "That version doesn't exist."), rendered: false };
    asOf = {
      number: state.release.number,
      changes: asOfChanges(asOfTargets(state.entities)),
      truncated: state.total > state.entities.length,
    };
  }

  let source;
  try {
    source = createPreviewSource({
      supabase: locals.supabase,
      session: locals.session,
      ...(target.only ? { only: target.only } : {}),
      ...(asOf ? { asOf } : {}),
    });
  } catch (err) {
    if (err instanceof AuthorizationError) {
      return { response: plain(403, "Your role can't preview the site."), rendered: false };
    }
    throw err;
  }

  // The live visibility snapshot: the menus, the sitemap's links and the ribbon read it.
  const snapshot = await deps.snapshot();
  locals.visibility = snapshot;
  const visibilityTarget = targetForPath(target.logical);
  const gate: VisibilityGate = visibilityTarget
    ? decide(snapshot, visibilityTarget, (deps.now ?? Date.now)())
    : PASS;
  const self = `${url.pathname}${url.search}`;
  locals.preview = {
    locale: target.locale,
    path: url.pathname === `${PREVIEW_PREFIX}/` ? PREVIEW_PREFIX : url.pathname,
  };

  let response: Response;
  let verdict: RibbonVerdict;
  if (gate.action === 'password' && visibilityTarget?.kind === 'page') {
    // What a visitor without the password gets. Nothing is read: the prompt is static.
    const prompt = pageAccessGate({
      nonce,
      locale: target.locale,
      page: visibilityTarget.slug,
      next: localizedPagePath(visibilityTarget.slug, target.locale),
      note: gate.note,
      wrong: false,
    });
    response = new Response(await prompt.text(), { status: 200, headers: prompt.headers });
    verdict = { state: 'locked' };
  } else {
    response = await withContentSource(source, () => deps.render(target.publicPath));
    const report = source.report();
    verdict = assessPreview(report);
    if (verdict.state === 'untrusted') {
      await deps.log({
        level: 'warn',
        source: 'preview',
        message: 'A preview render could not be trusted.',
        detail: { route: target.route, reasons: verdict.reasons, ...previewLogFields(report) },
      });
    }
  }

  response = keepInPreview(response, url, target.only, target.version);
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('text/html') && response.body !== null) {
    const ribbon = renderRibbon({
      verdict,
      gate,
      self,
      twin: twinPath(target),
      twinLocale: target.locale === 'ar' ? 'en' : 'ar',
      ...(target.only ? { only: target.only } : {}),
      ...(target.version !== undefined ? { version: target.version } : {}),
    });
    const html = injectRibbon(await response.text(), ribbon);
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    response = new Response(html, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return { response, rendered: true };
}
