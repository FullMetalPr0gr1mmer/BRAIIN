import { AsyncLocalStorage } from 'node:async_hooks';
import type { SupabaseClient } from '@supabase/supabase-js';
import { anonClient } from '@/lib/supabase/client';

// THE CONTENT SEAM: the one place a public content loader (src/lib/data/*) gets its
// Supabase client. A loader calls `contentClient()`, never `anonClient()` directly.
// tests/lib/contentSource.spec.ts holds the rules below: no other file in src/ names
// `anonClient`, the loaders that call this are pinned, and each builds its queries on it.
//
// The contract:
//   - It is the anon client: the anon key, under RLS, so a loader sees only what a visitor
//     may (published or visible rows of the launch tenant, behind the anon tenant fence).
//   - It reads public content. Never a write, an admin read or PII: those take the service
//     client behind assertCap, or the staff session.
//   - Look it up as each query is built (`contentClient().from(…)`), then await the
//     builder. Never keep it in a module-level variable, and never look it up inside a
//     thenable's `then()`: a loader hands a supabase-js builder no `.then()` callback.
//
// Why the last rule: this is the seam the releases preview extends (R8,
// docs/admin-v2/releases.md §6.3). Inside the `/admin/preview` branch of src/middleware.ts
// the request will run in an AsyncLocalStorage scope whose client serves live rows plus
// pending changes, and `contentClient()` will return that client there and the anon client
// everywhere else. The scope follows the request's async chain through native promises, so
// a loader called from a native promise's `.then()` callback still sees it (as in
// src/lib/seo/head.ts, src/lib/services/page.ts and src/lib/portfolio/casePage.ts). workerd
// does not fully carry it into a thenable's `then()` (docs/admin-v2/verification.md, claim
// 11), and a supabase-js builder is a thenable, so a lookup made there could get the anon
// client inside a preview. A public request never enters a scope: it always gets the anon
// client, so Tier A output, caching and the RLS posture stay as they are.
//
// The scope (Admin v2 R8). `withContentSource(source, fn)` runs `fn` with `source` as the
// store; inside it `contentClient()` returns `source.client()`, outside it the anon client,
// the same memoised instance, so a public query is the one it was before the seam. Only
// `als.run()` is used (workerd omits `enterWith` and `disable`), a scope never nests, and
// nothing here imports the preview: the preview implements ContentSource, so no public
// import graph reaches the emulator, the release registry or its parsers through this file.
//
// The tripwire. A lookup that finds no store while a preview scope is open may be a
// preview render that lost its scope (a thenable's `then()`, a library callback) and is
// about to show the live site as if it were the preview. A lost scope cannot be traced
// back to its request, so every open scope is told (`noteAnonLookup`) and its report marks
// the render untrusted (src/lib/preview/report.ts). A public request served by the same
// isolate during a preview trips it too: a false alarm costs a reload prompt in preview
// only, and the public request still gets the anon client.
//
// The tripwire sees only lookups made while a scope is open. A render that resolves to a
// Response and then streams its body would run its components after the scope has
// closed, where they get the anon client and nothing notices. So when `fn` resolves to a
// Response with a body, withContentSource reads that body to the end INSIDE the scope and
// returns a buffered copy (same status, status text and headers): every lookup of the
// render happens in the scope, and R9's middleware need not buffer itself. What runs
// after it returns (a `waitUntil`, a stream started elsewhere) is not the render's and is
// not seen: keep such work out of a preview.
//
// The two module-level values below hold no request data: the scope's storage, and the
// set of scopes currently open, each removed when its scope ends, even on a throw. The set
// holds a WEAK reference to each source, so a scope whose `fn` never settles (a request
// cancelled mid-render) does not keep the source, its rows and its drafts alive for the
// isolate's life: once nothing else holds the source it can be collected, and its token
// is dropped at the next lookup. tests/lib/contentSource.spec.ts allows exactly these two.

/** What the preview hands the seam: its client, and where a lost-scope lookup is reported. */
export interface ContentSource {
  /** The client loaders get inside the scope (the preview's overlay emulator). */
  client(): SupabaseClient;
  /** Called by contentClient() when a lookup found NO scope while this one was open. */
  noteAnonLookup(): void;
}

/** One open scope, as the tripwire knows it: a weak reference to its source. */
interface OpenScope {
  readonly source: WeakRef<ContentSource>;
}

const scope = new AsyncLocalStorage<ContentSource>();
const openScopes = new Set<OpenScope>();

/** A Response with a body, read to the end now: a copy with the same status and headers. */
async function buffered<T>(value: T): Promise<T> {
  if (!(value instanceof Response) || value.body === null) return value;
  const body = await value.arrayBuffer();
  return new Response(body, {
    status: value.status,
    statusText: value.statusText,
    headers: value.headers,
  }) as T;
}

/**
 * Runs `fn` with `source` as the content source for everything it awaits, and reads a
 * Response it resolves to to the end inside the scope (see above). Refuses to nest (one
 * source per request) and to open one source twice; the scope leaves the open set when
 * `fn` settles, whether it resolved or threw.
 */
export async function withContentSource<T>(
  source: ContentSource,
  fn: () => Promise<T>,
): Promise<T> {
  if (scope.getStore() !== undefined) {
    throw new Error('withContentSource: a content scope is already open on this request');
  }
  for (const open of openScopes) {
    if (open.source.deref() === source) {
      throw new Error('withContentSource: this source already serves an open scope');
    }
  }
  const token: OpenScope = { source: new WeakRef(source) };
  openScopes.add(token);
  try {
    return await scope.run(source, async () => buffered(await fn()));
  } finally {
    openScopes.delete(token);
  }
}

export function contentClient(): SupabaseClient {
  const store = scope.getStore();
  if (store !== undefined) return store.client();
  for (const open of openScopes) {
    const source = open.source.deref();
    if (source) source.noteAnonLookup();
    else openScopes.delete(open);
  }
  return anonClient();
}
