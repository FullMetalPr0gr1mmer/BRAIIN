import { describe, expect, it, vi } from 'vitest';
import { apexOf } from '@/lib/health/domain';
import {
  IANA_BOOTSTRAP,
  domainRecordOf,
  fetchRdapBase,
  rdapBaseFor,
  readDomainExpiry,
} from '@/lib/health/rdap';

// The domain's renewal from RDAP (Admin v2 G2): the IANA bootstrap's longest TLD match,
// https only; a domain answer's expiration event and registrar; a 404 as "no registration
// found"; no event as unknown; and the apex the probe looks up (www stripped, IDN punycode
// allowed, an IP or an overlong name refused, a Cloudflare address not ours).

// A slice of https://data.iana.org/rdap/dns.json, in its shape (RFC 9224).
const BOOTSTRAP = {
  version: '1.0',
  publication: '2026-10-01T00:00:00Z',
  services: [
    [['com', 'net'], ['https://rdap.verisign.com/com/v1/']],
    [['sa'], ['http://rdap.nic.sa/', 'https://rdap.nic.sa']],
    [['com.sa'], ['https://rdap.example-sld.test/']],
    [['insecure'], ['http://rdap.insecure.test/']],
  ],
};

// A trimmed RDAP domain answer (RFC 9083), as Verisign's registry answers it.
const DOMAIN = {
  objectClassName: 'domain',
  ldhName: 'BRAIINSTATIION.COM',
  events: [
    { eventAction: 'registration', eventDate: '2024-05-01T10:00:00Z' },
    { eventAction: 'expiration', eventDate: '2027-05-01T10:00:00Z' },
    { eventAction: 'last update of RDAP database', eventDate: '2026-10-15T00:00:00Z' },
  ],
  entities: [
    {
      objectClassName: 'entity',
      roles: ['technical'],
      vcardArray: ['vcard', [['fn', {}, 'text', 'Not the registrar']]],
    },
    {
      objectClassName: 'entity',
      roles: ['registrar'],
      vcardArray: [
        'vcard',
        [
          ['version', {}, 'text', '4.0'],
          ['fn', {}, 'text', 'Example Registrar, Inc.'],
        ],
      ],
    },
  ],
};

describe('rdapBaseFor', () => {
  it('finds .com at Verisign', () => {
    expect(rdapBaseFor('braiinstatiion.com', BOOTSTRAP)).toEqual({
      tld: 'com',
      base: 'https://rdap.verisign.com/com/v1/',
    });
  });

  it('takes the longest suffix the bootstrap names, and its first https URL with a slash', () => {
    expect(rdapBaseFor('studio.com.sa', BOOTSTRAP)).toEqual({
      tld: 'com.sa',
      base: 'https://rdap.example-sld.test/',
    });
    expect(rdapBaseFor('studio.sa', BOOTSTRAP)).toEqual({
      tld: 'sa',
      base: 'https://rdap.nic.sa/',
    });
  });

  it('answers null for a TLD it does not cover, an http-only entry, or a body that is not one', () => {
    expect(rdapBaseFor('example.zz', BOOTSTRAP)).toBeNull();
    expect(rdapBaseFor('example.insecure', BOOTSTRAP)).toBeNull();
    expect(rdapBaseFor('example.com', { services: 'nope' })).toBeNull();
    expect(rdapBaseFor('example.com', null)).toBeNull();
  });

  it('fetches the bootstrap from IANA, stamped for the 30-day cache', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(BOOTSTRAP)),
    ) as unknown as typeof fetch;
    const now = new Date('2026-10-15T12:00:00Z');
    expect(await fetchRdapBase('braiinstatiion.com', now, { fetchImpl })).toEqual({
      tld: 'com',
      base: 'https://rdap.verisign.com/com/v1/',
      fetchedAt: '2026-10-15T12:00:00.000Z',
    });
    expect(vi.mocked(fetchImpl).mock.calls[0]![0]).toBe(IANA_BOOTSTRAP);
  });
});

describe('domainRecordOf', () => {
  it('reads the expiration event and the registrar’s name', () => {
    expect(domainRecordOf(DOMAIN)).toEqual({
      outcome: 'ok',
      expires: '2027-05-01T10:00:00.000Z',
      registrar: 'Example Registrar, Inc.',
    });
  });

  it('with no expiration event is unknown, keeping the registrar', () => {
    expect(domainRecordOf({ ...DOMAIN, events: DOMAIN.events.slice(0, 1) })).toEqual({
      outcome: 'unknown',
      registrar: 'Example Registrar, Inc.',
    });
    expect(
      domainRecordOf({ events: [{ eventAction: 'expiration', eventDate: 'not a date' }] }),
    ).toMatchObject({
      outcome: 'unknown',
    });
    expect(domainRecordOf('garbage')).toEqual({ outcome: 'unknown', registrar: null });
  });

  it('cuts a registrar name to 80 characters', () => {
    const long = {
      ...DOMAIN,
      entities: [
        { roles: ['registrar'], vcardArray: ['vcard', [['fn', {}, 'text', 'R'.repeat(300)]]] },
      ],
    };
    expect((domainRecordOf(long) as { registrar: string }).registrar).toHaveLength(80);
  });
});

describe('readDomainExpiry', () => {
  it('asks <base>domain/<apex> for RDAP JSON', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(DOMAIN)),
    ) as unknown as typeof fetch;
    const record = await readDomainExpiry(
      'braiinstatiion.com',
      'https://rdap.verisign.com/com/v1/',
      { fetchImpl },
    );
    expect(record.outcome).toBe('ok');
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('https://rdap.verisign.com/com/v1/domain/braiinstatiion.com');
    expect(init.headers).toEqual({ accept: 'application/rdap+json, application/json' });
    expect(init.method).toBe('GET');
  });

  it('a 404 is "no registration found"; other failures throw', async () => {
    const notFound = vi.fn(
      async () => new Response('{}', { status: 404 }),
    ) as unknown as typeof fetch;
    expect(
      await readDomainExpiry('braiinstation.com', 'https://rdap.verisign.com/com/v1/', {
        fetchImpl: notFound,
      }),
    ).toEqual({
      outcome: 'not-found',
    });
    const limited = vi.fn(
      async () => new Response('{}', { status: 429 }),
    ) as unknown as typeof fetch;
    await expect(
      readDomainExpiry('braiinstatiion.com', 'https://rdap.verisign.com/com/v1/', {
        fetchImpl: limited,
      }),
    ).rejects.toMatchObject({ reason: 'http', status: 429 });
  });
});

describe('apexOf', () => {
  it('lowercases, strips one www. and a trailing dot', () => {
    expect(apexOf('www.BraiinStatiion.com')).toEqual({ kind: 'apex', apex: 'braiinstatiion.com' });
    expect(apexOf('braiinstatiion.com.')).toEqual({ kind: 'apex', apex: 'braiinstatiion.com' });
    expect(apexOf('www.www.example.com')).toEqual({ kind: 'apex', apex: 'www.example.com' });
  });

  it('allows an internationalised name in punycode', () => {
    expect(apexOf('xn--mgbh0fb.xn--mgberp4a5d4ar')).toEqual({
      kind: 'apex',
      apex: 'xn--mgbh0fb.xn--mgberp4a5d4ar',
    });
  });

  it('refuses an IP, a bare word, bad labels and an overlong name', () => {
    for (const host of [
      '192.168.0.1',
      'localhostish',
      'a..com',
      '-a.com',
      'a-.com',
      'ex ample.com',
      'a_b.com',
      `${'a'.repeat(64)}.com`,
      `${'abc.'.repeat(70)}com`,
    ]) {
      expect(apexOf(host).kind, host).toBe('invalid');
    }
  });

  it('a Cloudflare address, localhost or nothing is not ours to renew', () => {
    expect(apexOf('braiin-station.braiin.workers.dev')).toEqual({
      kind: 'not-applicable',
      host: 'braiin-station.braiin.workers.dev',
    });
    expect(apexOf('site.pages.dev').kind).toBe('not-applicable');
    expect(apexOf('localhost').kind).toBe('not-applicable');
    expect(apexOf(null)).toEqual({ kind: 'not-applicable', host: null });
    expect(apexOf('  ')).toEqual({ kind: 'not-applicable', host: null });
  });
});
