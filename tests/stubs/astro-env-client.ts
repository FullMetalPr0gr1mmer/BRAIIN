// Stub for `astro:env/client` under vitest (the virtual module only exists inside the
// Astro build). Aliased in vitest.config.ts. Without this, NOTHING that reads config —
// every route, every endpoint — could be unit-tested at all, which is why tests/ had no
// coverage of src/pages/ before this.
//
// The Supabase values deliberately keep the sentinel `example.supabase.co` /
// `ci-dummy-anon-key` markers that `supabaseConfigured()` checks for, so tests exercise
// the unconfigured path and never attempt a real network call.
//
// PUBLIC_SITE_URL is the studio's real origin, spelled with two i's — the one-i domain was
// never theirs (tests/lib/staleDomain.spec.ts). The rule for fixtures: an expected value
// the CODE computes from PUBLIC_SITE_URL (a sitemap <loc>, a feed link, a JSON-LD url) is
// derived from this export — `import { PUBLIC_SITE_URL as SITE } from '../stubs/astro-env-client'`
// — never retyped. A value a test supplies itself and the code only echoes (a request's
// host or origin, a canonical override) is the test's own choice and stays as written,
// unless it sits beside a derived expectation and implies the same origin; then it is
// derived too.

export const PUBLIC_SITE_URL = 'https://www.braiinstatiion.com';
export const PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
export const PUBLIC_SUPABASE_ANON_KEY = 'ci-dummy-anon-key';
