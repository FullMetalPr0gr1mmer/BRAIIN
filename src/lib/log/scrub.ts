// PII scrubbing for operational logs (CLAUDE.md §10 — "beforeSend strips lead PII").
// Applied to every client-reported log line BEFORE it is persisted or forwarded, so an
// error message that happens to contain a visitor's email/phone never reaches storage.
// Kept as its own pure module so it stays unit-testable (the persistence layer pulls
// astro:env and cannot be imported from vitest).

export function scrubPii(s: string): string {
  return (
    s
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
      // `\(?` so a parenthesised area code — "(555) 010-9999" — is consumed whole rather
      // than leaving a stray "(" behind. Requires ≥9 digits/separators so short numbers
      // ("after 3 retries") are never eaten.
      .replace(/\+?\(?\d[\d\s().-]{7,}\d/g, '[phone]')
  );
}
