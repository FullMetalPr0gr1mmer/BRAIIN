import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasConsent } from '@consent/gate';
import { consentCookieHeader } from '../e2e/consentCookie';

// The e2e specs' consent cookie (tests/e2e/consentCookie.ts). A spec that posts to a
// consent-gated endpoint with a cookie hasConsent() does not accept is answered as a visitor
// who never chose (the ingest's 204), so its assertion about the consented branch fails in CI
// or, worse, passes for the wrong reason. Held here: the helper's cookie is consent the gate
// grants, and no e2e spec builds a consent cookie by hand.

const request = (cookie: string) =>
  new Request('http://localhost:8788/api/analytics', { headers: { cookie } });

describe('consentCookieHeader', () => {
  it('builds analytics consent the gate grants', () => {
    const req = request(consentCookieHeader({ analytics: true }));
    expect(hasConsent(req, 'analytics')).toBe(true);
    expect(hasConsent(req, 'marketing')).toBe(false);
  });

  it('defaults every optional category to denied', () => {
    const req = request(consentCookieHeader({}));
    expect(hasConsent(req, 'analytics')).toBe(false);
    expect(hasConsent(req, 'marketing')).toBe(false);
  });

  it('is the only way an e2e spec builds a consent cookie', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(e2e|setup)\.ts$/.test(entry.name)) {
          const src = readFileSync(path, 'utf8');
          // A cookie value written in the spec: the name followed by `=` inside a string.
          if (/['"`]__Host-consent=/.test(src)) offenders.push(path);
        }
      }
    };
    walk('tests');
    expect(offenders).toEqual([]);
  });
});
