// The studio's domain, as site health checks its renewal (Admin v2 G2). It comes from
// `tenants.primary_domain` (0001), read by the service role: no person can change it through
// the admin today.
//
// The apex is the domain lowercased, with a trailing dot and one leading `www.` removed. No
// public suffix list: one tenant, whose domain is a registrable name (`braiinstatiion.com`);
// a deeper subdomain would be looked up as written and answer "no registration found", which
// names it, so the mistake is visible. A Cloudflare address (`*.workers.dev`, `*.pages.dev`)
// or `localhost` has no registration of ours to renew.

export type ApexResult =
  | { kind: 'apex'; apex: string }
  | { kind: 'not-applicable'; host: string | null }
  | { kind: 'invalid'; host: string };

/** Hosts whose renewal is not ours: Cloudflare's own addresses and the local machine. */
const NOT_OURS = [/(^|\.)workers\.dev$/, /(^|\.)pages\.dev$/, /^localhost$/];

/** One DNS label: letters, digits and inner hyphens, 1 to 63 characters (LDH; punycode too). */
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export function apexOf(primaryDomain: string | null | undefined): ApexResult {
  const raw = (primaryDomain ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (raw === '') return { kind: 'not-applicable', host: null };
  if (NOT_OURS.some((rule) => rule.test(raw))) return { kind: 'not-applicable', host: raw };
  const apex = raw.startsWith('www.') ? raw.slice(4) : raw;
  const labels = apex.split('.');
  const tld = labels[labels.length - 1] ?? '';
  const valid =
    apex.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => LABEL.test(label)) &&
    // An IP address is not a domain: a top-level label is never all digits.
    !/^\d+$/.test(tld) &&
    // A top-level label is letters, or an internationalised one (xn--).
    (/^[a-z]{2,63}$/.test(tld) || /^xn--[a-z0-9-]{1,59}$/.test(tld));
  return valid ? { kind: 'apex', apex } : { kind: 'invalid', host: raw.slice(0, 253) };
}
