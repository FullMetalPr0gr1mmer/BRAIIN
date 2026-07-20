// Stub for `astro:env/client` under vitest (the virtual module only exists inside the
// Astro build). Aliased in vitest.config.ts. Without this, NOTHING that reads config —
// every route, every endpoint — could be unit-tested at all, which is why tests/ had no
// coverage of src/pages/ before this.
//
// The Supabase values deliberately keep the sentinel `example.supabase.co` /
// `ci-dummy-anon-key` markers that `supabaseConfigured()` checks for, so tests exercise
// the unconfigured path and never attempt a real network call.

export const PUBLIC_SITE_URL = 'https://www.braiinstation.com';
export const PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
export const PUBLIC_SUPABASE_ANON_KEY = 'ci-dummy-anon-key';
