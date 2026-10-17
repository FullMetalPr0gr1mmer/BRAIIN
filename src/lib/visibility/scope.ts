import { AsyncLocalStorage } from 'node:async_hooks';

// Which page THIS request has unlocked (Admin v2 U14b).
//
// A page behind a password is fenced in the database: anon reads none of its sections
// (page_sections_password_fence, 0061), so the ordinary content loader returns nothing for
// it even when the edge gate fails open. A request that HAS typed the password must read
// them another way, and the only code that may is the loader itself, for that one page.
// This is how the loader knows: the middleware runs the render inside
// `withPageAccess(pageId, …)` once the cookie verifies, and src/lib/data/pageSections.ts
// asks `pageAccess()`.
//
// A scope of its own module, not the content seam's: R8 adds the releases preview scope to
// src/lib/data/source.ts, and the two answer different questions (which client, versus
// which page this visitor opened). Keeping them apart means neither can widen the other.
//
// AsyncLocalStorage works in workerd with `nodejs_compat`, which wrangler.jsonc sets
// (docs/admin-v2/verification.md, claim 11). Its one caveat is that a lookup made inside a
// THENABLE's then() may not see the scope, and a supabase-js builder is a thenable — so
// `pageAccess()` is read at the top of a loader, before any query is awaited, never after.
//
// Outside a scope — every ordinary public request, the admin, the cron — it is undefined,
// and the loader does exactly what it did before.

export interface PageAccess {
  /** The page this request proved the password for (`pages.id`). */
  readonly pageId: string;
  /** The tenant that page belongs to, resolved server-side. */
  readonly tenantId: string;
}

const scope = new AsyncLocalStorage<PageAccess>();

/** Runs `fn` as a request that has unlocked one page. */
export function withPageAccess<T>(access: PageAccess, fn: () => T): T {
  return scope.run(access, fn);
}

/** The page this request unlocked, or undefined outside a scope. */
export function pageAccess(): PageAccess | undefined {
  return scope.getStore();
}
