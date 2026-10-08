import type { SupabaseClient } from '@supabase/supabase-js';
import { anonClient } from '@/lib/supabase/client';

// THE CONTENT SEAM: the one place a public content loader (src/lib/data/*) gets its
// Supabase client. A loader calls `contentClient()`, never `anonClient()` directly:
// tests/lib/contentSource.spec.ts fails on any other use anywhere in src/.
//
// The contract:
//   - It is the anon client: the anon key, under RLS, so a loader sees only what a visitor
//     may (published or visible rows of the launch tenant, behind the anon tenant fence).
//   - It reads public content. Never a write, an admin read or PII: those take the service
//     client behind assertCap, or the staff session.
//   - Resolve it per query, while the query is built (`contentClient().from(…)`). Never
//     keep it in a module-level variable, and never call it inside a `.then()` callback.
//
// Why the last rule: this is the seam the releases preview extends (R8,
// docs/admin-v2/releases.md §6.3). Inside the `/admin/preview` branch of src/middleware.ts
// the request will run in an AsyncLocalStorage scope whose client serves live rows plus
// pending changes, and `contentClient()` will return that client there and the anon client
// everywhere else. A scope reaches only code on the request's own async chain, and workerd
// does not carry it through every thenable (supabase-js builders are thenables), so the
// lookup has to happen synchronously, when the query is built. A public request never
// enters a scope: it always gets the anon client, so Tier A output, caching and the RLS
// posture stay as they are.
//
// Today there is no scope. This returns exactly what `anonClient()` returns, the same
// memoised instance, so every public query is the one it was before the seam.
export function contentClient(): SupabaseClient {
  return anonClient();
}
