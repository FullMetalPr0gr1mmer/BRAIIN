import { describe, it, expect, vi, beforeEach } from 'vitest';
import { consentCookieHeader } from '../e2e/consentCookie';

// POST /api/contact and lead attribution (Admin v2 C13, crm.md §7.3; HELD for O-11): the
// endpoint hands createLead the attribution only with the visitor's analytics consent, read
// through hasConsent from the request, whatever the body says; the landing path comes from the
// request's Referer, never the body; and the attribution never fails a send.

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOST = 'site.example.test';
const calls: { input: Record<string, unknown>; attribution: unknown }[] = [];

vi.mock('@/lib/supabase/server', () => ({
  serviceClient: () => ({
    rpc: async () => ({ data: 1, error: null }),
    from: () => {
      const b: Record<string, unknown> = {
        select: () => b,
        eq: () => b,
        maybeSingle: async () => ({ data: null, error: null }),
      };
      return b;
    },
  }),
}));
vi.mock('@/lib/supabase/client', () => ({ supabaseConfigured: () => true }));
vi.mock('@/lib/data/tenant', () => ({ resolveLaunchTenantId: async () => TENANT }));
vi.mock('@/lib/data/leads', () => ({
  createLead: async (input: Record<string, unknown>, attribution: unknown) => {
    calls.push({ input, attribution });
    return { ok: true };
  },
}));

const { POST } = await import('@/pages/api/contact');

const BASE = { name: 'Sam', email: 'sam@example.test', message: 'Hello there.' };
const TOUCH = { referrerHost: 'www.google.com', utmSource: 'google', utmMedium: 'cpc' };

const send = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  (POST as unknown as (c: { request: Request }) => Promise<Response>)({
    request: new Request(`https://${HOST}/api/contact`, {
      method: 'POST',
      headers: {
        host: HOST,
        origin: `https://${HOST}`,
        referer: `https://${HOST}/services/logo?utm_source=x&email=a%40b.test`,
        'content-type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  });

beforeEach(() => {
  calls.length = 0;
});

describe('POST /api/contact — attribution (C13)', () => {
  it('no consent: nothing is passed on, though the body and the request carry it all', async () => {
    expect((await send({ ...BASE, attribution: TOUCH })).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.attribution).toBeNull();
  });

  it('analytics refused: nothing', async () => {
    await send(
      { ...BASE, attribution: TOUCH },
      { cookie: consentCookieHeader({ analytics: false }) },
    );
    expect(calls[0]!.attribution).toBeNull();
  });

  it('analytics consent: the cleaned columns, the path from the Referer without its query', async () => {
    await send(
      { ...BASE, attribution: TOUCH },
      { cookie: consentCookieHeader({ analytics: true }), 'sec-ch-ua-mobile': '?0' },
    );
    expect(calls[0]!.attribution).toEqual({
      landing_path: '/services/logo',
      referrer_host: 'www.google.com',
      utm_source: 'google',
      utm_medium: 'cpc',
      device_class: 'desktop',
      channel: 'paid',
    });
  });

  it('a body that names a landing path is not believed', async () => {
    await send(
      { ...BASE, landing_path: '/evil', attribution: { ...TOUCH, landingPath: '/evil' } },
      { cookie: consentCookieHeader({ analytics: true }) },
    );
    // The strict object with a key it does not know is dropped whole; the path is the request's.
    expect(calls[0]!.attribution).toEqual({ landing_path: '/services/logo', channel: 'direct' });
  });

  it('an attribution object out of shape never fails the send', async () => {
    const res = await send(
      { ...BASE, attribution: 'utm_source=google' },
      { cookie: consentCookieHeader({ analytics: true }) },
    );
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});
