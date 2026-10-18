import { z } from 'zod';
import { PROBE_CAPS, type RdapBase } from '@schemas/healthProbe';
import { OutboundError, outboundJson, safeUrl, type OutboundOptions } from '@/lib/http/outbound';

// The domain's renewal date from its public registration record (Admin v2 G2): RDAP, the
// registries' JSON protocol (RFC 9082 queries, RFC 9083 answers), which carries the
// domain's `expiration` event. RDAP says nothing about TLS certificates; their expiry comes
// from the uptime monitor when it reports one (decision D3).
//
//   bootstrap   IANA's registry of RDAP servers (RFC 9224, https://data.iana.org/rdap/
//               dns.json): the longest TLD in it that ends the domain names the registry's
//               base URL, https only. The probe keeps the entry it used for 30 days, so a
//               daily read costs one request (two on the day the entry is refreshed).
//   lookup      GET <base>domain/<apex>: a 404 is "no registration found"; an answer with no
//               expiration event is "unknown" (some registries publish none); the registrar
//               is the entity with the `registrar` role, its vCard `fn`, cut to 80
//               characters.
//
// SSRF: the base URL is IANA's (https, no credentials, at most one redirect, a capped body:
// src/lib/http/outbound.ts), and the domain is the tenant's own, validated as a hostname
// (src/lib/health/domain.ts) before it reaches a URL.

export const IANA_BOOTSTRAP = 'https://data.iana.org/rdap/dns.json';

const BootstrapSchema = z.object({
  services: z.array(z.tuple([z.array(z.string()), z.array(z.string())]).rest(z.unknown())),
});

/**
 * The RDAP base URL for a domain from a bootstrap file: the longest TLD entry that ends the
 * domain, its first https URL (with a trailing slash). Null when no entry covers it.
 */
export function rdapBaseFor(
  apex: string,
  bootstrap: unknown,
): { tld: string; base: string } | null {
  const parsed = BootstrapSchema.safeParse(bootstrap);
  if (!parsed.success) return null;
  const labels = apex.toLowerCase().split('.');
  // Every suffix of the domain, longest first ("example.com.sa": "example.com.sa",
  // "com.sa", "sa"); the bootstrap names TLDs, so the apex itself never matches in practice.
  for (let i = 1; i < labels.length; i += 1) {
    const tld = labels.slice(i).join('.');
    for (const [tlds, urls] of parsed.data.services) {
      if (!tlds.some((t) => t.toLowerCase() === tld)) continue;
      for (const raw of urls) {
        const url = safeUrl(raw);
        if (!url) continue;
        const base = url.toString();
        return { tld, base: base.endsWith('/') ? base : `${base}/` };
      }
    }
  }
  return null;
}

/** IANA's bootstrap entry for the domain, fetched now. Null when no entry covers it. */
export async function fetchRdapBase(
  apex: string,
  now: Date,
  options?: OutboundOptions,
): Promise<RdapBase | null> {
  const { json } = await outboundJson(
    IANA_BOOTSTRAP,
    { headers: { accept: 'application/json' } },
    options,
  );
  const found = rdapBaseFor(apex, json);
  return found ? { ...found, fetchedAt: now.toISOString() } : null;
}

const EventSchema = z.object({ eventAction: z.string(), eventDate: z.string() });
const EntitySchema = z.object({
  roles: z.array(z.string()).optional().catch(undefined),
  vcardArray: z.unknown().optional(),
});
const DomainSchema = z.object({
  events: z.array(z.unknown()).optional().catch(undefined),
  entities: z.array(z.unknown()).optional().catch(undefined),
});

export type DomainRecord =
  | { outcome: 'ok'; expires: string; registrar: string | null }
  | { outcome: 'not-found' }
  | { outcome: 'unknown'; registrar: string | null };

/** The registrar's display name from a jCard (RFC 7095): ["vcard", [["fn", {}, "text", X]]]. */
function vcardName(vcard: unknown): string | null {
  if (!Array.isArray(vcard) || !Array.isArray(vcard[1])) return null;
  for (const prop of vcard[1] as unknown[]) {
    if (Array.isArray(prop) && prop[0] === 'fn' && typeof prop[3] === 'string') {
      const name = prop[3].trim();
      return name ? name.slice(0, PROBE_CAPS.registrar) : null;
    }
  }
  return null;
}

/** Reads an RDAP domain answer. Exported for the fixture tests. */
export function domainRecordOf(json: unknown): DomainRecord {
  const parsed = DomainSchema.safeParse(json);
  if (!parsed.success) return { outcome: 'unknown', registrar: null };
  let registrar: string | null = null;
  for (const raw of parsed.data.entities ?? []) {
    const entity = EntitySchema.safeParse(raw);
    if (entity.success && entity.data.roles?.includes('registrar')) {
      registrar = vcardName(entity.data.vcardArray);
      if (registrar) break;
    }
  }
  for (const raw of parsed.data.events ?? []) {
    const event = EventSchema.safeParse(raw);
    if (!event.success || event.data.eventAction.toLowerCase() !== 'expiration') continue;
    const at = Date.parse(event.data.eventDate);
    if (Number.isFinite(at))
      return { outcome: 'ok', expires: new Date(at).toISOString(), registrar };
  }
  return { outcome: 'unknown', registrar };
}

/** The domain's registration record from its registry. */
export async function readDomainExpiry(
  apex: string,
  base: string,
  options?: OutboundOptions,
): Promise<DomainRecord> {
  const url = safeUrl(`domain/${encodeURIComponent(apex)}`, base);
  if (!url) throw new OutboundError('bad-url');
  try {
    const { json } = await outboundJson(
      url.toString(),
      { headers: { accept: 'application/rdap+json, application/json' } },
      options,
    );
    return domainRecordOf(json);
  } catch (err) {
    if (err instanceof OutboundError && err.reason === 'http' && err.status === 404) {
      return { outcome: 'not-found' };
    }
    throw err;
  }
}
