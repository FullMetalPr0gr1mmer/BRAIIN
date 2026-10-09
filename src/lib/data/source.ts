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
// Today there is no scope. This returns exactly what `anonClient()` returns, the same
// memoised instance, so every public query is the one it was before the seam.
export function contentClient(): SupabaseClient {
  return anonClient();
}
