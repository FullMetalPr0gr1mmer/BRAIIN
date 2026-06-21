// Shared same-origin (CSRF) check for state-changing / cost-bearing endpoints (CLAUDE.md
// §7 — "double-submit __Host-csrf OR same-origin check on every mutation"). Single source
// of truth so contact + ai/style-finder (and future mutations) can't drift. Pure + tested.

/**
 * True when the request is safe to process on origin grounds:
 * - no `Origin` header (same-site navigation / non-CORS request) → allow
 * - `Origin` host matches `Host` → allow
 * - mismatch or malformed `Origin` → reject
 */
export function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin || !host) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
