import { CSP_REPORT_ONLY, STATIC_SECURITY_HEADERS } from '@/lib/http/securityHeaders';
import { TRAINING_DENY } from '@/lib/seo/crawlers';

// The site's security facts for the health checklist (Admin v2 U2): read from the code that
// enforces them, never measured over the network, so they cost nothing to check and cannot
// be wrong about this build. Imports only; no reads.
//
// The admin's privacy is a fact of two files this module cannot import (the middleware is
// the request pipeline, the layout an Astro component): the middleware sends every /admin
// response `private, no-store` and the layout marks every admin page noindex.
// tests/lib/healthChecklist.spec.ts reads both and fails if either stops being true.

export interface SecurityFact {
  id: string;
  ok: boolean;
  /** What is true, said plainly. */
  text: string;
  /** What it means, or what to do when it is not so. */
  detail: string;
}

/** The HSTS header the site sends: on, with preload. */
const HSTS = STATIC_SECURITY_HEADERS['Strict-Transport-Security'];

/** The admin is never cached and never indexed (see above; held by the checklist spec). */
export const ADMIN_PRIVATE = true;

export function securityFacts(): SecurityFact[] {
  return [
    {
      id: 'csp',
      ok: !CSP_REPORT_ONLY,
      text: CSP_REPORT_ONLY
        ? 'Content Security Policy is only reporting'
        : 'Content Security Policy is enforced',
      detail: CSP_REPORT_ONLY
        ? 'Injected scripts are reported, not blocked. Switch it to enforce once the reports are clean.'
        : 'A script the site did not send is blocked.',
    },
    {
      id: 'hsts',
      ok: /max-age=\d+/.test(HSTS) && HSTS.includes('preload'),
      text: 'Browsers always use HTTPS (HSTS, preload)',
      detail: 'No page is ever served unencrypted.',
    },
    {
      id: 'admin',
      ok: ADMIN_PRIVATE,
      text: 'The admin is never cached or indexed',
      detail: 'Every admin page is private and marked noindex.',
    },
    {
      id: 'crawlers',
      ok: TRAINING_DENY.length > 0,
      text: 'AI training crawlers are blocked',
      detail: `${TRAINING_DENY.length} training crawlers are refused in robots.txt; search and answer crawlers are allowed.`,
    },
  ];
}
